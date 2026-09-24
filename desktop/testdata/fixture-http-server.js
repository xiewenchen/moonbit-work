// Run E2E 的靶子服务（Phase 2 / P1-19 前置）
//
// 零依赖、端口由系统分配（避免 CI 上端口冲突）。
// 启动后按 IDE 的口径打印一行本地 URL —— URL detector 就是靠这一行抓地址的。
//
// 环境变量 FIXTURE_SPLIT=1 时，把这一行**拆成三次 write**，用来验证「URL 被 chunk 边界截断」
// 这条真实路径（日志流本来就是分块到达的）。
const http = require('http')

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset="utf-8"><title>MoonBit 后端平台 fixture</title><h1>fixture ok</h1>')
})

srv.listen(0, '127.0.0.1', () => {
  const { port } = srv.address()
  const line = `Server at http://127.0.0.1:${port}`   // ← 格式不要改：URL detector 认这行
  if (process.env.FIXTURE_SPLIT === '1') {
    process.stdout.write(line.slice(0, 12))
    setTimeout(() => {
      process.stdout.write(line.slice(12, 22))
      setTimeout(() => process.stdout.write(line.slice(22) + '\n'), 40)
    }, 40)
  } else {
    process.stdout.write(line + '\n')
  }
})

const bye = () => { srv.close(() => process.exit(0)) }
process.on('SIGTERM', bye)
process.on('SIGINT', bye)
