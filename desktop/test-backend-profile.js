// PH3-BE 的验证：Profile / 状态时间线 / OpenAPI 发现 / 错误进问题模型 / 健康进 Quality。
//
// 纯逻辑，可进 CI。样本用**真实** OpenAPI 3 与 Swagger 2 的形状。
const { createHarness } = require('./verify-harness')
const {
  BACKEND_STATE, ALL_STATES, HTTP_METHODS, LOG_ERROR_RE,
  canTransition, createTimeline, advance, describeTimeline,
  createProfile, profileReadiness,
  discoverApis, toDebugRequests,
  errorsToProblems, healthToQuality,
} = require('./backend-profile')

const H = createHarness()
const { chk, eq } = H

const OPENAPI3 = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Demo API', version: '1.0.0' },
  paths: {
    '/health': { get: { summary: '健康检查' } },
    '/users': {
      get: { summary: '列用户', tags: ['user'] },
      post: { summary: '建用户', tags: ['user'], security: [{ bearer: [] }] },
    },
    '/users/{id}': { delete: { operationId: 'deleteUser' } },
  },
})

const SWAGGER2 = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Legacy API' },
  basePath: '/api/v1',
  paths: { '/items': { get: { summary: '列 items' } } },
})

console.log('=== ① 边界：null / 空（按记忆，第一组就测它）===')
{
  eq('advance(null, RUNNING) 不炸且被拒', advance(null, 'RUNNING').ok, false)
  chk('createTimeline(null) → 初始 STOPPED', createTimeline(null).current === 'STOPPED')
  eq('describeTimeline(null) 不炸', describeTimeline(null), '已停止　｜ 0 次迁移')
  chk('createProfile(null) 不炸', createProfile(null).port === null)
  eq('profileReadiness(null) → 不能连', profileReadiness(null).ok, false)
  chk('discoverApis(null) → ok:false', discoverApis(null).ok === false)
  eq('toDebugRequests(null) → 空', toDebugRequests(null).length, 0)
  eq('errorsToProblems(null) → 空', errorsToProblems(null).length, 0)
  chk('healthToQuality(null) 不炸', healthToQuality(null).state === 'NOT_RUN')
  eq('canTransition 未知状态 → false', canTransition('WAT', 'RUNNING'), false)
}

console.log('\n=== ② PH3-BE-06 状态机与时间线 ===')
{
  eq('五态（比清单多 DEGRADED）', ALL_STATES.length, 5)
  chk('STOPPED → STARTING 允许', canTransition(BACKEND_STATE.STOPPED, BACKEND_STATE.STARTING))
  chk('★ STARTING → RUNNING 允许', canTransition(BACKEND_STATE.STARTING, BACKEND_STATE.RUNNING))
  chk('★ STOPPED → RUNNING **不允许**（不能跳过启动中）', canTransition(BACKEND_STATE.STOPPED, BACKEND_STATE.RUNNING) === false)
  chk('★ RUNNING → DEGRADED 允许（进程在但不健康）', canTransition(BACKEND_STATE.RUNNING, BACKEND_STATE.DEGRADED))
  chk('★ DEGRADED → RUNNING 允许（恢复了）', canTransition(BACKEND_STATE.DEGRADED, BACKEND_STATE.RUNNING))

  let tl = createTimeline(0)
  tl = advance(tl, BACKEND_STATE.STARTING, { at: 100 }).timeline
  tl = advance(tl, BACKEND_STATE.RUNNING, { at: 200 }).timeline
  eq('走到 RUNNING', tl.current, 'RUNNING')
  eq('记了两次迁移', tl.entries.filter((e) => e.ok).length, 2)
  chk('  每次都有时间', tl.entries.every((e) => Number.isFinite(e.at)))

  // 拒掉的迁移也要记（否则事后看不出"当时想改没改成"）
  const bad = advance(tl, BACKEND_STATE.STOPPED, { at: 300 })
  eq('RUNNING → STOPPED 应当允许', bad.ok, true)   // 这条是允许的
  const tl2 = advance(createTimeline(0), BACKEND_STATE.FAILED, { at: 10 }).timeline
  const illegal = advance(tl2, 'WAT', { at: 20 })
  eq('未知状态被拒', illegal.ok, false)
  const back = advance(tl2, BACKEND_STATE.STARTING, { at: 30 })
  eq('★ FAILED → STARTING 允许（可重试）', back.ok, true)

  // 非法迁移的痕迹
  const t3 = advance(advance(createTimeline(0), BACKEND_STATE.STARTING, { at: 1 }).timeline, BACKEND_STATE.RUNNING, { at: 2 }).timeline
  const r = advance(t3, BACKEND_STATE.STARTING, { at: 3 })
  eq('★ RUNNING → STARTING 被拒', r.ok, false)
  chk('  且被拒的也记进时间线', r.timeline.entries.some((e) => e.ok === false && e.to === 'STARTING'), JSON.stringify(r.timeline.entries))

  chk('可读描述', /运行中/.test(describeTimeline(t3)), describeTimeline(t3))
}

