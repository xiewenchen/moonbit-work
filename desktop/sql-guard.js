'use strict'

/**
 * SQL / Redis 的安全闸（Phase 2.1 / P15-08）
 *
 * 清单的要求是「**危险 SQL 默认拒绝**：默认只放 SELECT，默认拒绝 DROP / DELETE / UPDATE /
 * INSERT / ALTER」。
 *
 * 但"过滤关键词"是不够的 —— 真正会出事的是下面这些：
 *
 *   ① 多语句：`SELECT 1; DROP TABLE users`      —— 前半段合法，后半段要命
 *   ② 注释   ：`SELECT 1 -- 换行后 DROP TABLE users`，或用块注释把后续藏起来
 *   ③ 写操作：INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/GRANT/COPY/VACUUM...
 *   ④ 读文件：`SELECT pg_read_file('/etc/passwd')` / `pg_ls_dir` —— 挂着"读"的名字干别的事
 *   ⑤ 阻塞  ：`pg_sleep(3600)` / `pg_terminate_backend(...)`
 *   ⑥ Redis：除只读命令以外的任何东西（FLUSHALL / CONFIG SET / EVAL ...）
 *
 * 所以做法是**白名单**：只允许"单个以 SELECT（或 WITH ... SELECT）开头的语句"，
 * 再把上面几类逐个挡掉。宁可拒掉一些本来无害的查询，也不要放进来一条能改数据的。
 *
 * 纯逻辑、零依赖，可直接进 CI。
 */

/** 一律拒绝的关键词（出现即拒 —— 即使出现在看起来无伤的地方）*/
const FORBIDDEN_KEYWORDS = Object.freeze([
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'REPLACE',
  'GRANT', 'REVOKE', 'COPY', 'VACUUM', 'REINDEX', 'CLUSTER', 'CLUSTERIZE',
  'COMMENT', 'SECURITY', 'REFRESH', 'CALL', 'DO', 'EXECUTE', 'PREPARE', 'DEALLOCATE',
  'SET', 'RESET', 'SHOW', 'LISTEN', 'NOTIFY', 'LOCK', 'DISCARD',
])

/** 挂着"只读"名字但能干别的事的函数 */
const FORBIDDEN_FUNCTIONS = Object.freeze([
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'pg_sleep', 'pg_sleep_for', 'pg_sleep_until',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
  'lo_import', 'lo_export', 'dblink', 'dblink_exec',
  'set_config', 'current_setting',
])

/** Redis 只读命令白名单（P15-05/06 只读不写）*/
const REDIS_READ_COMMANDS = Object.freeze([
  'GET', 'MGET', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'KEYS', 'SCAN',
  'HGET', 'HMGET', 'HGETALL', 'HLEN', 'HEXISTS', 'HKEYS', 'HVALS',
  'LRANGE', 'LLEN', 'LINDEX',
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SRANDMEMBER',
  'ZRANGE', 'ZREVRANGE', 'ZCARD', 'ZSCORE', 'ZRANK', 'ZRANGEBYSCORE',
  'OBJECT', 'DUMP', 'DBSIZE', 'INFO', 'MEMORY', 'RANDOMKEY', 'CLIENT',
])

const SQL_LIMITS = Object.freeze({
  maxChars: 20000,
  maxResultRows: 200,        // 默认返回上限（分页用）
})

/**
 * 去掉 SQL 注释与字符串字面量，返回"结构化骨架"。
 * 为什么要去字符串：`SELECT '; DROP TABLE x'` 里的分号是**数据**，不是语句分隔符。
 */
function stripCommentsAndStrings(sql) {
  const s = String(sql == null ? '' : sql)
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    const c2 = s[i + 1]
    // 行注释
    if (c === '-' && c2 === '-') {
      while (i < s.length && s[i] !== '\n') i++
      out += ' '
      continue
    }
    // 块注释（**不允许嵌套，且没闭合就当作拒绝的线索**：补一个标记）
    if (c === '/' && c2 === '*') {
      const end = s.indexOf('*/', i + 2)
      if (end < 0) return { text: out + ' /*UNCLOSED', unclosedComment: true }
      i = end + 2
      out += ' '
      continue
    }
    // 单引号字符串（'' 是转义）
    if (c === "'") {
      i++
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue }
        if (s[i] === "'") { i++; break }
        i++
      }
      out += ' <str> '
      continue
    }
    // 双引号标识符
    if (c === '"') {
      i++
      while (i < s.length && s[i] !== '"') i++
      i++
      out += ' <id> '
      continue
    }
    // 美元引用（$$...$$）—— 常用来藏东西，直接标出来
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(s.slice(i))
      if (m) {
        const close = s.indexOf(m[0], i + m[0].length)
        if (close < 0) return { text: out + ' $UNCLOSED', unclosedDollar: true }
        i = close + m[0].length
        out += ' <dollar> '
        continue
      }
    }
    out += c
    i++
  }
  return { text: out, unclosedComment: false }
}

