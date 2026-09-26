// PH3-DB：数据库工作流 —— 连接状态 / 表结构缓存 / Schema 进 Agent / 查询历史 / SELECT 草案（**必须过闸**）。
//
// 原有 sql-guard（analyzeSql / withRowLimit / analyzeRedisCommand）与 db-explorer
// （sqlListTables / sqlColumns / sqlSelect / sqlSearch）保持不变 —— 新层在上面搭。
//
// ⚠️ 这一层最要紧的一条是 PH3-DB-08：
//    **即使是 Agent 自己生成的 SQL，也要过同一道闸**。
//    "自己生成的"不是豁免理由 —— 模型可能生成 DELETE，也可能被提示词注入带偏。
//    所以 executeDraft 的第一件事就是 analyzeSql，过不了根本不执行。
//
// 纯逻辑、全依赖注入 —— 可进 CI。

const { analyzeSql, withRowLimit, SQL_LIMITS } = require('./sql-guard')

/** PH3-DB-01：连接状态四态。 */
const DB_CONN = Object.freeze({
  CONNECTED: 'CONNECTED',     // 连上了
  NO_CLIENT: 'NO_CLIENT',     // 本机没装客户端（**不是"连不上"**）
  AUTH_FAILED: 'AUTH_FAILED', // 客户端在，但认证失败
  ERROR: 'ERROR',             // 其它错误
  UNKNOWN: 'UNKNOWN',         // 还没试过（**不是 ERROR**）
})
const ALL_CONN = Object.freeze(Object.values(DB_CONN))

/**
 * 从客户端输出判断连接状态。
 * ⚠️ 四态必须分清，否则界面会把"没装客户端"说成"数据库挂了"。
 */
function classifyConn(out, opts = {}) {
  const s = String(out == null ? '' : out)
  if (opts.attempted !== true) return { state: DB_CONN.UNKNOWN, reason: '还没有发起连接' }
  if (/未找到\s*(psql|redis-cli)|not found|command not found|无法将.*识别为/i.test(s)) {
    return { state: DB_CONN.NO_CLIENT, reason: '本机没有数据库客户端（不是连接失败）' }
  }
  if (/authentication|password authentication failed|认证失败|Access denied|NOAUTH|WRONGPASS/i.test(s)) {
    return { state: DB_CONN.AUTH_FAILED, reason: '客户端在，但认证没通过' }
  }
  if (/^(SELECT|INSERT|UPDATE|DELETE|PG|OK|PONG)|\d+\s+rows?|\|\s*$/im.test(s)) {
    return { state: DB_CONN.CONNECTED, reason: '查询有返回' }
  }
  return { state: DB_CONN.ERROR, reason: '有输出但不像是成功（按错误处理）' }
}

function describeConn(c) {
  const zh = {
    CONNECTED: '已连接', NO_CLIENT: '未装客户端', AUTH_FAILED: '认证失败',
    ERROR: '出错', UNKNOWN: '还没连过',
  }
  const v = c || { state: DB_CONN.UNKNOWN }
  return (zh[v.state] || v.state) + (v.reason ? '（' + v.reason + '）' : '')
}

// ── PH3-DB-02/03：表结构缓存与"Schema 进 Agent" ────────────────────────────────

/**
 * 表结构缓存（PH3-DB-02）。
 * ⚠️ 缓存必须能被**显式作废**：数据库 schema 会变，"以为还是老的"比"没有缓存"更危险。
 */
function createSchemaCache() {
  return { tables: null, at: null, db: null, version: 0 }
}

function putSchema(cache, schema, opts = {}) {
  const at = Number.isFinite(opts.at) ? opts.at : Date.now()
  return { tables: (schema && schema.tables) || [], db: opts.db || null, at, version: ((cache && cache.version) || 0) + 1 }
}

function schemaAge(cache, now) {
  if (!cache || !Number.isFinite(cache.at)) return null
  return Math.max(0, (Number.isFinite(now) ? now : Date.now()) - cache.at)
}

function isSchemaStale(cache, opts = {}) {
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : 10 * 60 * 1000
  const age = schemaAge(cache, opts.now)
  if (age == null) return { stale: true, unknown: true, reason: '从来没有取过表结构' }
  if (age > maxAgeMs) return { stale: true, unknown: false, ageMs: age, reason: '表结构缓存已过期（' + Math.round(age / 1000) + 's）' }
  return { stale: false, unknown: false, ageMs: age, reason: null }
}

/**
 * PH3-DB-03：把 schema 变成 Agent 能看的**紧凑**文本。
 * ⚠️ 不是把整张表 dump 进去 —— 只给 表名 + 列名 + 类型，且**限量**与**如实说明省略**。
 */
function schemaToAgentContext(schema, opts = {}) {
  const maxTables = Number.isFinite(opts.maxTables) ? opts.maxTables : 20
  const maxCols = Number.isFinite(opts.maxCols) ? opts.maxCols : 30
  const tables = (schema && schema.tables) || []
  if (!tables.length) return { text: '（还没有取到表结构）', tables: 0, columns: 0, omitted: null }
  const lines = []
  let cols = 0
  const shown = tables.slice(0, maxTables)
  for (const t of shown) {
    const cs = (t.columns || []).slice(0, maxCols)
    cols += cs.length
    lines.push('- ' + t.name + '(' + cs.map((c) => c.name + (c.type ? ':' + c.type : '')).join(', ') + ')')
  }
  const omitted = tables.length > shown.length ? (tables.length - shown.length) + ' 张表' : null
  if (omitted) lines.push('（还有 ' + omitted + ' 未列出 —— 数量受限）')
  return { text: lines.join('\n'), tables: shown.length, columns: cols, omitted }
}