console.log('\n=== ③ PH3-BE-01 Profile：取不到就留 null，不猜 ===')
{
  const p = createProfile({ rootDir: 'C:/proj', entry: 'cmd/main/main.mbt', port: 8080, healthPath: '/health', kind: 'moonbit' })
  eq('root', p.root, 'C:/proj')
  eq('entry', p.entry, 'cmd/main/main.mbt')
  eq('port', p.port, 8080)
  eq('healthPath', p.healthPath, '/health')
  eq('host 默认本机', p.host, '127.0.0.1')
  eq('db 没给 → null', p.db, null)
  chk('冻结', Object.isFrozen(p))

  const noPort = createProfile({ rootDir: 'C:/proj' })
  eq('★ 没有端口就是 null（**不猜 8080**）', noPort.port, null)
  const ready = profileReadiness(noPort)
  eq('★ 缺关键项 → 不能发起健康检查', ready.ok, false)
  chk('  且说清缺什么', /port/.test(ready.reason), ready.reason)
  chk('齐了才说可以', profileReadiness(p).ok === true)
}

console.log('\n=== ④ PH3-BE-07 API 发现（OpenAPI 3 与 Swagger 2）===')
{
  const d = discoverApis(OPENAPI3)
  eq('解析成功', d.ok, true)
  eq('版本识别', d.version, '3.0.3')
  eq('标题', d.title, 'Demo API')
  eq('★ 端点数（4 个方法：health.get / users.get+post / users{id}.delete）', d.count, 4)
  const paths = d.endpoints.map((e) => e.method + ' ' + e.path)
  chk('含 GET /health', paths.indexOf('GET /health') >= 0, JSON.stringify(paths))
  chk('含 POST /users', paths.indexOf('POST /users') >= 0)
  chk('含 DELETE /users/{id}（取 operationId 当摘要）', d.endpoints.find((e) => e.path === '/users/{id}').summary === 'deleteUser')
  chk('★ 标明需要鉴权的那条', d.endpoints.find((e) => e.method === 'POST').secured === true, JSON.stringify(d.endpoints.find((e) => e.method === 'POST')))
  chk('  不需要鉴权的那条如实为 false', d.endpoints.find((e) => e.method === 'GET' && e.path === '/users').secured === false)
  chk('带 tags', JSON.stringify(d.endpoints.find((e) => e.path === '/users' && e.method === 'GET').tags) === '["user"]')

  const s2 = discoverApis(SWAGGER2)
  eq('Swagger 2 也认', s2.ok, true)
  eq('  版本识别', s2.version, 'swagger2')
  eq('★ basePath 拼进路径', s2.endpoints[0].path, '/api/v1/items')

  // 非法输入如实说
  chk('非 JSON → 失败', discoverApis('not json').ok === false)
  chk('  说明原因', /合法 JSON/.test(discoverApis('not json').error))
  chk('没有 paths → 失败', discoverApis('{"openapi":"3.0.0"}').ok === false)
  chk('  说明不是 OpenAPI', /没有 paths/.test(discoverApis('{"openapi":"3.0.0"}').error))
  eq('paths 为空 → 0 条（不是失败）', discoverApis('{"openapi":"3.0.0","paths":{}}').count, 0)

  // PH3-BE-08：生成 API Debug 请求模板
  const reqs = toDebugRequests(d, 'http://127.0.0.1:8080/')
  eq('生成 4 条', reqs.length, 4)
  chk('★ URL 拼对了（去掉末尾斜杠再拼）', reqs.some((r) => r.url === 'http://127.0.0.1:8080/health'), JSON.stringify(reqs[0]))
  chk('  带上名字与方法', /GET \/health/.test(reqs.find((r) => r.url.endsWith('/health')).name))
  chk('  鉴权信息也带过去', reqs.find((r) => r.method === 'POST').secured === true)
  chk('没有 baseUrl 时给相对路径（不编一个主机）', toDebugRequests(d, '').every((r) => r.url.startsWith('/')))
}

