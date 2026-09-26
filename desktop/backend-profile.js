// PH3-BE：把后端变成 IDE 工具（Profile / 状态时间线 / API 发现 / 错误进问题模型 / 健康进 Quality）。
//
// 原有 backend-context.js 已有端口推断与健康 URL，backend.js 有 status/health/build/start/stop。
// 这一层补清单 §9 要的几件，且**不改旧层**（渐进）。
//
// 纯逻辑、全依赖注入 —— 可进 CI。

const { PROBLEM_SOURCE, SEVERITY } = require('./problem-model')

/**
 * PH3-BE-06：后端状态机。
 * ⚠️ 与 run-state 的语义一致，但**分开定义** —— 后端的 FAILED 与"进程起不来"不是一回事
 *    （后端可能进程活着但健康检查不过）。
 */
const BACKEND_STATE = Object.freeze({
  STOPPED: 'STOPPED',     // 没在跑
  STARTING: 'STARTING',   // 已拉起进程，还没健康
  RUNNING: 'RUNNING',     // 进程活着且健康检查通过
  DEGRADED: 'DEGRADED',   // 进程活着但健康检查失败（**不能算 RUNNING**）
  FAILED: 'FAILED',       // 起不来 / 中途挂了
})

const ALL_STATES = Object.freeze(Object.values(BACKEND_STATE))

const ALLOWED = Object.freeze({
  [BACKEND_STATE.STOPPED]: [BACKEND_STATE.STARTING, BACKEND_STATE.FAILED],
  [BACKEND_STATE.STARTING]: [BACKEND_STATE.RUNNING, BACKEND_STATE.DEGRADED, BACKEND_STATE.FAILED, BACKEND_STATE.STOPPED],
  [BACKEND_STATE.RUNNING]: [BACKEND_STATE.DEGRADED, BACKEND_STATE.STOPPED, BACKEND_STATE.FAILED],
  [BACKEND_STATE.DEGRADED]: [BACKEND_STATE.RUNNING, BACKEND_STATE.STOPPED, BACKEND_STATE.FAILED],
  [BACKEND_STATE.FAILED]: [BACKEND_STATE.STARTING, BACKEND_STATE.STOPPED],
})

function canTransition(from, to) {
  const outs = ALLOWED[from]
  return Array.isArray(outs) && outs.indexOf(to) >= 0
}

/** 状态时间线（PH3-BE-06）：只记真发生过的迁移，拒掉的也如实记下来。 */
function createTimeline(now) {
  const startedAt = Number.isFinite(now) ? now : 0
  return { current: BACKEND_STATE.STOPPED, entries: [], startedAt }
}

function advance(tl, to, opts = {}) {
  const t = tl || createTimeline()
  const at = Number.isFinite(opts.at) ? opts.at : Date.now()
  if (ALL_STATES.indexOf(to) < 0) {
    return { ok: false, timeline: t, error: '未知状态：' + to }
  }
  if (!canTransition(t.current, to)) {
    // ★ 拒掉的迁移也记一笔 —— 否则事后看不出"当时想改但没改成"
    const entry = { at, from: t.current, to, ok: false, reason: opts.reason || '不允许的迁移' }
    return { ok: false, timeline: Object.assign({}, t, { entries: t.entries.concat([entry]) }), error: entry.reason }
  }
  const entry = { at, from: t.current, to, ok: true, reason: opts.reason || null }
  return { ok: true, timeline: Object.assign({}, t, { current: to, entries: t.entries.concat([entry]) }) }
}

/** 可读时间线（给界面）。 */
function describeTimeline(tl) {
  const t = tl || createTimeline()
  const zh = { STOPPED: '已停止', STARTING: '启动中', RUNNING: '运行中', DEGRADED: '进程在但不健康', FAILED: '失败' }
  return (zh[t.current] || t.current) + '　｜ ' + t.entries.filter((e) => e.ok).length + ' 次迁移'
}

/**
 * PH3-BE-01：后端 Profile —— 把"这个后端是什么"收成一份。
 * ⚠️ 字段取不到就留 null，**不猜**（尤其 port：猜错了会去连别人的服务）。
 */
function createProfile(ctx = {}, extra = {}) {
  const c = ctx || {}
  return Object.freeze({
    root: c.rootDir || null,
    entry: c.entry || null,
    // 端口：只用 ctx 里"能指着说"的值；没有就 null（不猜 8080）
    port: Number.isFinite(c.port) ? c.port : null,
    healthPath: c.healthPath || null,
    kind: c.kind || null,
    host: extra.host || '127.0.0.1',
    db: extra.db || null,
    redis: extra.redis || null,
    openapi: extra.openapi || null,
  })
}

/** Profile 能不能拿去连 —— 缺关键项就说缺，不硬试。 */
function profileReadiness(profile) {
  const missing = []
  if (!profile || !profile.port) missing.push('port')
  if (!profile || !profile.root) missing.push('root')
  return {
    ok: missing.length === 0,
    missing,
    reason: missing.length ? ('Profile 缺 ' + missing.join('/') + '，不能发起健康检查') : '可以发起健康检查',
  }
}

// ── PH3-BE-07/08：API 发现（读 OpenAPI）────────────────────────────────────────

