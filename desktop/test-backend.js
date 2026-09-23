// 后端控制的自动化验证：模拟 IPC 调用 backend.js 的真实流程
const path = require('path')
const http = require('http')
const { registerBackendIpc } = require('./backend')

const handlers = {}
const events = []
const fakeIpc = {
  handle: (ch, fn) => { handlers[ch] = fn },
  on: (ch, fn) => { handlers['on:' + ch] = fn },
}
const logs = []
registerBackendIpc({
  ipcMain: fakeIpc,
  getWindow: () => ({ isDestroyed: () => false, webContents: { send: (ch, p) => {
    if (ch === 'backend:log') logs.push(p.line)
    else events.push(p)
  } } }),
  DEFAULT_CWD: path.join(__dirname, '..'),
})

function get(url) {
  return new Promise((res) => {
    const r = http.get(url, { timeout: 5000 }, (x) => {
      let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res({ status: x.statusCode, body: b }))
    })
    r.on('error', (e) => res({ status: 0, body: e.message }))
    r.on('timeout', () => { r.destroy(); res({ status: 0, body: 'timeout' }) })
  })
}

;(async () => {
  let pass = 0, fail = 0
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  [PASS] ${name}`) }
    else { fail++; console.log(`  [FAIL] ${name}  ${detail}`) }
  }

  console.log('=== ① 依赖检查 ===')
  const deps = await handlers['backend:deps']()
  console.log('   ', JSON.stringify(deps))
  check('检测到 docker', deps.docker === true)
  check('PostgreSQL 容器在运行', deps.pg === true)

  console.log('\n=== ② 启动前状态 ===')
  const st0 = await handlers['backend:status']({}, { port: 8121 })
  check('初始为未运行', st0.running === false)
  check('能找到二进制', !!st0.binary, `binary=${st0.binary}`)

  console.log('\n=== ③ 启动后端（IDE 里点「启动后端」等价于这一步）===')
  const r = await handlers['backend:start']({}, { port: 8121, cwd: path.join(__dirname, '..') })
  console.log('    返回:', JSON.stringify(r))
  check('启动成功', r.ok === true, r.error || '')
  check('拿到健康检查结果', r.health === 'ok', `health=${r.health}`)
  check('拿到 PID', typeof r.pid === 'number')

  console.log('\n=== ④ 服务真的在提供 API 吗 ===')
  const tags = await get('http://127.0.0.1:8121/api/tags')
  check('GET /api/tags 返回 200', tags.status === 200, `status=${tags.status}`)
  check('返回合法 JSON', (() => { try { return Array.isArray(JSON.parse(tags.body).tags) } catch { return false } })())
  const health = await get('http://127.0.0.1:8121/health')
  check('GET /health 返回 ok', health.body.trim() === 'ok')

  console.log('\n=== ⑤ 运行中状态查询 ===')
  const st1 = await handlers['backend:status']({}, { port: 8121 })
  check('状态为运行中', st1.running === true)
  check('健康检查为真', st1.healthy === true)
  check('PID 与启动时一致', st1.pid === r.pid, `${st1.pid} vs ${r.pid}`)

  console.log('\n=== ⑥ 重复启动应被拒绝（避免多实例）===')
  const r2 = await handlers['backend:start']({}, { port: 8121, cwd: path.join(__dirname, '..') })
  check('重复启动被拒', r2.ok === false, JSON.stringify(r2))

  console.log('\n=== ⑦ 停止 ===')
  const rs = await handlers['backend:stop']()
  check('停止返回 ok', rs.ok === true)
  await new Promise((res) => setTimeout(res, 2500))
  const st2 = await handlers['backend:status']({}, { port: 8121 })
  check('状态回到未运行', st2.running === false, JSON.stringify(st2))
  const after = await get('http://127.0.0.1:8121/health')
  check('端口不再响应', after.status === 0, `status=${after.status}`)

  console.log('\n=== ⑧ 日志是否被推送到界面 ===')
  check('收到了日志行', logs.length > 0, `共 ${logs.length} 行`)
  console.log('    日志样例：')
  logs.slice(0, 6).forEach((l) => console.log('      ' + l))
  check('日志含启动信息', logs.some((l) => /listening|start|二进制/.test(l)))

  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
  process.exit(fail ? 1 : 0)
})()
