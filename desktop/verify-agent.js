// 验证 AI Agent 后端链路：agent:status → agent:run → 流式事件解析 → 拿到文本。
// 这是「面板能不能干活」的底层前提。
require('./main.js')
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 3000))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.error('没拿到窗口'); app.exit(1); return }

  const r = await win.webContents.executeJavaScript(`(async () => {
    const st = await window.moonAPI.agentStatus()
    const got = []
    window.moonAPI.onAgentStart((p) => got.push({ t: 'start', v: p && p.prompt }))
    window.moonAPI.onAgentData((p) => got.push(p))
    window.moonAPI.onAgentEnd((p) => got.push({ t: 'end', v: p }))
    const run = await window.moonAPI.agentRun({
      prompt: 'Reply with exactly one word: ok',
      cwd: 'C:/Users/33567/AppData/Roaming/reasonix/global-workspace/moonbit-platform',
    })
    // 轮询等待结束事件（最多 90 秒）
    let waited = 0
    while (!got.some((x) => x.t === 'end') && waited < 90000) {
      await new Promise((res) => setTimeout(res, 1000)); waited += 1000
    }
    return { status: st, run, events: got }
  })()`)

  const st = r.status || {}
  console.log('\n  === status ===')
  console.log('  已安装: ' + st.installed + '   版本: ' + st.version)
  console.log('  可执行: ' + st.bin)
  console.log('  配置:   ' + st.configPath + '（存在: ' + st.configExists + '）')
  console.log('\n  === run 结果 ===')
  console.log('  启动: ' + JSON.stringify(r.run))
  const texts = (r.events || []).filter((e) => e.type === 'text')
  const metas = (r.events || []).filter((e) => e.type === 'meta')
  const errs = (r.events || []).filter((e) => e.type === 'error')
  console.log('  收到事件: ' + (r.events || []).length + ' 个（text ' + texts.length + ' / meta ' + metas.length + ' / error ' + errs.length + '）')
  for (const t of texts) console.log('    [文本] ' + JSON.stringify(t.text).slice(0, 120))
  for (const m of metas) console.log('    [用量] tokens=' + JSON.stringify(m.tokens) + ' cost=' + m.cost)
  for (const e of errs) console.log('    [错误] ' + String(e.text).slice(0, 200))
  const ended = (r.events || []).find((x) => x.t === 'end')
  if (ended) console.log('  结束: ' + JSON.stringify(ended.v))
  console.log('\n  ' + (texts.length ? '✅ 后端链路通 —— agent 返回了文本' : '❌ 没拿到文本'))
  app.exit(0)
}).catch((e) => { log('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