// ── PH3-DB-04：查询历史 ────────────────────────────────────────────────────────

function createHistory(opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : 50
  return { entries: [], max }
}

function pushHistory(hist, entry, now) {
  const h = hist || createHistory()
  const e = {
    sql: String((entry && entry.sql) || '').slice(0, 2000),
    at: Number.isFinite(now) ? now : Date.now(),
    ok: entry && entry.ok === true,
    rows: Number.isFinite(entry && entry.rows) ? entry.rows : null,
    error: entry && entry.error ? String(entry.error).slice(0, 300) : null,
  }
  const entries = h.entries.concat([e])
  return { entries: entries.slice(Math.max(0, entries.length - h.max)), max: h.max }
}

function listHistory(hist, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 20
  const list = ((hist && hist.entries) || []).slice().reverse()   // 最近的在前
  return list.slice(0, limit)
}

// ── PH3-DB-07/08/09：Agent 生成 SELECT 草案 → **过闸** → 才能执行 ───────────────

/**
 * PH3-DB-07：由任务描述与 schema 生成**草案**（不执行）。
 *
 * ⚠️ 这里刻意只做一件很保守的事：挑一张**名字在任务里出现过**的表，
 *    生成 `SELECT * FROM 表 LIMIT n`。**不做**"猜 JOIN / 猜条件"——
 *    猜出来的 SQL 看起来很像样，但**语义可能是错的**，那比不生成更糟。
 *    真要复杂查询，交给模型生成，然后**照样过闸**（下面 executeDraft）。
 */
function draftSelect(task, schema, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : Number(SQL_LIMITS.defaultRowLimit || 100)
  const t = String(task == null ? '' : task).toLowerCase()
  const tables = (schema && schema.tables) || []
  if (!t.trim()) return { ok: false, error: '没有任务描述', draft: null }
  if (!tables.length) return { ok: false, error: '还没有表结构，无法生成草案（不猜表名）', draft: null }
  const hit = tables.find((x) => x && x.name && t.indexOf(String(x.name).toLowerCase()) >= 0)
  if (!hit) {
    return { ok: false, error: '任务里没有提到任何已知表名 —— 不猜（猜到错的表比不生成更糟）', draft: null, candidates: tables.slice(0, 10).map((x) => x.name) }
  }
  // 表名用 quoteIdent 的安全形式（调用方已注入 quoteIdent 的话）；这里保守地只允许标识符
  const name = String(hit.name)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { ok: false, error: '表名不是合法标识符，拒绝拼接：' + name, draft: null }
  }
  return {
    ok: true, draft: 'SELECT * FROM ' + name + ' LIMIT ' + limit,
    table: name, limit,
    note: '这是**草案**，还要过安全闸才能执行（PH3-DB-08）',
  }
}

/**
 * PH3-DB-08/09：执行草案 —— **第一件事就是过闸**。
 *
 * ⚠️ 哪怕 SQL 是我们自己生成的，也一律 `analyzeSql`。
 *    理由很实在：草案可能被上面传进来的内容影响，而模型生成的 SQL 更是不可信。
 *    **"自己生成的"不是豁免理由。**
 */
function executeDraft(draft, deps = {}) {
  const sql = String((draft && draft.draft) || draft || '')
  if (!sql.trim()) return { ok: false, code: 'EMPTY', error: '没有可执行的 SQL' }
  const gate = analyzeSql(sql, deps.gateOpts || {})
  if (gate.ok !== true) {
    return { ok: false, code: 'REJECTED', error: 'SQL 被安全闸拒绝：' + (gate.reason || gate.code), gate }
  }
  // 再加一道行数上限。⚠️ withRowLimit 返回 `{ok, sql}`（不是字符串），
  // 且它**内部也调了 analyzeSql** —— 所以这里按它的结果继续，不重复造。
  const limited = withRowLimit ? withRowLimit(sql, SQL_LIMITS.defaultRowLimit) : { ok: true, sql }
  if (limited.ok !== true) {
    return { ok: false, code: 'REJECTED', error: 'SQL 被行数上限环节拒绝：' + (limited.reason || ''), gate }
  }
  const finalSql = String(limited.sql || sql)
  if (typeof deps.runQuery !== 'function') {
    return { ok: false, code: 'NO_RUNNER', error: '没有注入查询能力', sql: finalSql, gate }
  }
  try {
    const r = deps.runQuery(finalSql)
    return { ok: true, sql: finalSql, gate, result: r }
  } catch (e) {
    return { ok: false, code: 'ERROR', error: String((e && e.message) || e), sql: finalSql, gate }
  }
}

/** PH3-DB-10：查询结果进 Agent Context（紧凑 + 如实截断）。 */
function resultToAgentContext(result, opts = {}) {
  const maxRows = Number.isFinite(opts.maxRows) ? opts.maxRows : 20
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 2000
  const rows = (result && (result.rows || result.lines)) || []
  if (!rows.length) return { text: '（没有返回行）', rows: 0, truncated: false }
  const shown = rows.slice(0, maxRows)
  const text = shown.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n').slice(0, maxChars)
  return {
    text,
    rows: shown.length,
    truncated: rows.length > shown.length || text.length >= maxChars,
    note: rows.length > shown.length ? ('共 ' + rows.length + ' 行，只给了前 ' + shown.length + ' 行') : null,
  }
}

module.exports = {
  DB_CONN, ALL_CONN,
  classifyConn, describeConn,
  createSchemaCache, putSchema, schemaAge, isSchemaStale, schemaToAgentContext,
  createHistory, pushHistory, listHistory,
  draftSelect, executeDraft, resultToAgentContext,
}
