'use strict'

/**
 * AI Provider Center（Phase 2 / MBW-P12-01 ～ P12-11）
 *
 * 清单里反复强调三件"不许出事"的事，所以它们是**代码保证**而不是文档约定：
 *   P12-07 界面上只显示脱敏 Key（`sk-****1234`）；
 *   P12-08 Key **不进日志**；P12-09 Key **不进项目目录**（只写用户全局配置）。
 * 于是本模块提供 `maskKey` / `redactProvider` / `redactForLog`，
 * 并且有一条断言：**脱敏后的序列化结果里不含完整 Key**（含深层嵌套）。
 *
 * 纯逻辑：HTTP 探测由调用方注入 —— 所以"连通性检查"和"Key 不外泄"都能纯 Node 测。
 */

const PROVIDER_TYPE = Object.freeze({
  OPENAI: 'openai',
  DEEPSEEK: 'deepseek',
  OLLAMA: 'ollama',
  CUSTOM: 'custom',
})
const ALL_TYPES = Object.freeze(Object.values(PROVIDER_TYPE))

/** P12-02 ～ P12-05 四种预设 */
const PROVIDER_PRESETS = Object.freeze({
  [PROVIDER_TYPE.OPENAI]: { label: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  [PROVIDER_TYPE.DEEPSEEK]: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
  [PROVIDER_TYPE.OLLAMA]: { label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needsKey: false },
  [PROVIDER_TYPE.CUSTOM]: { label: '自定义 Endpoint', baseUrl: '', model: '', needsKey: false },
})

// ── P12-07 Key 脱敏 ───────────────────────────────────────────────────────────
/**
 * `sk-abcdef…1234` → `sk-****1234`
 * 只保留**出名的** `sk-` 前缀与后 4 位；短于 12 位一律 `****`（短 Key 露头露尾等于没脱敏）。
 */
function maskKey(key) {
  const s = String(key == null ? '' : key)
  if (!s) return ''
  if (s.length < 12) return '****'
  const prefix = /^sk-[A-Za-z0-9_-]{0,3}/.test(s) ? 'sk-' : ''
  return prefix + '****' + s.slice(-4)
}

/** 返回 provider 的**脱敏副本**（Key 只剩 mask；其余原样）*/
function redactProvider(p) {
  if (!p || typeof p !== 'object') return null
  return Object.assign({}, p, { apiKey: maskKey(p.apiKey), hasKey: !!p.apiKey })
}

/** 深度脱敏：任何键名像 Key/secret/token 的字段都换掉（用于日志与错误上报）*/
const SECRET_KEY_RE = /(api[_-]?key|apikey|secret|token|password|authorization)/i
/**
 * 字符串里"看起来像 Key"的片段也要遮 ——
 * 因为**最危险的泄漏路径就是错误信息**（有的服务把 Key 回显在错误体里）。
 * 只认出名的两种格式（`sk-…` 与 `Bearer …`），避免误伤正常文本（如文件路径）。
 */
const KEY_LIKE_RE = /\b(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,})/g
function redactText(s) {
  return String(s).replace(KEY_LIKE_RE, (m) => maskKey(m))
}
function redactForLog(value, depth = 0) {
  if (depth > 6) return '…'
  if (value == null) return value
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? maskKey(v) : redactForLog(v, depth + 1)
    }
    return out
  }
  return value
}

/** 日志行：**只允许**经过这里 */
function logSafe(entry) {
  return redactForLog(entry)
}

// ── P12-01 Schema ─────────────────────────────────────────────────────────────
function normalizeType(t) {
  const v = String(t == null ? '' : t).trim().toLowerCase()
  return ALL_TYPES.includes(v) ? v : PROVIDER_TYPE.CUSTOM
}

/**
 * @param {object} input name/type/baseUrl/model/apiKey/enabled
 */
function createProvider(input = {}) {
  const type = normalizeType(input.type)
  const preset = PROVIDER_PRESETS[type] || PROVIDER_PRESETS[PROVIDER_TYPE.CUSTOM]
  const baseUrl = String(input.baseUrl == null ? preset.baseUrl : input.baseUrl).trim()
  return {
    name: String(input.name == null ? '' : input.name).trim(),
    type,
    baseUrl: baseUrl.replace(/\/+$/, ''),        // 去掉尾部斜杠，拼端点时不会出现 //
    model: String(input.model == null ? preset.model : input.model).trim(),
    apiKey: input.apiKey == null ? '' : String(input.apiKey),
    enabled: input.enabled !== false,
  }
}

