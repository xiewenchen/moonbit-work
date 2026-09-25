'use strict'

/**
 * BackendProjectContext（Phase 2.1 / P14-01）
 *
 * 在 ProjectContext 之上，补上"后端这件事的状态"：
 *
 *   backend   这个项目算不算后端服务（依据是事实，不是猜）
 *   port      端口 —— **只从能指着说的来源推**，推不出就是 null
 *   health    健康检查结果（{ ok, status, url, checkedAt, latencyMs }）
 *   database  PostgreSQL 状态（复用 backend:deps 的结果）
 *   redis     Redis 状态
 *
 * 刻意**不**在这里做任何"探测"动作 —— 探测由调用方（主进程）执行，
 * 这里只负责把事实组装成一份可断言的结构。所以它是纯逻辑、可进 CI。
 */

const BACKEND_PORT_HINTS = Object.freeze([8123, 8124, 8080, 8090, 3000, 1337])

/** 从命令字符串里抽端口：`--port 8080` / `-p 8080` / `:8080` */
function extractPortFromCommand(cmd) {
  const s = String(cmd == null ? '' : cmd)
  // 只认显式的端口参数（`--port 8080` / `-p 3000`）。
  // ⚠️ 不把 `:` 当端口：`127.0.0.1:8123` 与 `12:30` 长得太像，硬抽会把时间也当端口。
  //    要拼 URL 用 healthUrl() —— 那是从**已知端口**构造，不是从文本猜。
  const m = /(?:--port|-p)\s*(\d{2,5})\b/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

/**
 * 判断"这个项目像不像一个后端服务"。依据只有两条（都是能指出来的）：
 *   ① 项目类型是后端类（moonbit / node / python / java / go / rust）；
 *   ② 有 run 命令，或命令里带了端口。
 * 不满足就说 false —— 宁可说不像，也不要让 UI 对纯库项目显示"一键启动"。
 */
function isBackendLike(projectContext) {
  const c = projectContext || {}
  if (!c.rootDir) return false
  const t = String(c.projectType || '')
  const backendish = ['moonbit', 'node', 'python', 'java', 'go', 'rust'].indexOf(t) >= 0
  if (!backendish) return false
  return !!(c.runCommand || extractPortFromCommand(c.runCommand))
}

/**
 * 端口：优先用显式传入的，其次从 run/build 命令里抽，最后用类型约定兜底。
 * **每一步都记来源**（`portSource`），这样界面上"为什么是 8080"是能回答的。
 */
function inferPort(projectContext, opts = {}) {
  if (Number.isInteger(opts.port) && opts.port > 0) return { port: opts.port, source: 'explicit' }
  const c = projectContext || {}
  const fromRun = extractPortFromCommand(c.runCommand)
  if (fromRun) return { port: fromRun, source: 'runCommand' }
  const fromBuild = extractPortFromCommand(c.buildCommand)
  if (fromBuild) return { port: fromBuild, source: 'buildCommand' }
  if (opts.defaultPort) return { port: opts.defaultPort, source: 'default' }
  return { port: null, source: 'unknown' }
}

/**
 * @param {object} projectContext ProjectContext（P2）
 * @param {object} [extras] { port, health, database, redis, deps }
 */
function createBackendContext(projectContext, extras = {}) {
  const pc = projectContext || {}
  const inferred = inferPort(pc, extras)
  return Object.freeze({
    // ── 归属 ──
    rootDir: pc.rootDir || null,
    projectType: pc.projectType || null,
    backendLike: isBackendLike(pc),
    // ── 端口 ──
    port: inferred.port,
    portSource: inferred.source,
    // ── 健康检查（探测结果；没探过就是 null，不假装 ok）──
    health: normalizeHealth(extras.health),
    // ── 依赖服务 ──
    database: normalizeService(extras.database || (extras.deps && extras.deps.pg ? { ok: true } : null), 'postgresql'),
    redis: normalizeService(extras.redis || (extras.deps && extras.deps.redis ? { ok: true } : null), 'redis'),
    // ── 其它已就位的能力（给 UI/Agent 一个总览）──
    commands: Object.freeze({
      build: pc.buildCommand || null,
      run: pc.runCommand || null,
      test: pc.testCommand || null,
    }),
    checkedAt: Number.isFinite(extras.now) ? extras.now : Date.now(),
  })
}

function normalizeHealth(h) {
  if (!h || typeof h !== 'object') return null          // 没探过 → null（**不假定健康**）
  return Object.freeze({
    ok: h.ok === true,
    status: Number.isFinite(h.status) ? h.status : null,
    url: h.url ? String(h.url) : null,
    latencyMs: Number.isFinite(h.latencyMs) ? h.latencyMs : null,
    error: h.error ? String(h.error).slice(0, 200) : null,
    checkedAt: Number.isFinite(h.checkedAt) ? h.checkedAt : null,
  })
}

function normalizeService(s, kind) {
  if (!s || typeof s !== 'object') return null
  return Object.freeze({ kind, ok: s.ok === true, note: s.note ? String(s.note).slice(0, 120) : null })
}

/** 健康检查的 URL（有端口才拼得出来）*/
function healthUrl(ctx, path = '/health') {
  if (!ctx || !ctx.port) return null
  return 'http://127.0.0.1:' + ctx.port + (String(path).startsWith('/') ? path : '/' + path)
}

/** 一行摘要（界面/日志用）*/
function describeBackendContext(ctx) {
  if (!ctx) return '（无后端上下文）'
  const h = ctx.health
  const health = !h ? '未探活' : (h.ok ? '健康' + (h.latencyMs != null ? '(' + h.latencyMs + 'ms)' : '') : '不健康')
  const db = ctx.database ? (ctx.database.ok ? 'pg✓' : 'pg✗') : 'pg未检'
  const rd = ctx.redis ? (ctx.redis.ok ? 'redis✓' : 'redis✗') : 'redis未检'
  return '后端：' + (ctx.backendLike ? '是' : '否')
    + ' ｜ 端口=' + (ctx.port == null ? '未知' : ctx.port + '(' + ctx.portSource + ')')
    + ' ｜ ' + health + ' ｜ ' + db + ' ｜ ' + rd
}

module.exports = {
  BACKEND_PORT_HINTS,
  extractPortFromCommand,
  isBackendLike,
  inferPort,
  createBackendContext,
  healthUrl,
  describeBackendContext,
}
