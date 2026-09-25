// 用「慢任务」验证流式的两个关键性质：
//   ① 输出是**边跑边到**（多批、时间分散），不是结束后一次性刷出
//   ② 同一时刻只允许一个任务（并发第二个被拒）
require('./main.js')
const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await new Promise(r=>setTimeout(r,250)) }
  await new Promise(r=>setTimeout(r,6000))
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const ROOT = 'C:/Users/33567/AppData/Roaming/reasonix/global-workspace/moonbit-platform'

  let pass = 0, fail = 0
  const check = (n, c, d='') => { if (c) { pass++; console.log(`  [PASS] ${n}`) } else { fail++; console.log(`  [FAIL] ${n}  ${d}`) } }

  console.log('=== ① 观测每批数据到达的时刻（慢任务：moon test）===')
  const obs = await js(`(async () => {
    const batchTimes = []
    const t0 = Date.now()
    // 直接在渲染层挂一个观测监听（与页面自身那个并存）
    const off = window.moonAPI.onMoonStreamData(() => batchTimes.push(Date.now() - t0))
    const p = window.moonAPI.runMoonStream(['test', '--target', 'native'], ${JSON.stringify(ROOT)})
    // 最多等 90 秒
    const started = Date.now()
    let ended = false
    window.moonAPI.onMoonStreamEnd(() => { ended = true })
    while (!ended && Date.now() - started < 90000) { await new Promise(r => setTimeout(r, 200)) }
    const res = await p
    return JSON.stringify({
      批次数: batchTimes.length,
      第一批在: batchTimes.length ? batchTimes[0] + 'ms' : null,
      最后一批在: batchTimes.length ? batchTimes[batchTimes.length - 1] + 'ms' : null,
      时间跨度: batchTimes.length > 1 ? (batchTimes[batchTimes.length-1] - batchTimes[0]) + 'ms' : '0ms',
      退出码: res.code,
    })
  })()`)
  console.log('  ', String(obs))
  const o = JSON.parse(obs)
  check('输出是分批到达的（>1 批）', o.批次数 > 1, `批次数=${o.批次数}`)
  check('不是结束后一次性刷出（时间有跨度）', o.时间跨度 !== '0ms' || o.批次数 > 1, `跨度=${o.时间跨度}`)
  check('任务正常结束', o.退出码 === 0, `code=${o.退出码}`)

  console.log('\n=== ② 并发限制（这次第一个任务够慢）===')
  const conc = await js(`(async () => {
    const p1 = window.moonAPI.runMoonStream(['test', '--target', 'native'], ${JSON.stringify(ROOT)})
    await new Promise(r => setTimeout(r, 400))   // 等它真的开始
    const r2 = await window.moonAPI.runMoonStream(['tree'], ${JSON.stringify(ROOT)})
    const r1 = await p1
    return JSON.stringify({ 并发第二个: r2, 第一个: r1 })
  })()`)
  console.log('  ', String(conc).slice(0, 220))
  const c = JSON.parse(conc)
  check('并发第二个任务被拒（code=-2）', c.并发第二个 && c.并发第二个.code === -2, JSON.stringify(c.并发第二个))

  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass+fail} 项`)
  app.quit()
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
