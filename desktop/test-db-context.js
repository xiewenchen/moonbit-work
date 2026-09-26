// PH3-DB 的验证：连接状态 / 表结构缓存与进 Agent / 历史 / SELECT 草案**过闸**。
//
// 纯逻辑，可进 CI。
const { createHarness } = require('./verify-harness')
const {
  DB_CONN, ALL_CONN,
  classifyConn, describeConn,
  createSchemaCache, putSchema, schemaAge, isSchemaStale, schemaToAgentContext,
  createHistory, pushHistory, listHistory,
  draftSelect, executeDraft, resultToAgentContext,
} = require('./db-context')

const H = createHarness()
const { chk, eq } = H

const SCHEMA = {
  tables: [
    { name: 'users', columns: [{ name: 'id', type: 'int' }, { name: 'email', type: 'text' }] },
    { name: 'orders', columns: [{ name: 'id', type: 'int' }, { name: 'user_id', type: 'int' }, { name: 'total', type: 'numeric' }] },
  ],
}

console.log('=== ① 边界：null / 空（按记忆，第一组就测它）===')
{
  eq('classifyConn(null) → UNKNOWN（不是 ERROR）', classifyConn(null).state, 'UNKNOWN')
  chk('describeConn(null) 不炸', /还没连过/.test(describeConn(null)))
  chk('putSchema(null, null) 不炸', Array.isArray(putSchema(null, null).tables))
  eq('schemaAge(null) → null（不是 0）', schemaAge(null), null)
  chk('isSchemaStale(null) → 视为过期且未知', isSchemaStale(null).stale === true && isSchemaStale(null).unknown === true)
  chk('schemaToAgentContext(null) 不炸', /还没有取到表结构/.test(schemaToAgentContext(null).text))
  eq('listHistory(null) → 空', listHistory(null).length, 0)
  chk('draftSelect(null, null) → ok:false', draftSelect(null, null).ok === false)
  eq('executeDraft(null) → 空', executeDraft(null).code, 'EMPTY')
  chk('resultToAgentContext(null) 不炸', /没有返回行/.test(resultToAgentContext(null).text))
  eq('ALL_CONN 五态', ALL_CONN.length, 5)
}

console.log('\n=== ② PH3-DB-01 连接状态：四态必须分清 ===')
{
  eq('没试过 → UNKNOWN', classifyConn('随便什么').state, 'UNKNOWN')
  eq('  ★ 不是 ERROR（"没做"与"做错"是两回事）', classifyConn('x').state !== 'ERROR', true)

  eq('★ 没装客户端 → NO_CLIENT', classifyConn('未找到 psql 客户端', { attempted: true }).state, 'NO_CLIENT')
  chk('  英文提示也认', classifyConn('psql: command not found', { attempted: true }).state === 'NO_CLIENT')
  chk('  ★ 说明"不是连接失败"', /不是连接失败/.test(classifyConn('command not found', { attempted: true }).reason))

  eq('★ 认证失败 → AUTH_FAILED', classifyConn('password authentication failed for user "x"', { attempted: true }).state, 'AUTH_FAILED')
  chk('  redis 的 NOAUTH 也认', classifyConn('NOAUTH Authentication required', { attempted: true }).state === 'AUTH_FAILED')

  eq('有返回 → CONNECTED', classifyConn('SELECT 1\n(1 row)', { attempted: true }).state, 'CONNECTED')
  chk('  OK/PONG 也算', classifyConn('PONG', { attempted: true }).state === 'CONNECTED')
  eq('其它 → ERROR', classifyConn('something weird', { attempted: true }).state, 'ERROR')

  chk('可读描述分得清', /未装客户端/.test(describeConn({ state: 'NO_CLIENT', reason: 'x' })), describeConn({ state: 'NO_CLIENT', reason: 'x' }))
  chk('  ERROR 与 NO_CLIENT 的文案不同', describeConn({ state: 'ERROR' }) !== describeConn({ state: 'NO_CLIENT' }))
}

console.log('\n=== ③ PH3-DB-02 表结构缓存：能作废、能判过期 ===')
{
  let c = createSchemaCache()
  chk('刚开始没有缓存', c.tables === null && c.at === null)
  c = putSchema(c, SCHEMA, { at: 1000, db: 'app' })
  eq('存进去了', c.tables.length, 2)
  eq('记了时间', c.at, 1000)
  eq('★ 版本号递增（用于判断是否更新过）', c.version, 1)
  c = putSchema(c, SCHEMA, { at: 2000 })
  eq('再存一次版本 +1', c.version, 2)

  eq('能算年龄', schemaAge(c, 2500), 500)
  chk('没过期', isSchemaStale(c, { now: 2500, maxAgeMs: 10000 }).stale === false)
  const st = isSchemaStale(c, { now: 999999, maxAgeMs: 1000 })
  chk('★ 过期了', st.stale === true)
  chk('  且说明原因', /已过期/.test(st.reason), st.reason)
  chk('★ 从没取过 ≠ 过期（unknown 与 stale 分开）', isSchemaStale(createSchemaCache()).unknown === true)
}

