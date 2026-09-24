// 验证「运行项目 → 看到运行效果」这条链路（用户对「完整 IDE」的标准）：
//   · IDE 能列出可运行的入口（runnerList）
//   · 点运行后能跑起来
//   · 能从输出里抓到本地 URL（runner:url 事件）—— 抓到才会自动开浏览器
//   · 那个地址真的能访问（服务确实起来了）
//   · 停得掉
//
// 靶子用 desktop/testdata/fixture-http-server.js（**零依赖 Node 服务、端口由系统分配**），
// 而不是 MoonBit 的 hello/。原因：
//   这条链路要验的是「IDE 的 Electron 集成」，不该被「本机 MoonBit native 工具链是否可用」绑住 ——
//   本机 `moon build --target native` 当前是坏的（EXIT=127，红灯 R12），
//   拿 hello 当靶子会让这个测试**永远是红的**，从而掩盖真正的 Run 链路回归。
// ①（入口识别）仍用真实的 moonbit-platform 目录 —— 那一步只扫文件，不依赖构建。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')          // moonbit-platform 根
const FIXTURE = path.join(__dirname, 'testdata', 'fixture-http-server.js')
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
  // P19：类型防护 —— 传非布尔（数组/对象）说明用错了函数，必须当场失败
const chk = (n, ok, d) => {
  if (typeof ok !== 'boolean') { fail++; log('  [FAIL] ' + n + '   chk 只接受布尔（数组/对象比较请用 eq）：' + JSON.stringify(ok)); return }
  if (ok) { pass++; log('  [PASS] ' + n) } else { fail++; log('  [FAIL] ' + n + '  ' + (d || '')) }
}

  log('\n=== ① IDE 能列出可运行入口 ===')
  const listed = JSON.parse(await js(`(async () => JSON.stringify(await window.moonAPI.runnerList(${JSON.stringify(ROOT)})))()`))
  // 注意返回的是 { ok, kind, runners: [...] }，字段名是 runners（不是 items）
  const arr = (listed && listed.runners) || []
  log('   共 ' + arr.length + ' 个入口；样例：' + JSON.stringify(arr.slice(0, 2)))
  chk('列出了可运行入口', arr.length > 0, '数量 ' + arr.length)

  log('\n=== ② 运行零依赖靶子，并从输出里抓到本地 URL ===')
  // 先挂上监听，再运行（避免事件早于监听）
  const res = JSON.parse(await js(`(async () => {
    return await new Promise((resolve) => {
      let got = null, chunks = 0
      const urlOff = window.moonAPI.onRunnerUrl((p) => { got = p && p.url })
      window.moonAPI.onRunnerData(() => { chunks++ })
      window.moonAPI.runnerRun(${JSON.stringify({
        bin: 'node', args: [FIXTURE], cwd: ROOT, label: 'fixture（零依赖靶子）',
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
  // 端口不写死：fixture 用系统分配的端口（写死端口会在并发/占用时假失败）
  chk('运行后抓到了本地 URL（IDE 据此自动开浏览器）', !!res.url && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(res.url)), JSON.stringify(res))
  chk('运行过程中收到了输出流', res.chunks > 0, 'chunks=' + res.chunks)

  // 抓到的 URL 是否真能访问（说明服务确实起来了）
  log('\n=== ③ 那个地址真的能访问（服务确实起来了）===')
  let body = ''
  let fetchErr = ''
  try {
    const r = await js(`(async () => { const r = await fetch(${JSON.stringify(res.url || 'http://127.0.0.1:1/')}); return (await r.text()).slice(0, 300) })()`)
    body = String(r || '')
  } catch (e) { fetchErr = String((e && e.message) || e) }
  log('   返回片段：' + JSON.stringify(body.slice(0, 120)) + (fetchErr ? '  fetchErr=' + fetchErr : ''))
  // 严格断言：必须真的拿到靶子页面内容（不能只要「有返回」就算过 —— 那样 ERR 字符串也会蒙混过关）
  chk('页面能打开且内容正确', /fixture ok/.test(body) && !fetchErr, body.slice(0, 80) + ' ' + fetchErr)

  log('\n=== ④ 收尾：停掉服务 ===')
  let stopRes = null
  let stopErr = ''
  try {
    stopRes = await js(`(async () => JSON.stringify(await window.moonAPI.runnerStop()))()`)
  } catch (e) { stopErr = String((e && e.message) || e) }
  log('   runnerStop() → ' + stopRes + (stopErr ? '  err=' + stopErr : ''))
  // 等它真的停下（最多 8 秒）——「点了停止」不等于「进程没了」
  let gone = false
  if (res.url) {
    for (let i = 0; i < 32; i++) {
      await new Promise((r) => setTimeout(r, 250))
      try {
        await fetch(res.url, { signal: AbortSignal.timeout(400) })
      } catch (_) { gone = true; break }
    }
  }
  chk('停止后端口不再可连（进程真的结束了）', gone, String(res.url))
  log('   已停止')

  log('\n结果：' + pass + ' 通过, ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  dump(fail === 0 ? 0 : 1)
}).catch((e) => { log('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
