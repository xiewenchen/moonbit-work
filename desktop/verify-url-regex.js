// 验证 URL 抓取：Strapi 的真实输出样本（含 ANSI 色码）+ 跨 chunk 场景。
//
// 注意：正则与 ANSI 剥离**不再本地复制** —— 统一来自 url-detect.js（单一实现）。
// 之前这里是第二份副本，两份容易漂移；现在由 test-url-detect.js 的契约断言锁住「只有一处实现」。
const { detectUrl, createUrlScanner } = require('./url-detect')

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
  const got = detectUrl(input)
  const ok = got === want
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(18) + ' → ' + JSON.stringify(got) + (ok ? '' : '  期望 ' + JSON.stringify(want)))
  ok ? pass++ : fail++
}

// 分块到达：URL 被切成 "http://local" + "host:1337"
{
  const s = createUrlScanner()
  const chunks = ['Welcome!\nhttp://local', 'host:1337\n[info] started']
  let found = null
  for (const c of chunks) {
    const hit = s.push(c)
    if (hit) { found = hit.url; break }
  }
  const ok = found === 'http://localhost:1337'
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + '跨 chunk 分割'.padEnd(16) + ' → ' + JSON.stringify(found))
  ok ? pass++ : fail++
}

console.log('\n  结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
