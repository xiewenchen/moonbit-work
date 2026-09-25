'use strict'

/**
 * 数据库工作台构造层单测（Phase 2.1 / P15-01 ～ P15-06）
 *
 * 纯 Node。断言用公共 verify-harness。
 *
 * 这一份的重点是**注入**：既然这里在拼 SQL，那么"搜索框"天然就是注入入口。
 * 所以每条外部输入都要有专门的攻击用例。
 */

const { createHarness } = require('./verify-harness')
const {
  quoteIdent,
  escapeLiteral,
  sqlListTables,
  sqlColumns,
  sqlSelect,
  sqlSearch,
  redisScanKeys,
  redisReadKey,
  redisPlanFor,
} = require('./db-explorer')
const { analyzeSql, analyzeRedisCommand } = require('./sql-guard')

const H = createHarness()
const { chk, eq } = H

async function main() {
  console.log('\n=== ① 标识符与字面量（注入的第一道闸）===')
  {
    eq('正常标识符被引号包住', quoteIdent('users'), '"users"')
    eq('下划线/数字后缀 OK', quoteIdent('user_2'), '"user_2"')
    for (const bad of ['users; DROP TABLE x', 'users" --', 'a b', '', '1users', 'users)', "x'; DROP"]) {
      let threw = false
      try { quoteIdent(bad) } catch (e) { threw = true }
      chk('★ 非法标识符被拒：' + JSON.stringify(bad).slice(0, 20), threw)
    }
    eq('字面量里单引号被双写', escapeLiteral("O'Brien"), "'O''Brien'")
    let nul = false
    try { escapeLiteral('a\u0000b') } catch (e) { nul = true }
    chk('含 NUL 的字面量被拒', nul)
  }

  console.log('\n=== ② P15-01/02 表与列 ===')
  {
    const t = sqlListTables()
    chk('表列表 SQL 过安全闸', analyzeSql(t).ok === true, t)
    chk('  用的是 information_schema', /information_schema\.tables/.test(t), t)
    chk('  带 ORDER BY（结果稳定）', /ORDER BY table_name/.test(t), t)

    const c = sqlColumns('users')
    chk('列信息 SQL 过安全闸', analyzeSql(c).ok === true, c)
    chk('  限定到具体表', /table_name = 'users'/.test(c), c)
    eq('★ 表名非法 → 直接抛（不进安全闸）', (() => { try { sqlColumns('users; DROP') } catch (e) { return 'threw' } return 'no' })(), 'threw')
  }

  console.log('\n=== ③ P15-03 分页读取 ===')
  {
    const a = sqlSelect('users')
    chk('默认查询过安全闸', analyzeSql(a).ok === true, a)
    chk('默认带上 LIMIT', /LIMIT 200/.test(a), a)
    const b = sqlSelect('users', { columns: ['id', 'name'], limit: 10, offset: 20, orderBy: 'id', desc: true })
    eq('列/排序/分页都对', b, 'SELECT "id", "name" FROM "users" ORDER BY "id" DESC LIMIT 10 OFFSET 20')
    chk('limit 被夹到上限内', /LIMIT 1000/.test(sqlSelect('t', { limit: 99999 })), sqlSelect('t', { limit: 99999 }))
    chk('offset 负数归零（不出现负数）', sqlSelect('t', { offset: -5 }).indexOf('OFFSET') < 0, sqlSelect('t', { offset: -5 }))
    eq('★ 列名非法 → 抛', (() => { try { sqlSelect('t', { columns: ['a; DROP'] }) } catch (e) { return 'threw' } return 'no' })(), 'threw')
  }

  console.log('\n=== ④ P15-04 搜索：转义必须到位 ===')
  {
    const s = sqlSearch('users', 'bob', ['name', 'email'])
    chk('搜索 SQL 过安全闸', analyzeSql(s).ok === true, s)
    chk('对多个列做 OR 匹配', /CAST\("name" AS TEXT\)/.test(s) && / OR /.test(s), s)
    chk('用的是 CAST AS TEXT（数字列也能搜）', /CAST\(/.test(s), s)

    // ★ 单引号注入
    const inj = sqlSearch('users', "a' OR 1=1 --", ['name'])
    chk('★ 注入串被转义（单引号双写）', /''/.test(inj) && analyzeSql(inj).ok === true, inj)
    chk('★ 转义后没有出现裸的 OR 1=1 逻辑', !/LIKE '%a' OR 1=1/.test(inj), inj)

    // ★ 通配符：用户输入 % 不该被当成通配
    const pct = sqlSearch('users', '100%', ['name'])
    chk('★ % 被转义（不是通配）', /\\%/.test(pct), pct)
    const und = sqlSearch('users', 'a_b', ['name'])
    chk('★ _ 被转义', /\\_/.test(und), und)
    chk('  并声明了 ESCAPE', /ESCAPE/.test(pct), pct)

    // 多语句尝试（值里带分号）
    const semi = sqlSearch('users', "x'; DROP TABLE users; --", ['name'])
    chk('★ 值里的分号不会变成第二条语句（安全闸仍过）', analyzeSql(semi).ok === true, semi)
  }

  console.log('\n=== ⑤ P15-05 Redis Keys：用 SCAN 不用 KEYS ===')
  {
    const cmd = redisScanKeys('user:*')
    eq('命令是 SCAN', cmd[0], 'SCAN')
    chk('带 MATCH 与 COUNT', cmd.indexOf('MATCH') >= 0 && cmd.indexOf('COUNT') >= 0, JSON.stringify(cmd))
    chk('过 Redis 安全闸', analyzeRedisCommand(cmd).ok === true)
    chk('★ 没有用 KEYS（大库上会阻塞）', cmd[0] !== 'KEYS', JSON.stringify(cmd))
    eq('默认 pattern 是 *', redisScanKeys('')[3], '*')
    chk('COUNT 被夹到上限', Number(redisScanKeys('*', '0', 99999)[5]) <= 1000, JSON.stringify(redisScanKeys('*', '0', 99999)))
  }

  console.log('\n=== ⑥ P15-06 Redis Value：按类型选命令 ===')
  {
    eq('string → GET', redisReadKey('k', 'string'), ['GET', 'k'])
    eq('hash → HGETALL', redisReadKey('k', 'hash'), ['HGETALL', 'k'])
    eq('list → LRANGE（带范围，不会拉整表）', redisReadKey('k', 'list'), ['LRANGE', 'k', '0', '99'])
    eq('set → SMEMBERS', redisReadKey('k', 'set'), ['SMEMBERS', 'k'])
    eq('zset → ZRANGE WITHSCORES', redisReadKey('k', 'zset'), ['ZRANGE', 'k', '0', '99', 'WITHSCORES'])
    eq('★ 不知道类型 → 先问 TYPE（也是只读）', redisReadKey('k'), ['TYPE', 'k'])

    for (const cmd of [redisReadKey('k', 'string'), redisReadKey('k', 'hash'), redisReadKey('k'), redisScanKeys('*')]) {
      chk('每个命令都过安全闸：' + cmd[0], analyzeRedisCommand(cmd).ok === true)
    }
    let threw = false
    try { redisReadKey('') } catch (e) { threw = true }
    chk('空 key → 抛', threw)

    const plan = redisPlanFor('user:1')
    eq('★ 组合计划只回第一步 TYPE（类型要查完才知道）', plan.map((c) => c[0]), ['TYPE'])
    chk('  且这一步过闸', analyzeRedisCommand(plan[0]).ok === true)
    eq('★ 拿到类型后能接着生成读值命令', redisReadKey('user:1', 'string'), ['GET', 'user:1'])
  }

  console.log('\n=== ⑦ 生成的东西一定过安全闸（双重保险）===')
  {
    const all = [
      sqlListTables('public'),
      sqlColumns('t', 'public'),
      sqlSelect('t'),
      sqlSelect('t', { columns: ['a'], orderBy: 'a' }),
      sqlSearch('t', 'v', ['a']),
    ]
    for (const sql of all) {
      const r = analyzeSql(sql)
      chk('过闸：' + sql.slice(0, 44), r.ok === true, r.reason || '')
    }
    // schema 名不合法时退回默认（而不是拼进去）
    chk('★ 非法 schema 名退回默认值', /'public'/.test(sqlListTables('x; DROP')), sqlListTables('x; DROP'))
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
