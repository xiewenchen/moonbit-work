'use strict'

/**
 * Problem Model（Phase 2 / MBW-P4-01 ～ P4-09、P4-11、P4-12）
 *
 * 目的（清单 Gate P4）：**五类问题统一到一处** —— LSP / 编译 / 运行时 / 测试 / Agent，
 * 而不是像现在这样「诊断走 lastDiags、运行时走 runtimeLocs、各自渲染各的」。
 *
 * 本文件是**纯逻辑**：不 require electron、不碰 DOM。文本解析只做能可靠做的事
 * （编译输出复用已有的 lsp-parse），其余适配器接受**结构化输入** —— 避免写一堆脆弱的正则。
 *
 * 本批只建模型与 Store；把它接到问题面板 / 编辑器高亮属下一批（RULE-04）。
 */

// 解析器的取用延后到调用时：Node 走 require，浏览器走全局
// （双环境导出见 lsp-parse.js；这里不能在模块顶层 require，否则浏览器里直接报错）
function getParseDiagnostics() {
  if (typeof window !== 'undefined') {
    return (window.MoonbitLspParse && window.MoonbitLspParse.parseDiagnostics) || null
  }
  return require('./lsp-parse').parseDiagnostics
}

// ── P4-02 严重度 ──────────────────────────────────────────────────────────────
const SEVERITY = Object.freeze({ ERROR: 'error', WARNING: 'warning', INFO: 'info' })
const SEVERITY_ORDER = Object.freeze({ error: 0, warning: 1, info: 2 })
const ALL_SEVERITIES = Object.freeze([SEVERITY.ERROR, SEVERITY.WARNING, SEVERITY.INFO])

// ── P4-01 来源 ────────────────────────────────────────────────────────────────
const PROBLEM_SOURCE = Object.freeze({
  LSP: 'lsp',
  COMPILER: 'compiler',
  RUNTIME: 'runtime',
  TEST: 'test',
  API: 'api',
  AGENT: 'agent',
})
const ALL_SOURCES = Object.freeze(Object.values(PROBLEM_SOURCE))

// ── P4-12 生命周期 ────────────────────────────────────────────────────────────
const PROBLEM_LIFECYCLE = Object.freeze({ OPEN: 'open', FIXED: 'fixed', IGNORED: 'ignored' })
const ALL_LIFECYCLES = Object.freeze(Object.values(PROBLEM_LIFECYCLE))

function normalizeSeverity(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase()
  return ALL_SEVERITIES.includes(v) ? v : SEVERITY.ERROR
}
function normalizeSource(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase()
  return ALL_SOURCES.includes(v) ? v : PROBLEM_SOURCE.LSP
}
function normalizeLifecycle(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase()
  return ALL_LIFECYCLES.includes(v) ? v : PROBLEM_LIFECYCLE.OPEN
}
function toPosInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : fallback
}

/**
 * P4-11 去重指纹：同一来源 + 同一位置 + 同一严重度 + 同一 code + 同一消息（前 120 字）
 * → 视为**同一条**问题。Store 用指纹当 id，于是"相同错误出现 100 次"天然合成 1 条。
 */
function fingerprint(p) {
  return [
    p.source,
    p.file == null ? '' : p.file,
    p.line,
    p.column,
    p.severity,
    p.code == null ? '' : p.code,
    String(p.message || '').slice(0, 120),
  ].join('|')
}

/** P4-01 定义一个 Problem（字段一律归一；未给 id 就用指纹）*/
function createProblem(input = {}) {
  const p = {
    source: normalizeSource(input.source),
    severity: normalizeSeverity(input.severity),
    message: String(input.message == null ? '' : input.message).trim(),
    file: input.file == null || input.file === '' ? null : String(input.file),
    line: toPosInt(input.line, 1),
    column: toPosInt(input.column != null ? input.column : input.col, 1),
    code: input.code == null || input.code === '' ? null : String(input.code),
    timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
    lifecycle: normalizeLifecycle(input.lifecycle),
  }
  p.id = typeof input.id === 'string' && input.id ? input.id : fingerprint(p)
  return p
}

// ── 各来源的适配器（P4-03 ～ P4-08）──────────────────────────────────────────
/** P4-03 LSP 诊断 → Problem（形状与 lsp-parse 的输出一致：{file,line,col,severity,code,message}）*/
function fromLspDiagnostics(diags, opts = {}) {
  const source = opts.source || PROBLEM_SOURCE.LSP
  return (Array.isArray(diags) ? diags : []).map((d) => createProblem({
    source,
    severity: d.severity,
    message: d.message,
    file: d.file,
    line: d.line,
    column: d.col != null ? d.col : d.column,
    code: d.code,
    timestamp: opts.timestamp,
  }))
}

