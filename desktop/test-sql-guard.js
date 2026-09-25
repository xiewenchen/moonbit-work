'use strict'

/**
 * SQL / Redis 安全闸单测（Phase 2.1 / P15-08）
 *
 * 纯 Node。断言用公共 verify-harness。
 *
 * 这一份的核心不是"SELECT 能过"，而是**该拒的必须拒**：
 * 多语句、注释绕过、字符串里的分号、WITH 里藏写、危险函数、Redis 写命令。
 */

const { createHarness } = require('./verify-harness')
const {
  analyzeSql,
  withRowLimit,
  analyzeRedisCommand,
  stripCommentsAndStrings,
  splitStatements,
} = require('./sql-guard')

const H = createHarness()
const { chk, eq } = H

/** 允许 */
const ALLOW = [
  'SELECT 1',
  'SELECT * FROM users',
  'select id, name from users where id = 1',
  "SELECT 'a; b' AS x FROM t",                 // 字符串里的分号是数据
  'SELECT * FROM information_schema.columns',
  'SELECT count(*) FROM pg_stat_activity',
  'WITH t AS (SELECT 1 AS a) SELECT a FROM t', // CTE 只读
  'SELECT a FROM t OFFSET 10',                 // OFFSET 里的 SET 不该被当成 SET 语句
  'SELECT * FROM t WHERE name LIKE \'%set%\'',
  'SELECT 1 /* 注释里写 DROP TABLE x 也没事，因为它是注释 */',
  'SELECT 1 -- 行注释里有 DELETE 也不算',
]