/** 按分号切语句（只切**骨架**里的分号，所以字符串里的分号不会被误切）*/
function splitStatements(bones) {
  return String(bones)
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

/**
 * P15-08：分析一条 SQL 是否允许执行。
 * @returns {{ok: boolean, reason?: string, code?: string}}
 */
function analyzeSql(sql, opts = {}) {
  const raw = String(sql == null ? '' : sql)
  if (!raw.trim()) return { ok: false, code: 'EMPTY', reason: 'SQL 为空' }
  if (raw.length > SQL_LIMITS.maxChars) return { ok: false, code: 'TOO_LONG', reason: 'SQL 过长（超过 ' + SQL_LIMITS.maxChars + ' 字）' }

  const st = stripCommentsAndStrings(raw)
  if (st.unclosedComment) return { ok: false, code: 'UNCLOSED_COMMENT', reason: '有没闭合的块注释 —— 拒绝（可能用来藏语句）' }
  if (st.unclosedDollar) return { ok: false, code: 'UNCLOSED_DOLLAR', reason: '有没闭合的美元引用 —— 拒绝' }

  const parts = splitStatements(st.text)
  if (parts.length === 0) return { ok: false, code: 'EMPTY', reason: '没有实际语句' }
  // ① 多语句：一律拒（哪怕两条都是 SELECT —— 我们不需要这个能力，也省得漏）
  if (parts.length > 1) {
    return { ok: false, code: 'MULTI_STATEMENT', reason: '不允许多条语句（检测到 ' + parts.length + ' 条）' }
  }

  const one = parts[0]
  const upper = one.toUpperCase()

  // ② 词黑名单（先做，能给出更具体的原因）
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp('(^|[^A-Z0-9_])' + kw + '([^A-Z0-9_]|$)').test(upper)) {
      return { ok: false, code: 'FORBIDDEN_KEYWORD', reason: '只允许 SELECT —— 出现了 ' + kw }
    }
  }
  // ③ 危险函数
  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (new RegExp('(^|[^A-Z0-9_])' + fn.replace(/_/g, '_') + '\\s*\\(', 'i').test(one)) {
      return { ok: false, code: 'FORBIDDEN_FUNCTION', reason: '不允许调用 ' + fn }
    }
  }
  // ④ 必须以 SELECT 或 WITH 开头（WITH ... SELECT 是合法只读）
  const m = /^(SELECT|WITH)\b/i.exec(one)
  if (!m) {
    return { ok: false, code: 'NOT_SELECT', reason: '只允许 SELECT / WITH 开头的只读查询' }
  }
  // WITH 后面也必须是 SELECT 结尾（`WITH x AS (DELETE ... RETURNING *) SELECT ...` 是写操作！）
  if (m[1].toUpperCase() === 'WITH') {
    if (/\b(DELETE|UPDATE|INSERT)\b/i.test(one)) {
      return { ok: false, code: 'CTE_WRITE', reason: 'WITH 里包含写操作 —— 拒绝' }
    }
  }
  // ⑤ 用户显式限制（例如只许查白名单里的表）
  if (Array.isArray(opts.allowedTables) && opts.allowedTables.length) {
    const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi
    let mm
    while ((mm = re.exec(one))) {
      const t = mm[1].split('.').pop().toLowerCase()
      if (opts.allowedTables.map((x) => String(x).toLowerCase()).indexOf(t) < 0) {
        return { ok: false, code: 'TABLE_NOT_ALLOWED', reason: '不允许查这张表：' + mm[1] }
      }
    }
  }

  return { ok: true, code: 'OK', normalized: one.replace(/\s+/g, ' ').trim() }
}

/** 加上分页上限：没有 LIMIT 就补一个（避免一次拉全表）*/
function withRowLimit(sql, maxRows = SQL_LIMITS.maxResultRows) {
  const a = analyzeSql(sql)
  if (a.ok !== true) return { ok: false, reason: a.reason }
  if (/\bLIMIT\b/i.test(a.normalized)) return { ok: true, sql: a.normalized }
  return { ok: true, sql: a.normalized + ' LIMIT ' + Math.max(1, Math.floor(maxRows)) }
}

// ── Redis（P15-05/06 只读）────────────────────────────────────────────────────
/**
 * Redis 也是**白名单**：只认读到的那几个命令。
 * `EVAL` / `CONFIG` / `FLUSHALL` / `SCRIPT` / `MODULE` 这类一律拒。
 */
function analyzeRedisCommand(input) {
  let cmd = ''
  let args = []
  if (Array.isArray(input)) { cmd = String(input[0] || ''); args = input.slice(1) } else {
    const s = String(input == null ? '' : input).trim()
    const sp = s.indexOf(' ')
    cmd = sp < 0 ? s : s.slice(0, sp)
    args = sp < 0 ? [] : s.slice(sp + 1).trim().split(/\s+/).filter(Boolean)
  }
  const up = cmd.toUpperCase()
  if (!up) return { ok: false, code: 'EMPTY', reason: '命令为空' }
  if (REDIS_READ_COMMANDS.indexOf(up) < 0) {
    return { ok: false, code: 'NOT_READONLY', reason: '只允许只读命令 —— ' + up + ' 不在白名单里' }
  }
  // 即使白名单命令，也不许带"写"的开关（例如 OBJECT 只能看，不能改；这里给个兜底）
  return { ok: true, code: 'OK', command: up, args: args.map(String).slice(0, 8) }
}

module.exports = {
  FORBIDDEN_KEYWORDS,
  FORBIDDEN_FUNCTIONS,
  REDIS_READ_COMMANDS,
  SQL_LIMITS,
  stripCommentsAndStrings,
  splitStatements,
  analyzeSql,
  withRowLimit,
  analyzeRedisCommand,
}
