// Step 3 验收：同文件跳转 + 跨文件跳转（都是真实触发 Monaco 的 revealDefinition）
require('./main.js')
const { app, BrowserWindow } = require('electron')
const path = require('path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PROJ = path.resolve('..')
const FILE = path.join(PROJ, 'http', 'http.mbt')

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await sleep(250) }
  await sleep(8000)
  const js = (c) => win.webContents.executeJavaScript(c, true)

  await js(`(async () => { await openFile(${JSON.stringify(FILE)}) })()`)
  await sleep(3000)

  // 启动 LSP（正式链路由渲染进程的 ensureLsp 负责，这里显式来一次便于观察）
  console.log('LSPSTART ' + await js(`(async () => { const r = await window.moonAPI.lspStart(${JSON.stringify(PROJ)}); return JSON.stringify({ ok: r.ok, err: r.error, caps: r.status && r.status.caps ? r.status.caps.length : 0 }) })()`))

  // ── 定位点：跳过注释行与定义行，只取真正的代码调用 ─────────────────────
  const find = (sym) => js(`(function () {
    try {
      const eds = monaco.editor.getEditors()
      const ed = eds.filter(function (e) { return !!e.getModel() }).filter(function (e) { return String(e.getModel().uri.path).toLowerCase().indexOf('http.mbt') >= 0 })[0]
      if (!ed) return JSON.stringify({ err: 'no-editor', n: eds.length })
      const m = ed.getModel()
      const n = m.getLineCount()
      for (let i = 0; i < n; i++) {
        const t = m.getLineContent(i + 1)
        const s = t.trim()
        if (s.indexOf('//') === 0 || s.indexOf('*') === 0) continue
        if (s.indexOf('fn ') === 0 || s.indexOf('pub fn ') === 0) continue
        const c = t.indexOf('${sym}')
        if (c >= 0) return JSON.stringify({ line: i + 1, col: c + 2, text: s.slice(0, 64) })
      }
      return JSON.stringify({ err: 'not-found', lines: n })
    } catch (e) { return JSON.stringify({ err: 'throw', msg: String(e && e.message).slice(0, 140) }) }
  })()`)

  // ① 同文件跳转：safe_byte 的调用处 → 定义处（同文件另一行）
  const same = JSON.parse(await find('safe_byte'))
  console.log('SAME-POS ' + JSON.stringify(same))
  if (!same.err) {
    const ipc = await js(`(async () => {
      const r = await window.moonAPI.lspDefinition({ root: ${JSON.stringify(PROJ)}, file: ${JSON.stringify(FILE)}, line: ${same.line - 1}, character: ${same.col - 1} })
      const f = Array.isArray(r.result) ? r.result[0] : r.result
      return JSON.stringify({ ok: r.ok, err: r.error, n: Array.isArray(r.result) ? r.result.length : (r.result ? 1 : 0), target: f ? f.uri : null, line: f ? f.range.start.line + 1 : null })
    })()`)
    console.log('SAME-IPC ' + ipc)
    const jumped = await js(`(async () => {
      try {
        const ed = monaco.editor.getEditors().find(function (e) { return e.getModel() && String(e.getModel().uri.path).toLowerCase().endsWith('http.mbt') })
        ed.setPosition({ lineNumber: ${same.line}, column: ${same.col} })
        ed.focus()
        ed.trigger('keyboard', 'editor.action.revealDefinition', {})
        await new Promise(function (r) { setTimeout(r, 5000) })
        const ed2 = monaco.editor.getEditors().find(function (e) { return e.getModel() && String(e.getModel().uri.path).toLowerCase().endsWith('http.mbt') })
        const p = ed2.getPosition()
        return JSON.stringify({ line: p.lineNumber, col: p.column, text: ed2.getModel().getLineContent(p.lineNumber).trim().slice(0, 64) })
      } catch (e) { return JSON.stringify({ err: String(e && e.message).slice(0, 140) }) }
    })()`)
    console.log('SAME-JUMP ' + jumped)
  }

  // ② 跨文件跳转：找一处 @模块.符号 的调用
  const cross = JSON.parse(await js(`(() => {
    const ed = monaco.editor.getEditors().find(function (e) { return e.getModel() && String(e.getModel().uri.path).toLowerCase().endsWith('http.mbt') })
    const m = ed.getModel()
    for (let i = 0; i < m.getLineCount(); i++) {
      const t = m.getLineContent(i + 1)
      const s = t.trim()
      if (s.indexOf('//') === 0 || s.indexOf('*') === 0) continue
      const at = t.indexOf('@')
      if (at < 0) continue
      const m2 = t.slice(at + 1).match(/^([a-z_]+)\.([a-zA-Z_][a-zA-Z0-9_]*)/)
      if (m2) return JSON.stringify({ line: i + 1, col: at + 2, sym: m2[1] + '.' + m2[2], text: s.slice(0, 64) })
    }
    return JSON.stringify({ err: 'no-cross-ref' })
  })()`))
  console.log('CROSS-POS ' + JSON.stringify(cross))
  if (!cross.err) {
    const cr = await js(`(async () => {
      const r = await window.moonAPI.lspDefinition({ root: ${JSON.stringify(PROJ)}, file: ${JSON.stringify(FILE)}, line: ${cross.line - 1}, character: ${cross.col - 1} })
      const f = Array.isArray(r.result) ? r.result[0] : r.result
      return JSON.stringify({ ok: r.ok, err: r.error, n: Array.isArray(r.result) ? r.result.length : (r.result ? 1 : 0), target: f ? f.uri : null, line: f ? f.range.start.line + 1 : null })
    })()`)
    console.log('CROSS-IPC ' + cr)
  }

  app.quit(); setTimeout(() => process.exit(0), 800)
})
