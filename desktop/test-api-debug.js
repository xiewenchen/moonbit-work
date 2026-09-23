// 接口调试器的自动化验证：解析端点 → 真实发请求 → 登录自动拿 token → 调受保护接口
const path = require('path')
const { registerApiDebugIpc, parseOpenApiEndpoints } = require('./api-debug')

const handlers = {}
registerApiDebugIpc({
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
  DEFAULT_CWD: path.join(__dirname, '..'),
})

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}  ${detail}`) }
}
const BASE = 'http://127.0.0.1:8110'

;(async () => {
  console.log('=== ① 从 openapi.yml 解析端点 ===')
  const r = await handlers['apidbg:endpoints'](null)
  check('解析成功', r.ok === true, r.error || '')
  check('端点数 = 19', r.endpoints.length === 19, `实际 ${r.endpoints.length}`)
  const methods = {}
  for (const e of r.endpoints) methods[e.method] = (methods[e.method] || 0) + 1
  console.log('    方法分布:', JSON.stringify(methods))
  check('含 GET/POST/PUT/DELETE',
    methods.GET > 0 && methods.POST > 0 && methods.PUT > 0 && methods.DELETE > 0)
  const login = r.endpoints.find((e) => e.path === '/users/login' && e.method === 'POST')
  check('能找到登录端点', !!login)
  check('登录端点带请求体模板', !!(r.bodies['POST /users/login'] || '').includes('user'),
        JSON.stringify(r.bodies['POST /users/login'] || '').slice(0, 60))

  console.log('\n=== ② 公开接口（无需 token）===')
  let res = await handlers['apidbg:send'](null, { baseUrl: BASE, method: 'GET', path: '/api/tags' })
  check('GET /api/tags → 200', res.status === 200, JSON.stringify(res).slice(0, 120))
  check('返回合法 JSON', (() => { try { return Array.isArray(JSON.parse(res.body).tags) } catch { return false } })())
  check('带耗时信息', typeof res.ms === 'number' && res.ms >= 0, `ms=${res.ms}`)

  console.log('\n=== ③ 注册 → 自动拿 token ===')
  const stamp = String(Date.now()).slice(-9)
  const regBody = JSON.stringify({ user: { username: 'ad' + stamp, email: `ad${stamp}@t.com`, password: 'password123' } })
  res = await handlers['apidbg:send'](null, { baseUrl: BASE, method: 'POST', path: '/api/users', body: regBody })
  check('POST /api/users → 201', res.status === 201, `status=${res.status} body=${(res.body || '').slice(0, 120)}`)
  let token = ''
  try { token = JSON.parse(res.body).user.token } catch (_) {}
  check('响应含 user.token（界面据此自动填入）', !!token)

  console.log('\n=== ④ 用 token 调受保护接口 ===')
  res = await handlers['apidbg:send'](null, { baseUrl: BASE, method: 'GET', path: '/api/user', token })
  check('GET /api/user（带 token）→ 200', res.status === 200, `status=${res.status}`)
  res = await handlers['apidbg:send'](null, { baseUrl: BASE, method: 'GET', path: '/api/user' })
  check('GET /api/user（不带 token）→ 401', res.status === 401, `status=${res.status}`)

  console.log('\n=== ⑤ 创建文章 → 验证响应 ===')
  const artBody = JSON.stringify({ article: { title: 'IDE 调试器的文章 ' + stamp, description: 'd', body: 'b', tagList: ['ide'] } })
  res = await handlers['apidbg:send'](null, { baseUrl: BASE, method: 'POST', path: '/api/articles', token, body: artBody })
  check('POST /api/articles → 201', res.status === 201, `status=${res.status}`)
  let slug = ''
  try { slug = JSON.parse(res.body).article.slug } catch (_) {}
  check('返回 slug', !!slug, `slug=${slug}`)
  res = await handlers['apidbg:send'](null, { baseUrl: BASE, method: 'GET', path: '/api/articles/' + encodeURIComponent(slug) })
  check('按 slug 取回 → 200', res.status === 200, `status=${res.status}`)

  console.log('\n=== ⑥ 错误路径也要能看清原因（调试价值）===')
  res = await handlers['apidbg:send'](null, { baseUrl: BASE, method: 'GET', path: '/api/articles/does-not-exist' })
  check('404 并返回错误体', res.status === 404 && (res.body || '').includes('not found'),
        `status=${res.status} body=${(res.body || '').slice(0, 80)}`)
  res = await handlers['apidbg:send'](null, { baseUrl: 'http://127.0.0.1:59999', method: 'GET', path: '/health' })
  check('连不上时给出可读错误', !!res.error, JSON.stringify(res).slice(0, 100))

  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
  process.exit(fail ? 1 : 0)
})()