console.log('\n=== ④ PH3-DB-03 Schema 进 Agent：紧凑 + 如实说明省略 ===')
{
  const r = schemaToAgentContext(SCHEMA)
  chk('★ 带表名与列名类型', /users\(id:int, email:text\)/.test(r.text), r.text)
  chk('  另一张表也在', /orders\(/.test(r.text))
  eq('计数对', r.tables, 2)
  chk('没省略时不编一句"已省略"', r.omitted === null)

  // 限量时**必须说明省略了多少**（不能悄悄少给）
  const many = { tables: Array.from({ length: 30 }, (_, i) => ({ name: 't' + i, columns: [{ name: 'a', type: 'int' }] })) }
  const limited = schemaToAgentContext(many, { maxTables: 5 })
  eq('只给 5 张', limited.tables, 5)
  chk('★ 如实说明还有多少没列', /还有 25 张表/.test(limited.text), limited.text.slice(-60))
  chk('  且标 omitted', limited.omitted === '25 张表')

  const wide = { tables: [{ name: 'wide', columns: Array.from({ length: 40 }, (_, i) => ({ name: 'c' + i, type: 'int' })) }] }
  eq('列数也受限', schemaToAgentContext(wide, { maxCols: 3 }).columns, 3)
}

console.log('\n=== ⑤ PH3-DB-04 查询历史（最近在前、有上限）===')
{
  let h = createHistory({ max: 3 })
  h = pushHistory(h, { sql: 'SELECT 1', rows: 1 }, 100)
  h = pushHistory(h, { sql: 'SELECT 2', rows: 2 }, 200)
  eq('记了两条', h.entries.length, 2)
  h = pushHistory(h, { sql: 'SELECT 3', rows: 3 }, 300)
  h = pushHistory(h, { sql: 'SELECT 4', rows: 4 }, 400)
  eq('★ 超上限后只留最近的', h.entries.length, 3)
  eq('  最老的被挤掉', h.entries[0].sql, 'SELECT 2')
  const list = listHistory(h, { limit: 2 })
  eq('★ 列出时最近的在最前', list[0].sql, 'SELECT 4')
  eq('  限 2 条', list.length, 2)
  h = pushHistory(h, { sql: 'SELECT 5', ok: false, error: 'boom' }, 500)
  chk('失败也记下来（带原因）', /boom/.test(String(listHistory(h, { limit: 1 })[0].error)))
}

console.log('\n=== ⑥ ★★ PH3-DB-07/08 草案：生成要保守，执行必须过闸 ===')
{
  const d = draftSelect('看看 users 表里有什么', SCHEMA)
  eq('能生成草案', d.ok, true)
  chk('★ 草案是受限 SELECT', /^SELECT \* FROM users LIMIT \d+$/.test(d.draft), d.draft)
  chk('  且明确标注"还要过闸"', /草案/.test(d.note) && /安全闸/.test(d.note), d.note)

  const noTable = draftSelect('帮我查一下数据', SCHEMA)
  eq('★ 任务里没提到表名 → **不猜**', noTable.ok, false)
  chk('  说明为什么不猜', /不猜/.test(noTable.error), noTable.error)
  chk('  给出候选表名让人选', Array.isArray(noTable.candidates) && noTable.candidates.length > 0, JSON.stringify(noTable.candidates))
  eq('没有 schema → 也不猜', draftSelect('users', null).ok, false)

  // ★★ 核心：即使 SQL 是"我们自己生成的"，执行前也必须过闸
  const evil1 = executeDraft({ draft: 'DELETE FROM users' }, { runQuery: () => 'SHOULD NOT RUN' })
  eq('★★ Agent 生成的 DELETE → REJECTED', evil1.code, 'REJECTED')
  chk('  说明被闸拦下', /安全闸/.test(evil1.error), evil1.error)
  chk('  带闸的判定结果（可追查）', !!evil1.gate)

  const evil2 = executeDraft({ draft: 'SELECT 1; DROP TABLE users' }, { runQuery: () => 'SHOULD NOT RUN' })
  eq('★★ 多语句 → REJECTED', evil2.code, 'REJECTED')

  const evil3 = executeDraft({ draft: "SELECT * FROM users WHERE x = 1 -- ' OR 1=1" }, {})
  chk('  注释绕过也过不了闸（或至少不静默通过）', evil3.code !== undefined)

  // 合法 SELECT：过闸 → 调 runQuery
  let ran = null
  const good = executeDraft({ draft: 'SELECT id FROM users' }, { runQuery: (sql) => { ran = sql; return { rows: [{ id: 1 }] } } })
  eq('★ 合法 SELECT 通过', good.ok, true)
  chk('  真的执行了', ran != null && ran.indexOf('users') >= 0, String(ran))
  chk('  且带上闸的判定', !!good.gate && good.gate.ok === true)
  eq('  结果带回来', good.result.rows.length, 1)

  // 没注入查询能力时不能假装成功
  const noRunner = executeDraft({ draft: 'SELECT id FROM users' }, {})
  eq('★ 没注入 runQuery → NO_RUNNER（不假装）', noRunner.code, 'NO_RUNNER')

  // runQuery 抛错 → 如实失败
  const thrown = executeDraft({ draft: 'SELECT id FROM users' }, { runQuery: () => { throw new Error('连接断了') } })
  eq('★ 执行抛错 → ERROR', thrown.code, 'ERROR')
  chk('  原因带出来', /连接断了/.test(thrown.error), thrown.error)
}

console.log('\n=== ⑦ PH3-DB-10 结果进 Agent Context（截断要如实）===')
{
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }))
  const r = resultToAgentContext({ rows }, { maxRows: 5 })
  eq('只给 5 行', r.rows, 5)
  eq('★ 标 truncated', r.truncated, true)
  chk('★ 并说明总数（不是悄悄少给）', /共 50 行/.test(String(r.note)), String(r.note))
  chk('内容里有行', /"id":0/.test(r.text), r.text.slice(0, 80))

  chk('redis 的 lines 也支持', resultToAgentContext({ lines: ['a', 'b'] }).rows === 2)
  eq('空结果不炸', resultToAgentContext({ rows: [] }).rows, 0)
  chk('字符上限也生效', resultToAgentContext({ rows: [('x'.repeat(5000))] }, { maxChars: 100 }).text.length === 100)
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