/** 校验：给出**可读的**错误列表（而不是一个 false）*/
function validateProvider(p) {
  const errors = []
  if (!p || typeof p !== 'object') return { ok: false, errors: ['provider 必须是对象'] }
  if (!p.name) errors.push('缺少 name')
  if (!p.baseUrl) errors.push('缺少 baseUrl')
  if (p.baseUrl && !/^https?:\/\//i.test(p.baseUrl)) errors.push('baseUrl 必须以 http:// 或 https:// 开头')
  const preset = PROVIDER_PRESETS[p.type]
  if (!preset) errors.push('未知 type：' + p.type)
  // 需要 Key 的类型（openai / deepseek）必须给 Key；Ollama 与自定义不强制
  if (preset && preset.needsKey && !p.apiKey) errors.push('该类型需要 apiKey')
  return { ok: errors.length === 0, errors }
}

// ── P12-06 Test Connection ────────────────────────────────────────────────────
/** 探测用的端点：OpenAI 兼容都支持 `/models` */
function probeUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '') + '/models'
}

/**
 * @param {object} deps { request: ({url, headers, timeoutMs}) => {ok, status, body, error}, now }
 * @returns {{ok, latency, model, status, error}}
 */
async function testConnection(provider, deps = {}) {
  const p = createProvider(provider)
  const v = validateProvider(p)
  if (!v.ok) return { ok: false, latency: null, model: null, status: null, error: v.errors.join('；') }
  if (typeof deps.request !== 'function') return { ok: false, latency: null, model: null, status: null, error: 'request 能力未注入' }

  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const t0 = now()
  const headers = {}
  if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey      // Key 只在这一刻出现，不写日志
  let r
  try {
    r = await deps.request({ url: probeUrl(p.baseUrl), method: 'GET', headers, timeoutMs: 10000 })
  } catch (e) {
    return { ok: false, latency: now() - t0, model: null, status: null, error: String((e && e.message) || e) }
  }
  const latency = now() - t0
  const ok = !!(r && r.ok)
  return {
    ok,
    latency,
    model: ok ? (p.model || null) : null,
    status: (r && r.status) || null,
    // ⚠️ 错误信息也过一遍脱敏 —— 有的服务会把 Key 回显在错误里
    error: ok ? null : String(maskKey(String((r && (r.error || r.body)) || '连接失败'))),
  }
}

// ── P12-10 全局配置与项目配置分离 ─────────────────────────────────────────────
/**
 * 合并规则：**同名的项目级 provider 覆盖全局级**（项目更具体）；
 * 顺序上全局在前、项目在后，便于界面按优先级展示。
 */
function mergeProviders(globalList, projectList) {
  const out = []
  const seen = new Map()
  for (const p of (Array.isArray(globalList) ? globalList : [])) {
    const item = createProvider(p)
    if (!item.name) continue
    seen.set(item.name, out.length)
    out.push(Object.assign({}, item, { scope: 'global' }))
  }
  for (const p of (Array.isArray(projectList) ? projectList : [])) {
    const item = createProvider(p)
    if (!item.name) continue
    if (seen.has(item.name)) {
      out[seen.get(item.name)] = Object.assign({}, item, { scope: 'project' })
    } else {
      seen.set(item.name, out.length)
      out.push(Object.assign({}, item, { scope: 'project' }))
    }
  }
  return out
}

/** 给界面用的清单（**全部脱敏**）*/
function listForUi(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => redactProvider(createProvider(p)))
    .filter(Boolean)
}

module.exports = {
  PROVIDER_TYPE,
  ALL_TYPES,
  PROVIDER_PRESETS,
  SECRET_KEY_RE,
  maskKey,
  redactProvider,
  redactForLog,
  logSafe,
  normalizeType,
  createProvider,
  validateProvider,
  probeUrl,
  testConnection,
  mergeProviders,
  listForUi,
}
