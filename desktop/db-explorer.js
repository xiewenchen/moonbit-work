'use strict'

/**
 * 数据库工作台的构造层（Phase 2.1 / P15-01 ～ P15-06）
 *
 * 这一层的职责是**把"想看的"翻译成 SQL / Redis 命令**，不负责执行。
 * 分成两层的原因：构造是纯逻辑（可进 CI、可穷举测试），执行要真连数据库（环境相关）。
 *
 * ⚠️ 安全上最要紧的一点：**这里在拼 SQL，所以每一处外部输入都必须处理**。
 *    · 表名 / 列名：**只允许标识符**（`[A-Za-z_][A-Za-z0-9_]*`），别的直接拒；
 *    · 值（搜索词）：走 `escapeLiteral`（单引号双写 + 拒绝含 NUL）；
 *    · 结果一律再交给 `sql-guard` 复核一遍 —— 双重保险。
 *  这三条少一条，"搜索框"就是一个注入入口。
 */

const { analyzeSql, analyzeRedisCommand, withRowLimit, SQL_LIMITS } = require('./sql-guard')

const DEFAULT_SCHEMA = 'public'

/** 标识符白名单（表名、列名、schema 名都走这个）*/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function quoteIdent(name) {
  const s = String(name == null ? '' : name)
  if (!IDENT_RE.test(s)) throw new Error('不是合法标识符：' + JSON.stringify(s))
  return '"' + s + '"'
}

/** 字符串字面量转义（单引号双写）；NUL 直接拒（有些驱动会截断）*/
function escapeLiteral(v) {
  const s = String(v == null ? '' : v)
  if (s.indexOf('\u0000') >= 0) throw new Error('字面量里不允许 NUL 字符')
  return "'" + s.replace(/'/g, "''") + "'"
}

/** 每个入口都复核一遍 —— 构造错了也会在这里被拦下。
 *
 * ⚠️ 返回的是**原文**，不是 analyzeSql 的 normalized —— normalized 是**骨架化**后的
 * （标识符 → <id>、字面量 → <str>），拿它去执行根本跑不了。
 * （第一版就是误用了 normalized，被测试当场拓出来。）
 */
function verify(sql) {
  const r = analyzeSql(sql)
  if (r.ok !== true) throw new Error('生成的 SQL 没通过安全闸（' + r.code + '）：' + r.reason)
  return sql
}

// ── P15-01 表列表 ────────────────────────────────────────────────────────────
function sqlListTables(schema = DEFAULT_SCHEMA) {
  const s = IDENT_RE.test(String(schema)) ? String(schema) : DEFAULT_SCHEMA
  return verify(
    "SELECT table_schema, table_name, table_type FROM information_schema.tables " +
    "WHERE table_schema = " + escapeLiteral(s) + " ORDER BY table_name",
  )
}

// ── P15-02 列信息 ────────────────────────────────────────────────────────────
function sqlColumns(table, schema = DEFAULT_SCHEMA) {
  const t = String(table == null ? '' : table)
  if (!IDENT_RE.test(t)) throw new Error('表名不合法：' + JSON.stringify(t))
  const s = IDENT_RE.test(String(schema)) ? String(schema) : DEFAULT_SCHEMA
  return verify(
    'SELECT column_name, data_type, is_nullable, column_default ' +
    'FROM information_schema.columns WHERE table_schema = ' + escapeLiteral(s) +
    ' AND table_name = ' + escapeLiteral(t) + ' ORDER BY ordinal_position',
  )
}

// ── P15-03 分页读取 ──────────────────────────────────────────────────────────
/**
 * @param {{columns?:string[], limit?:number, offset?:number, orderBy?:string, desc?:boolean}} [opts]
 */
function sqlSelect(table, opts = {}) {
  const t = quoteIdent(String(table == null ? '' : table).trim())
  let cols = '*'
  if (Array.isArray(opts.columns) && opts.columns.length) {
    cols = opts.columns.map((c) => quoteIdent(String(c).trim())).join(', ')
  }
  let sql = 'SELECT ' + cols + ' FROM ' + t
  if (opts.orderBy) {
    sql += ' ORDER BY ' + quoteIdent(String(opts.orderBy).trim()) + (opts.desc === true ? ' DESC' : ' ASC')
  }
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(1000, Math.floor(opts.limit))) : SQL_LIMITS.maxResultRows
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0
  sql += ' LIMIT ' + limit + (offset > 0 ? ' OFFSET ' + offset : '')
  return verify(sql)
}

