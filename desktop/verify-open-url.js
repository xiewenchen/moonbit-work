// 验证「点运行 → 服务起来 → 自动打开网站」这条链路。
// 关注点只有一个：主进程是否从运行输出里抓到了本地 URL（并据此调用了 openExternal）。
require('./main.js')
const { app, BrowserWindow } = require('electron')

const ROOT = process.argv[2]
if (!ROOT) { console.error('用法: electron verify-open-url.js <项目目录>'); process.exit(1) }

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 3000))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.error('没拿到窗口'); app.exit(1); return }

  const r = await win.webContents.executeJavaScript(`(async () => {
    const list = await window.moonAPI.runnerList(${JSON.stringify(ROOT)})
    if (!list || !list.ok) return { err: '入口识别失败' }
    const spec = list.runners[0]
    const urls = []
    window.moonAPI.onRunnerUrl((p) => urls.push(p && p.url))
    const t0 = Date.now()
    await window.moonAPI.runnerRun(spec)
    // 轮询等待 URL 出现（最多 90 秒），出现即记录耗时
    let waited = 0
    while (!urls.length && waited < 90000) {
      await new Promise((res) => setTimeout(res, 1000))
      waited += 1000
    }
    const elapsed = Date.now() - t0
    await window.moonAPI.runnerStop()
    return { picked: spec.label, urls, elapsed }
  })()`)

  console.log('\n  === 结果 ===')
  if (r && r.err) console.log('  ❌ ' + r.err)
  else {
    console.log('  运行目标: ' + r.picked)
    console.log('  抓到 URL: ' + (r.urls && r.urls.length ? r.urls.join(', ') : '(未抓到)'))
    console.log('  耗时: ' + Math.round((r.elapsed || 0) / 1000) + ' 秒')
    console.log('  ' + (r.urls && r.urls.length ? '✅ 链路通 —— 点运行会自动打开网站' : '❌ 没抓到 URL'))
  }
  app.exit(0)
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