console.log('\n=== ⑤ PH3-BE-09 后端错误进统一问题模型 ===')
{
  const log = [
    'server listening on 8080',
    'Error: 连接池已耗尽 at pool.mbt:42',
    '    at handleRequest (server.js:118)',
    'FATAL panic: index out of range main.mbt:7',
    'GET /users 200',
    'panic: nil pointer',
  ].join('\n')
  const ps = errorsToProblems(log)
  chk('★ 抓到了错误行', ps.length >= 3, String(ps.length))
  chk('全部标为 runtime 来源', ps.every((p) => p.source === 'runtime'))
  chk('★ FATAL/panic 标 ERROR', ps.some((p) => /panic/.test(p.message) && p.severity === 'error'), JSON.stringify(ps.map((p) => p.severity)))
  chk('  普通 error 标 warning', ps.some((p) => p.severity === 'warning'))

  const withFile = ps.find((p) => p.file && p.line)
  chk('★ 从 `file:line` 取出文件与行号', !!withFile, JSON.stringify(ps.map((p) => p.file)))
  const noFile = ps.find((p) => /panic: nil pointer/.test(p.message))
  eq('★ 取不到文件就留 null（不编一个）', noFile.file, null)
  eq('  行号也 null', noFile.line, null)

  chk('正常行不误报', !ps.some((p) => /server listening/.test(p.message)))
  chk('请求日志不误报', !ps.some((p) => /GET \/users 200/.test(p.message)))
  chk('max 生效', errorsToProblems(log, { max: 1 }).length === 1)
  chk('标记来自后端日志', ps[0].backend === true)
  chk('正则本身认得典型错误', LOG_ERROR_RE.test('Error: x') && LOG_ERROR_RE.test('    at foo (a.js:1)') && !LOG_ERROR_RE.test('all good'))
}

console.log('\n=== ⑥ PH3-BE-11 健康 → Quality（三态要分清）===')
{
  const pass = healthToQuality({ ok: true, url: 'http://127.0.0.1:8080/health', latencyMs: 12 })
  eq('★ 健康 → PASS', pass.state, 'PASS')
  chk('  说明带 URL 与耗时', /8080/.test(pass.detail) && /12ms/.test(pass.detail), pass.detail)
  eq('  passed 计数', pass.passed, 1)

  const fail = healthToQuality({ ok: false, url: 'http://127.0.0.1:8080/health', error: '连不上' })
  eq('★ 探测了但不健康 → FAIL', fail.state, 'FAIL')
  eq('  failed 计数', fail.failed, 1)
  chk('  原因带出来', /连不上/.test(fail.detail), fail.detail)

  const notRun = healthToQuality({ ok: false, probed: false })
  eq('★★ 没探测 → NOT_RUN（不是 FAIL）', notRun.state, 'NOT_RUN')
  chk('  ★ 且说明"不是不健康"', /不是"不健康"/.test(notRun.detail), notRun.detail)

  chk('name 可覆盖', healthToQuality({ ok: true, url: 'u' }, { name: '我的后端' }).name === '我的后端')
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