// ── P15-04 搜索 ──────────────────────────────────────────────────────────────
/**
 * 在若干列上做 LIKE 搜索。**值一定走 escapeLiteral**；
 * 另外把 `%` `_` 也转义掉（否则用户输入的 `%` 会变成通配 —— 那不是"搜索"该有的语义）。
 */
function sqlSearch(table, term, columns, opts = {}) {
  const t = quoteIdent(String(table == null ? '' : table).trim())
  if (!Array.isArray(columns) || !columns.length) throw new Error('搜索需要给出要搜的列')
  const like = '%' + String(term == null ? '' : term).replace(/[\\%_]/g, (m) => '\\' + m) + '%'
  const conds = columns.map((c) => 'CAST(' + quoteIdent(String(c).trim()) + ' AS TEXT) LIKE ' + escapeLiteral(like) + " ESCAPE '\\'")
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(500, Math.floor(opts.limit))) : 100
  return verify('SELECT * FROM ' + t + ' WHERE ' + conds.join(' OR ') + ' LIMIT ' + limit)
}

// ── P15-05 Redis Keys ────────────────────────────────────────────────────────
/**
 * 用 **SCAN** 而不是 KEYS：`KEYS *` 在大库上会阻塞 Redis（生产事故常见原因）。
 * 返回值保证过一遍 Redis 安全闸。
 */
function redisScanKeys(pattern = '*', cursor = '0', count = 200) {
  const c = Number.isFinite(count) ? Math.max(1, Math.min(1000, Math.floor(count))) : 200
  const cmd = ['SCAN', String(cursor || '0'), 'MATCH', String(pattern == null || pattern === '' ? '*' : pattern), 'COUNT', String(c)]
  const gate = analyzeRedisCommand(cmd)
  if (gate.ok !== true) throw new Error('Redis 命令没通过安全闸：' + gate.reason)
  return cmd
}

/** P15-06 读值：先 TYPE，再按类型选只读命令（不知道类型就 GET 会报错）*/
function redisReadKey(key, type) {
  const k = String(key == null ? '' : key)
  if (!k) throw new Error('key 为空')
  const t = String(type || '').toLowerCase()
  const byType = {
    string: ['GET', k],
    hash: ['HGETALL', k],
    list: ['LRANGE', k, '0', '99'],
    set: ['SMEMBERS', k],
    zset: ['ZRANGE', k, '0', '99', 'WITHSCORES'],
    stream: ['XRANGE', k, '-', '+'],
  }
  const cmd = byType[t] || ['TYPE', k]        // 不知道类型就先问类型（也是只读）
  const gate = analyzeRedisCommand(cmd)
  if (gate.ok !== true) throw new Error('Redis 命令没通过安全闸：' + gate.reason)
  return cmd
}

/**
 * 组合：读一个 key 的完整过程。
 *
 * ⚠️ 只回第一步（TYPE）—— 因为**类型要等查完才知道**，
 * 拿到 type 之后再由调用方 `redisReadKey(key, type)` 生成真正读值的命令。
 * （早先版本试图一次性给出两步，结果第二步只能又是 TYPE。）
 */
function redisPlanFor(key) {
  return [['TYPE', String(key)]]
}

module.exports = {
  DEFAULT_SCHEMA,
  quoteIdent,
  escapeLiteral,
  sqlListTables,
  sqlColumns,
  sqlSelect,
  sqlSearch,
  redisScanKeys,
  redisReadKey,
  redisPlanFor,
}
