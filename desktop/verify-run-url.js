// 验证「运行项目 → 看到运行效果」这条链路（用户对"完整 IDE"的标准）：
//   · IDE 能列出可运行的入口（runnerList）
//   · 点运行后能跑起来
//   · 能从输出里抓到本地 URL（runner:url 事件）—— 抓到才会自动开浏览器
// 靶子用 hello/（零依赖），避免像 demo/ 那样卡在等 PG + Redis。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')          // moonbit-platform 根
const OUT = path.join(__dirname, 'run-url-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
function dump(code) { try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (_) {} ; setTimeout(() => app.exit(code), 500) }

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await new Promise((r) => setTimeout(r, 250)) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  await new Promise((r) => setTimeout(r, 3000))

  let pass = 0, fail = 0
  const chk = (n, ok, d) => { if (ok) { pass++; log('  [PASS] ' + n) } else { fail++; log('  [FAIL] ' + n + '  ' + (d || '')) } }

  log('\n=== ① IDE 能列出可运行入口 ===')
  const listed = JSON.parse(await js(`(async () => JSON.stringify(await window.moonAPI.runnerList(${JSON.stringify(ROOT)})))()`))
  // 注意返回的是 { ok, kind, runners: [...] }，字段名是 runners（不是 items）
  const arr = (listed && listed.runners) || []
  log('   共 ' + arr.length + ' 个入口；含 hello 的：' + JSON.stringify(arr.filter((x) => JSON.stringify(x).toLowerCase().includes('hello')).slice(0, 2)))
  const hello = arr.find((x) => JSON.stringify(x).toLowerCase().includes('hello'))
  chk('列出了可运行入口', arr.length > 0, '数量 ' + arr.length)
  chk('其中能找到 hello 示例', !!hello, JSON.stringify(arr.slice(0, 3)))

  if (!hello) { log('\n结果：' + pass + ' 通过, ' + fail + ' 失败'); return dump(1) }

  log('\n=== ② 运行它，并从输出里抓到本地 URL ===')
  // 先挂上监听，再运行（避免事件早于监听）
  const res = JSON.parse(await js(`(async () => {
    return await new Promise((resolve) => {
      let got = null, chunks = 0
      const urlOff = window.moonAPI.onRunnerUrl((p) => { got = p && p.url })
      window.moonAPI.onRunnerData(() => { chunks++ })
      window.moonAPI.runnerRun(${JSON.stringify({
        bin: hello.bin, args: hello.args, cwd: hello.cwd || ROOT, label: hello.label || 'hello',
      })})
      const t0 = Date.now()
      const tick = setInterval(() => {
        if (got || Date.now() - t0 > 25000) {
          clearInterval(tick)
          try { urlOff && urlOff() } catch (_) {}
          // 先**不要**停服务 —— 下一节要访问它，停掉就成了假验证（踩过）
          resolve(JSON.stringify({ url: got, chunks, waited: Date.now() - t0 }))
        }
      }, 300)
    })
  })()`))
  log('   ' + JSON.stringify(res))
  chk('运行后抓到了本地 URL（IDE 据此自动开浏览器）', !!res.url && /127\.0\.0\.1:8123|localhost:8123/.test(res.url), JSON.stringify(res))
  chk('运行过程中收到了输出流', res.chunks > 0, 'chunks=' + res.chunks)

  // 抓到的 URL 是否真能访问（说明服务确实起来了）
  log('\n=== ③ 那个地址真的能访问（服务确实起来了）===')
  let body = ''
  let fetchErr = ''
  try {
    const r = await js(`(async () => { const r = await fetch(${JSON.stringify(res.url || 'http://127.0.0.1:8123/')}); return (await r.text()).slice(0, 300) })()`)
    body = String(r || '')
  } catch (e) { fetchErr = String((e && e.message) || e) }
  log('   返回片段：' + JSON.stringify(body.slice(0, 120)) + (fetchErr ? '  fetchErr=' + fetchErr : ''))
  // 严格断言：必须真的拿到页面内容（不能只要“有返回”就算过 —— 那样 ERR 字符串也会蒙混过关）
  chk('页面能打开且内容正确', /MoonBit 后端平台/.test(body) && !fetchErr, body.slice(0, 80) + ' ' + fetchErr)

  log('\n=== ④ 收尾：停掉服务 ===')
  try { await js(`(() => window.moonAPI.runnerStop())()`) } catch (_) {}
  log('   已停止')

  log('\n结果：' + pass + ' 通过, ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  dump(fail === 0 ? 0 : 1)
})
