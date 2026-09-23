// 验证 AI Agent（第 5 个标签）：
//   · 左侧导航有 5 项，且有 data-view="ai"
//   · 切到 ai 标签后本标签可见、其它标签隐藏
//   · 对话区 / 输入框 / 发送按钮 / 状态行都在
//   · 默认真发一条 prompt，断言收到并显示了流式回复正文（--ui-only 可跳过）
//
// 结果同时写到 stdout 与 desktop/agent-verify-result.txt
// —— Electron 的 app.exit() 会抢在 stdout flush 之前退出，只靠控制台会丢日志。
//
// 运行：cd desktop && ./node_modules/.bin/electron verify-agent-ui.js [--ui-only]
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

// 默认就做一次真实发送；加 --ui-only 时只验证界面结构（不调模型）
const SEND = !process.argv.includes('--ui-only') && process.env.AGENT_UI_ONLY !== '1'
const PROMPT = 'Reply with a single word: pong'
const RESULT = path.join(__dirname, 'agent-verify-result.txt')

const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
function dump(code) {
  try { fs.writeFileSync(RESULT, lines.join('\n') + '\n', 'utf8') } catch (_) {}
  setTimeout(() => app.exit(code), 500) // 给 stdout flush 留时间
}

app.whenReady().then(async () => {
  process.on('uncaughtException', (e) => { log('  [crash] uncaughtException: ' + ((e && e.stack) || e)) })
  process.on('unhandledRejection', (e) => { log('  [crash] unhandledRejection: ' + ((e && e.stack) || e)) })
  app.on('child-process-gone', (_e, d) => { log('  [crash] child-process-gone: ' + JSON.stringify(d)) })
  app.on('before-quit', () => { log('  [life] before-quit') })
  app.on('will-quit', () => { log('  [life] will-quit') })
  let win = null
  for (let i = 0; i < 40; i++) {
    win = BrowserWindow.getAllWindows()[0] || null
    if (win) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!win) { log('没拿到窗口'); return dump(1) }
  await new Promise((r) => setTimeout(r, 3000))
  try { win.webContents.on('render-process-gone', (_e, d) => { log('  [crash] renderer gone: ' + JSON.stringify(d)) }) } catch (_) {}
  win.on('close', () => { log('  [life] win close 事件'); try { fs.writeFileSync(RESULT, lines.join('\n') + '\n', 'utf8') } catch (_) {} })
  win.on('closed', () => { log('  [life] win closed'); try { fs.writeFileSync(RESULT, lines.join('\n') + '\n', 'utf8') } catch (_) {} })
  log('  [debug] SEND=' + SEND + ' argv=' + JSON.stringify(process.argv.slice(1)))

  // 1) 切到 AI Agent 标签
  try {
    await win.webContents.executeJavaScript(
      `(() => { const a = document.querySelector('a[data-view="ai"]'); if (a) a.click(); })()`)
  } catch (e) { log('  [debug] 切换标签失败: ' + e.message) }
  await new Promise((r) => setTimeout(r, 500))

  const r = await win.webContents.executeJavaScript(`(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return '不存在'
      const cs = getComputedStyle(el)
      return (cs.display !== 'none' && cs.visibility !== 'hidden') ? '可见' : '隐藏'
    }
    return {
      navCount: document.querySelectorAll('a[data-view]').length,
      navHasAi: !!document.querySelector('a[data-view="ai"]'),
      aiView: vis('#mainview-ai'),
      homeView: vis('#mainview-home'),
      agentView: vis('#mainview-agent'),
      log: vis('#agLog'),
      input: vis('#agInput'),
      sendBtn: vis('#agSend'),
      emptyHint: !!document.querySelector('#agLog .ag-empty'),
      status: (document.getElementById('agStatus') || {}).textContent || '',
    }
  })()`)

  log('\n  === AI Agent 标签 ===')
  for (const [k, v] of Object.entries(r)) log('  ' + k.padEnd(11) + ': ' + v)
  const okUi =
    r.navCount === 5 && r.navHasAi &&
    r.aiView === '可见' && r.homeView === '隐藏' && r.agentView === '隐藏' &&
    r.log === '可见' && r.input === '可见' && r.sendBtn === '可见' &&
    r.emptyHint && r.status.trim().length > 0
  log('\n  ' + (okUi ? '✅ UI 结构完整：5 个导航项，切到 ai 后其余标签隐藏，控件齐全' : '❌ UI 结构不对'))

  let okSend = true
  if (SEND) {
    try {
      const clicked = await win.webContents.executeJavaScript(
        `(() => {
           const t = document.getElementById('agInput')
           if (!t) return 'no-input'
           t.value = ${JSON.stringify(PROMPT)}
           const b = document.getElementById('agSend')
           if (!b) return 'no-send-btn'
           if (b.disabled) return 'send-disabled'
           b.click()
           return 'clicked'
         })()`)
      log('  [debug] 点击发送: ' + clicked)
    } catch (e) { log('  [debug] 点击发送异常: ' + e.message) }
    const t0 = Date.now()
    let text = '', errText = '', raw = '', n = 0
    while (Date.now() - t0 < 45000) {
      const s = await win.webContents.executeJavaScript(`(() => {
        const ai = document.querySelectorAll('#agLog .ag-msg.ai')
        const err = document.querySelectorAll('#agLog .ag-msg.err')
        return {
          ai: ai.length ? ai[ai.length - 1].textContent : '',
          err: err.length ? err[err.length - 1].textContent : '',
          busy: document.getElementById('agSend').disabled,
          nMsg: document.querySelectorAll('#agLog .ag-msg').length,
        }
      })()`)
      text = s.ai; errText = s.err; raw = JSON.stringify(s)
      n++
      log('  [poll ' + n + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + raw)
      try { fs.writeFileSync(RESULT, lines.join('\n') + '\n', 'utf8') } catch (_) {}
      if (!s.busy && (text || errText)) break
      await new Promise((r) => setTimeout(r, 800))
    }
    log('\n  === 真实发送（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）===')
    log('  最终状态: ' + raw)
    log('  助手气泡: ' + (text ? JSON.stringify(text.slice(0, 300)) : '(空)'))
    if (errText) log('  错误气泡: ' + JSON.stringify(errText.slice(0, 300)))
    okSend = !!text && !errText
    log('\n  ' + (okSend ? '✅ 流式链路通：收到并显示了回复正文' : '❌ 未取到回复正文'))
  }

  // 清理本次测试对 localStorage 的污染（点标签会写入 moonbit-view）
  try { await win.webContents.executeJavaScript(`(() => { localStorage.removeItem('moonbit-view') })()`) } catch (_) {}
  log('\n  RESULT: ' + (okUi && okSend ? 'PASS' : 'FAIL'))
  dump(okUi && okSend ? 0 : 1)
}).catch((e) => { log('  主流程异常: ' + (e && e.stack || e)); dump(1) })
