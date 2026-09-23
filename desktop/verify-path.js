// 验证：在「PATH 不含 ~/.moon/bin」的环境下（模拟桌面快捷方式启动），
// main.js 的 PATH 修补是否让 spawn('moon') 可用。
//
// 这解决的是用户报告的核心问题：任何项目都运行不起来。
require('./main.js')
const { app } = require('electron')
const { spawnSync } = require('child_process')

app.whenReady().then(() => {
  const p = process.env.PATH || ''
  const hasMoon = p.toLowerCase().includes('.moon')
  console.log('  主进程 PATH 含 .moon/bin: ' + (hasMoon ? '是 ✅（修补生效）' : '否 ❌'))
  const r = spawnSync('moon', ['version'], { encoding: 'utf8', shell: false })
  if (r.error) console.log('  spawn(moon): ❌ ' + r.error.code + ' —— 运行项目仍会失败')
  else console.log('  spawn(moon): ✅ ' + String(r.stdout || '').trim().split('\n')[0].slice(0, 50))
  app.exit(0)
})
