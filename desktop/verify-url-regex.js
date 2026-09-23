// 验证 URL 抓取正则：用 Strapi 的真实输出样本（含 ANSI 色码）测试，
// 并覆盖「URL 被 chunk 切成两段」这个真实情况（日志流是分块到达的）。
const RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s'"<>)]*/i
// 与 runners.js 一致的预处理：先剥离 ANSI 色码
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

const strapiSample =
  'Welcome back!\n' +
  'To access the server \u26a1\ufe0f, go to:\n' +
  'http://localhost:1337\n' +
  '[2026-09-23 16:34:22.227] info: Strapi started successfully'

const cases = [
  ['Strapi 真实输出', strapiSample, 'http://localhost:1337'],
  ['带 ANSI 色码', '\u001b[32mhttp://localhost:1337/admin\u001b[39m', 'http://localhost:1337/admin'],
  ['127.0.0.1 形式', 'listening on http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
  ['Vite 风格', '  Local:   http://localhost:5173/', 'http://localhost:5173/'],
  ['句末带句号', 'Server ready at http://localhost:3000.', 'http://localhost:3000'],
  ['无端口', 'open http://localhost now', 'http://localhost'],
  ['非本地地址（不该匹配）', 'visit https://example.com/api', null],
]

let pass = 0, fail = 0
for (const [name, input, want] of cases) {
  const m = stripAnsi(input).match(RE)
  const got = m ? m[0].replace(/[.,;:]+$/, '') : null
  const ok = got === want
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(18) + ' → ' + JSON.stringify(got) + (ok ? '' : '  期望 ' + JSON.stringify(want)))
  ok ? pass++ : fail++
}

// 分块到达：URL 被切成 "http://local" + "host:1337"
{
  let buf = ''
  const chunks = ['Welcome!\nhttp://local', 'host:1337\n[info] started']
  let found = null
  for (const c of chunks) {
    buf = (buf + stripAnsi(c)).slice(-2048)
    const m = buf.match(RE)
    if (m) { found = m[0]; break }
  }
  const ok = found === 'http://localhost:1337'
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + '跨 chunk 分割'.padEnd(16) + ' → ' + JSON.stringify(found))
  ok ? pass++ : fail++
}

console.log('\n  结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