/** P4-04 编译器输出（`moon check` 文本）→ Problem —— 复用已有的解析器，不重写正则 */
function fromCompilerOutput(text, opts = {}) {
  const parse = getParseDiagnostics()
  if (typeof parse !== 'function') return []   // 浏览器里没加载 lsp-parse 时不报错，只是解析不出来
  return fromLspDiagnostics(parse(text), Object.assign({ source: PROBLEM_SOURCE.COMPILER }, opts))
}

/** P4-05 运行时位置 → Problem（接受 renderer 已经解析好的 {file,line,col}，不重复解析）*/
function fromRuntimeLocs(locs, opts = {}) {
  const source = opts.source || PROBLEM_SOURCE.RUNTIME
  return (Array.isArray(locs) ? locs : []).map((l) => createProblem({
    source,
    severity: opts.severity || SEVERITY.ERROR,
    message: opts.message || '运行时错误（堆栈指向这里）',
    file: l.file,
    line: l.line,
    column: l.col != null ? l.col : l.column,
    code: opts.code,
    timestamp: opts.timestamp,
  }))
}

/** P4-06 测试结果 → Problem（结构化输入：{name, ok, message, file, line}）*/
function fromTestResult(result = {}, opts = {}) {
  const out = []
  const items = Array.isArray(result) ? result : [result]
  for (const t of items) {
    if (!t || t.ok === true) continue          // 通过的用例不产生问题
    out.push(createProblem({
      source: opts.source || PROBLEM_SOURCE.TEST,
      severity: t.severity || SEVERITY.ERROR,
      message: t.message || (t.name ? '测试失败：' + t.name : '测试失败'),
      file: t.file,
      line: t.line,
      column: t.col != null ? t.col : t.column,
      code: t.code || t.name,
      timestamp: opts.timestamp,
    }))
  }
  return out
}

/** P4-07 API 调用结果 → Problem（结构化输入：{method,url,status,error,ok}）*/
function fromApiResult(result = {}, opts = {}) {
  if (!result || result.ok === true) return []
  const where = [result.method, result.url].filter(Boolean).join(' ')
  const detail = result.error
    ? String(result.error)
    : (typeof result.status === 'number' ? 'HTTP ' + result.status : '请求失败')
  return [createProblem({
    source: opts.source || PROBLEM_SOURCE.API,
    severity: result.status >= 500 ? SEVERITY.ERROR : SEVERITY.WARNING,
    message: (where ? where + ' → ' : '') + detail,
    file: result.file,
    line: result.line,
    code: result.status != null ? String(result.status) : null,
    timestamp: opts.timestamp,
  })]
}

/** P4-08 Agent 发现 → Problem（结构化输入）*/
function fromAgentFinding(finding = {}, opts = {}) {
  const items = Array.isArray(finding) ? finding : [finding]
  return items
    .filter((f) => f && f.message)
    .map((f) => createProblem({
      source: opts.source || PROBLEM_SOURCE.AGENT,
      severity: f.severity || SEVERITY.WARNING,
      message: f.message,
      file: f.file,
      line: f.line,
      column: f.column,
      code: f.code,
      timestamp: opts.timestamp,
    }))
}

// ── P4-09 Problems Store ──────────────────────────────────────────────────────
/**
 * 统一保存 current（当前问题）+ history（已修复/已忽略）。
 * 用 Map 按指纹索引 —— **去重是结构性的**（P4-11），不需要额外逻辑。
 */
