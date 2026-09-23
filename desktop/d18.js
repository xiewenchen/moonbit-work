// Step 4 验证（低复杂度三项）：hover / references / documentSymbol 都走 LSP
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
  console.log('LSPSTART ' + await js(`(async () => { const r = await window.moonAPI.lspStart(${JSON.stringify(PROJ)}); return JSON.stringify({ ok: r.ok, caps: r.status && r.status.caps ? r.status.caps.length : 0 }) })()`))

  // 找一个代码里的 safe_byte 调用点作为探测位置
  const pos = JSON.parse(await js(`(function () {
    try {
      const ed = monaco.editor.getEditors().filter(function (e) { return !!e.getModel() })[0]
      const m = ed.getModel()
      for (let i = 0; i < m.getLineCount(); i++) {
        const t = m.getLineContent(i + 1)
        const s = t.trim()
        if (s.indexOf('//') === 0 || s.indexOf('*') === 0) continue
        if (s.indexOf('fn ') === 0 || s.indexOf('pub fn ') === 0) continue
        const c = t.indexOf('safe_byte')
        if (c >= 0) return JSON.stringify({ line: i + 1, col: c + 2, text: s.slice(0, 50) })
      }
      return JSON.stringify({ err: 'not-found' })
    } catch (e) { return JSON.stringify({ err: String(e && e.message).slice(0, 120) }) }
  })()`))
  console.log('POS ' + JSON.stringify(pos))
  if (pos.err) { app.quit(); setTimeout(() => process.exit(0), 500); return }

  // ① hover
  console.log('HOVER ' + await js(`(async () => {
    const r = await window.moonAPI.lspHover({ root: ${JSON.stringify(PROJ)}, file: ${JSON.stringify(FILE)}, line: ${pos.line - 1}, character: ${pos.col - 1} })
    const c = r.result && r.result.contents
    const v = typeof c === 'string' ? c : (c && c.value) ? c.value : ''
    return JSON.stringify({ ok: r.ok, err: r.error, hasRange: !!(r.result && r.result.range), head: String(v).replace(/\\n/g, ' ').slice(0, 90) })
  })()`))

  // ② references
  console.log('REFS ' + await js(`(async () => {
    const r = await window.moonAPI.lspReferences({ root: ${JSON.stringify(PROJ)}, file: ${JSON.stringify(FILE)}, line: ${pos.line - 1}, character: ${pos.col - 1} })
    const n = Array.isArray(r.result) ? r.result.length : 0
    const first = n ? r.result[0].uri : null
    return JSON.stringify({ ok: r.ok, err: r.error, n: n, first: first ? String(first).slice(-24) : null })
  })()`))

  // ③ documentSymbol（大纲数据源）
  console.log('SYMBOLS ' + await js(`(async () => {
    const r = await window.moonAPI.lspDocumentSymbol({ root: ${JSON.stringify(PROJ)}, file: ${JSON.stringify(FILE)} })
    const arr = Array.isArray(r.result) ? r.result : []
    const names = arr.slice(0, 5).map(function (s) { return (s.name || '?') + '@' + (s.range ? s.range.start.line + 1 : '?') })
    return JSON.stringify({ ok: r.ok, n: arr.length, first: names })
  })()`))

  // ④ 界面上：刷新大纲是否真的填了内容（走的是新的 LSP 路径）
  const outline = await js(`(async () => {
    const n = await refreshOutline()
    return JSON.stringify({ n: n, hint: (document.getElementById('outlineHint') || {}).textContent || '', rows: document.querySelectorAll('#outline .sym').length, sample: (document.querySelector('#outline .sym') || {}).textContent || '' })
  })()`)
  console.log('OUTLINE ' + outline)

  app.quit(); setTimeout(() => process.exit(0), 800)
})
