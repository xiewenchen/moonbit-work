// 验证工具标签真的渲染出了内容（而不是仍为空 div）。
require('./main.js')
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 3500))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.error('没拿到窗口'); app.exit(1); return }
  const r = await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('mainview-tools')
    if (!el) return { err: '找不到 mainview-tools' }
    const cards = el.querySelectorAll('.tv-card')
    const names = [...cards].map((c) => (c.querySelector('.tv-t') || {}).textContent)
    // 顺带确认第三标签的显示名（旧文案是否还在）
    const agent = document.querySelector('[data-view="agent"]')
    return {
      childCount: el.children.length,
      cards: cards.length,
      names,
      agentLabel: agent ? agent.getAttribute('aria-label') : null,
      // 工具标签的标题文本
      head: (el.querySelector('.tv-head') || {}).textContent || '',
    }
  })()`)
  console.log('')
  if (r.err) console.log('  ❌ ' + r.err)
  else {
    console.log('  mainview-tools 子元素: ' + r.childCount + '（不再是 0）')
    console.log('  工具卡数量: ' + r.cards)
    console.log('  卡片名: ' + JSON.stringify(r.names))
    console.log('  标题: ' + JSON.stringify(r.head))
    console.log('  第三标签显示名: ' + JSON.stringify(r.agentLabel))
    console.log('')
    console.log('  ' + (r.cards > 0 ? '✅ 工具标签已填充' : '❌ 工具标签仍为空'))
  }
  app.exit(0)
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