function createProblemStore({ limit = 2000, historyLimit = 500 } = {}) {
  const current = new Map()
  const history = []

  function pushHistory(p) {
    history.push(p)
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit)
  }

  /** 超过上限时丢掉「最旧的」——按 timestamp，不是按插入顺序 */
  function trim() {
    while (current.size > limit) {
      let oldest = null
      for (const p of current.values()) {
        if (!oldest || p.timestamp < oldest.timestamp) oldest = p
      }
      if (!oldest) break
      current.delete(oldest.id)
      pushHistory(Object.assign({}, oldest, { lifecycle: PROBLEM_LIFECYCLE.FIXED, evicted: true }))
    }
  }

  function addOne(input) {
    const p = input && input.id && input.lifecycle ? input : createProblem(input)
    const prev = current.get(p.id)
    // 同一问题再次出现：**保留首次时间** —— "这个问题从什么时候开始存在"才有意义，
    // 否则上限淘汰（按 timestamp）会把老问题当成新问题。
    if (prev) p.timestamp = prev.timestamp
    current.set(p.id, p)
    return p
  }

  /** 追加（不同来源可混着加）*/
  function add(items) {
    const arr = Array.isArray(items) ? items : [items]
    for (const it of arr) if (it) addOne(it)
    trim()
    return arr.length
  }

  /**
   * **按来源整体替换**：该来源上一轮的 OPEN 问题若这轮没再出现，就判为 FIXED 并移入 history。
   * 这是"重新跑一次 check 后旧错误自动消失"的正确语义 —— 若只追加不替换，面板会越积越多。
   */
  function replaceSource(source, items) {
    const src = normalizeSource(source)
    const arr = (Array.isArray(items) ? items : [items])
      .filter(Boolean)
      .map((it) => (it && it.id && it.lifecycle ? it : createProblem(it)))
    const nextIds = new Set(arr.map((p) => p.id))
    // ① 只把「新一批里**不再出现**」的标 FIXED —— 不能把还会出现的也标掉，
    //    否则 history 会被"其实没消失"的条目污染（实测踩到）。
    for (const [id, p] of Array.from(current)) {
      if (p.source === src && p.lifecycle === PROBLEM_LIFECYCLE.OPEN && !nextIds.has(id)) {
        current.delete(id)
        pushHistory(Object.assign({}, p, { lifecycle: PROBLEM_LIFECYCLE.FIXED, fixedAt: Date.now() }))
      }
    }
    // ② 再把这一批写进去（相同 id 会在 addOne 里保留首次时间）
    for (const p of arr) addOne(p)
    trim()
    return list({ source: src }).length
  }

  /** 查询（默认只给 OPEN；可按来源/严重度/文件过滤），按严重度再按位置排序 */
  function list(filter = {}) {
    const lifecycle = filter.lifecycle === undefined ? PROBLEM_LIFECYCLE.OPEN : filter.lifecycle
    let out = Array.from(current.values())
    if (lifecycle !== null) out = out.filter((p) => p.lifecycle === lifecycle)
    if (filter.source) out = out.filter((p) => p.source === filter.source)
    if (filter.severity) out = out.filter((p) => p.severity === filter.severity)
    if (filter.file) out = out.filter((p) => p.file === filter.file)
    out.sort((a, b) => {
      const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
      if (s !== 0) return s
      if ((a.file || '') !== (b.file || '')) return (a.file || '') < (b.file || '') ? -1 : 1
      return a.line - b.line || a.column - b.column
    })
    return out
  }

  function get(id) { return current.get(id) || null }

  /** P4-12 生命周期流转：OPEN → FIXED / IGNORED（移出 current，保留到 history）*/
  function mark(id, lifecycle) {
    const p = current.get(id)
    if (!p) return null
    const next = Object.assign({}, p, { lifecycle: normalizeLifecycle(lifecycle), markedAt: Date.now() })
    current.delete(id)
    pushHistory(next)
    return next
  }

  function clear(source) {
    if (source) {
      for (const [id, p] of Array.from(current)) if (p.source === normalizeSource(source)) current.delete(id)
    } else {
      current.clear()
    }
    return current.size
  }

  function stats() {
    const bySeverity = { error: 0, warning: 0, info: 0 }
    const bySource = {}
    for (const p of current.values()) {
      bySeverity[p.severity] = (bySeverity[p.severity] || 0) + 1
      bySource[p.source] = (bySource[p.source] || 0) + 1
    }
    return { total: current.size, bySeverity, bySource, history: history.length }
  }

  return {
    add,
    replaceSource,
    list,
    get,
    fix: (id) => mark(id, PROBLEM_LIFECYCLE.FIXED),
    ignore: (id) => mark(id, PROBLEM_LIFECYCLE.IGNORED),
    clear,
    stats,
    history: () => history.slice(),
    size: () => current.size,
  }
}

// 导出用 IIFE 包起来（同 lsp-parse.js）：浏览器全局作用域里不能裸写 `const API`。
;(function () {
  const API = {
    SEVERITY,
    SEVERITY_ORDER,
    ALL_SEVERITIES,
    PROBLEM_SOURCE,
    ALL_SOURCES,
    PROBLEM_LIFECYCLE,
    ALL_LIFECYCLES,
    normalizeSeverity,
    normalizeSource,
    normalizeLifecycle,
    fingerprint,
    createProblem,
    fromLspDiagnostics,
    fromCompilerOutput,
    fromRuntimeLocs,
    fromTestResult,
    fromApiResult,
    fromAgentFinding,
    createProblemStore,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.MoonbitProblems = API
})()