/** 拒绝（附期望的 code）*/
const DENY = [
  ['SELECT 1; DROP TABLE users', 'MULTI_STATEMENT'],
  ['SELECT 1;SELECT 2', 'MULTI_STATEMENT'],
  ['DROP TABLE users', 'FORBIDDEN_KEYWORD'],
  ['DELETE FROM users', 'FORBIDDEN_KEYWORD'],
  ['UPDATE users SET name = 1', 'FORBIDDEN_KEYWORD'],
  ['INSERT INTO users VALUES (1)', 'FORBIDDEN_KEYWORD'],
  ['ALTER TABLE users ADD COLUMN x int', 'FORBIDDEN_KEYWORD'],
  ['TRUNCATE users', 'FORBIDDEN_KEYWORD'],
  ['CREATE TABLE x (a int)', 'FORBIDDEN_KEYWORD'],
  ['GRANT ALL ON users TO bob', 'FORBIDDEN_KEYWORD'],
  ['COPY users TO PROGRAM \'cat\'', 'FORBIDDEN_KEYWORD'],
  ['VACUUM FULL', 'FORBIDDEN_KEYWORD'],
  ['SET search_path = evil', 'FORBIDDEN_KEYWORD'],
  // 注释绕过：去掉注释后仍然是多语句 / 写操作
  ['SELECT 1 -- \n DROP TABLE users', 'FORBIDDEN_KEYWORD'],
  ['SELECT 1 /* */; DELETE FROM t', 'MULTI_STATEMENT'],
  ['SELECT /* 未闭合', 'UNCLOSED_COMMENT'],
  // WITH 里藏写
  ['WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'FORBIDDEN_KEYWORD'],
  // 危险函数
  ["SELECT pg_read_file('/etc/passwd')", 'FORBIDDEN_FUNCTION'],
  ['SELECT pg_sleep(3600)', 'FORBIDDEN_FUNCTION'],
  ["SELECT pg_ls_dir('/')", 'FORBIDDEN_FUNCTION'],
  ['SELECT pg_terminate_backend(1)', 'FORBIDDEN_FUNCTION'],
  // 空的 / 只有注释
  ['', 'EMPTY'],
  ['   ', 'EMPTY'],
  ['-- 只有注释', 'EMPTY'],
]

async function main() {
  console.log('\n=== ① 该允许的必须允许（别把正常查询也拦了）===')
  for (const sql of ALLOW) {
    const r = analyzeSql(sql)
    chk('允许：' + sql.slice(0, 46), r.ok === true, r.reason || '')
  }

  console.log('\n=== ② ★ 该拒的必须拒（含具体原因码）===')
  for (const [sql, code] of DENY) {
    const r = analyzeSql(sql)
    chk('拒绝[' + code + ']：' + sql.slice(0, 44).replace(/\n/g, '\\n'), r.ok === false && r.code === code,
      JSON.stringify({ ok: r.ok, code: r.code, reason: r.reason }).slice(0, 140))
  }

  console.log('\n=== ③ 注释与字符串的骨架化 ===')
  {
    const s1 = stripCommentsAndStrings("SELECT 'a;b' -- 注释\n/* 块 */ FROM t")
    chk('字符串被替换成占位符（里面的分号不参与切分）', s1.text.indexOf(';') < 0, s1.text)
    eq('坏了一个分号都切不出多语句', splitStatements(s1.text).length, 1)
    const s2 = stripCommentsAndStrings('SELECT 1 /* 没闭合')
    chk('未闭合块注释被标记', s2.unclosedComment === true)
    eq('字符串里的分号确实是数据', analyzeSql("SELECT 'x; DROP TABLE t' AS v").ok, true)
  }

  console.log('\n=== ④ 分页补齐（避免一次拉全表）===')
  {
    const a = withRowLimit('SELECT * FROM users')
    eq('没有 LIMIT 就补一个', a.sql, 'SELECT * FROM users LIMIT 200')
    const b = withRowLimit('SELECT * FROM users LIMIT 5')
    eq('已有 LIMIT 不动它', b.sql, 'SELECT * FROM users LIMIT 5')
    eq('可以指定上限', withRowLimit('SELECT 1', 10).sql, 'SELECT 1 LIMIT 10')
    const bad = withRowLimit('DROP TABLE users')
    eq('★ 写操作在这里也过不去', bad.ok, false)
  }

  console.log('\n=== ⑤ 表白名单（可选）===')
  {
    eq('在白名单里 → 允许', analyzeSql('SELECT * FROM users', { allowedTables: ['users'] }).ok, true)
    const no = analyzeSql('SELECT * FROM secrets', { allowedTables: ['users'] })
    eq('★ 不在白名单 → 拒绝', [no.ok, no.code], [false, 'TABLE_NOT_ALLOWED'])
    chk('  原因指出是哪张表', /secrets/.test(no.reason), no.reason)
  }

  console.log('\n=== ⑥ Redis：只读白名单 ===')
  {
    for (const cmd of ['GET k', 'MGET a b', 'KEYS *', 'HGETALL h', 'LRANGE l 0 -1', 'TTL k', 'INFO', 'SCAN 0']) {
      chk('允许：' + cmd, analyzeRedisCommand(cmd).ok === true)
    }
    const deny = [
      ['FLUSHALL', 'NOT_READONLY'],
      ['FLUSHDB', 'NOT_READONLY'],
      ['CONFIG SET maxmemory 0', 'NOT_READONLY'],
      ['EVAL "return 1" 0', 'NOT_READONLY'],
      ['SCRIPT LOAD "x"', 'NOT_READONLY'],
      ['MODULE LOAD x', 'NOT_READONLY'],
      ['SET k v', 'NOT_READONLY'],
      ['DEL k', 'NOT_READONLY'],
      ['SHUTDOWN', 'NOT_READONLY'],
      ['', 'EMPTY'],
    ]
    for (const [cmd, code] of deny) {
      const r = analyzeRedisCommand(cmd)
      chk('拒绝[' + code + ']：' + cmd, r.ok === false && r.code === code, JSON.stringify({ ok: r.ok, code: r.code }))
    }
    const arr = analyzeRedisCommand(['GET', 'k'])
    eq('数组形式也认', [arr.ok, arr.command, arr.args], [true, 'GET', ['k']])
  }

  console.log('\n=== ⑦ 长度上限 ===')
  {
    const long = 'SELECT ' + 'a'.repeat(30000)
    eq('★ 超长 SQL → 拒绝', analyzeSql(long).ok, false)
    eq('  原因码是 TOO_LONG', analyzeSql(long).code, 'TOO_LONG')
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