/**
 * 从 OpenAPI 3 / Swagger 2 文本里抽出端点清单。
 *
 * ⚠️ 只认**真实结构**（paths + 方法），不做"看到 /v1 就当端点"的猜测。
 *    这是"自动加载 API Debug"的地基（PH3-BE-08）——列错了比不列更糟。
 */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

function discoverApis(spec) {
  let doc = spec
  if (typeof spec === 'string') {
    try { doc = JSON.parse(spec) } catch (e) {
      return { ok: false, error: '不是合法 JSON：' + String((e && e.message) || e), endpoints: [] }
    }
  }
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') {
    return { ok: false, error: '没有 paths（不是 OpenAPI/Swagger 文档？）', endpoints: [] }
  }
  const isSwagger2 = String(doc.swagger || '').startsWith('2')
  const base = isSwagger2 ? (doc.basePath || '') : ''
  const endpoints = []
  for (const [p, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== 'object') continue
    for (const [method, op] of Object.entries(item)) {
      if (HTTP_METHODS.indexOf(String(method).toLowerCase()) < 0) continue
      endpoints.push({
        method: String(method).toUpperCase(),
        path: String(base || '') + String(p),
        // 摘要只取 description/summary/operationId，取不到就 null（不编）
        summary: (op && (op.summary || op.description || op.operationId)) || null,
        tags: (op && Array.isArray(op.tags)) ? op.tags.slice() : [],
        // 该端点是否声明了安全要求（用于提示"这个要鉴权"）
        secured: !!(op && op.security && op.security.length),
      })
    }
  }
  endpoints.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
  return {
    ok: true, endpoints,
    version: isSwagger2 ? 'swagger2' : (doc.openapi ? String(doc.openapi) : 'unknown'),
    title: (doc.info && doc.info.title) || null,
    count: endpoints.length,
  }
}

/** 生成可直接用于 API Debug 的请求模板（PH3-BE-08：自动加载）。 */
function toDebugRequests(discovered, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const list = (discovered && discovered.endpoints) || []
  return list.map((e) => ({
    method: e.method,
    url: base ? (base + e.path) : e.path,
    name: e.method + ' ' + e.path + (e.summary ? '　' + String(e.summary).slice(0, 40) : ''),
    secured: e.secured,
  }))
}

// ── PH3-BE-09/10/11：错误 → Problem；健康 → Quality ────────────────────────────

/** 后端日志里常见的错误行（只认能指着说的形状，不猜）。 */
const LOG_ERROR_RE = /(^\s*at\s)|(\bError\b|\bpanic\b|\bFATAL\b|\bException\b)|(\bECONNREFUSED\b|\bEADDRINUSE\b)/

/**
 * PH3-BE-09：把后端日志里的错误**并入统一问题模型**（这样问题面板直接能看到）。
 * ⚠️ 行号尽量从 `file:line` 里取；取不到就 null —— 不编一个行号。
 */
function errorsToProblems(logText, opts = {}) {
  const lines = String(logText == null ? '' : logText).split(/\r?\n/)
  const out = []
  for (const line of lines) {
    if (!line || !LOG_ERROR_RE.test(line)) continue
    const m = /([^\s()]+\.(?:mbt|js|ts|py|go|rs|java))(?::(\d+))?/.exec(line)
    out.push({
      source: PROBLEM_SOURCE.RUNTIME,
      severity: /\bFATAL\b|\bpanic\b/.test(line) ? SEVERITY.ERROR : SEVERITY.WARNING,
      message: line.trim().slice(0, 300),
      file: m ? m[1] : null,
      line: m && m[2] ? Number(m[2]) : null,
      column: null,
      backend: true,
      from: opts.from || 'backend-log',
    })
    if (out.length >= (Number.isFinite(opts.max) ? opts.max : 50)) break
  }
  return out
}

/**
 * PH3-BE-11：健康报告 → Quality 条目。
 * ⚠️ 三态要分清：健康 / 不健康 / **没探测**（不是"不健康"）。
 *    "连不上"与"没去连"在 Quality 上是两回事。
 */
function healthToQuality(report, opts = {}) {
  const name = opts.name || '后端健康'
  const r = report || {}
  if (r.ok === true) {
    return {
      name, state: 'PASS', source: 'desktopVerify',
      detail: '健康检查通过（' + r.url + '，' + (r.latencyMs == null ? '?' : r.latencyMs + 'ms') + '）',
      passed: 1, failed: 0, file: null,
    }
  }
  const probed = r.url != null || r.probed === true
  if (!probed) {
    return { name, state: 'NOT_RUN', source: 'desktopVerify', detail: '没有发起健康检查（不是"不健康"）', passed: 0, failed: 0, file: null }
  }
  return {
    name, state: 'FAIL', source: 'desktopVerify',
    detail: '健康检查失败：' + String(r.error || r.url || '未知原因').slice(0, 200),
    passed: 0, failed: 1, file: null,
  }
}

module.exports = {
  BACKEND_STATE, ALL_STATES, ALLOWED, HTTP_METHODS, LOG_ERROR_RE,
  canTransition, createTimeline, advance, describeTimeline,
  createProfile, profileReadiness,
  discoverApis, toDebugRequests,
  errorsToProblems, healthToQuality,
}
