require('./main.js')
const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await new Promise(r=>setTimeout(r,250)) }
  await new Promise(r=>setTimeout(r,6000))
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const q = async (l, c) => { try { console.log(`  ${l}: ${String(await js(c)).slice(0,150)}`) } catch (e) { console.log(`  ${l}: <失败 ${String(e.message).slice(0,50)}>`) } }
  const NL = "String.fromCharCode(10)"

  console.log('════ Ghost Text 配置 ════')
  await q('inlineSuggest.enabled', "editor.getOption(monaco.editor.EditorOption.inlineSuggest).enabled")

  console.log('\n════ 候选逻辑（模块级函数，可直接调）════')
  await q('设置内容含 this', `(()=>{ editor.getModel().setValue('fn f() {' + ${NL} + '  let x = this' + ${NL} + '}' + ${NL}); return 'ok' })()`)
  await q('候选词数量', "inlineCandidates(editor.getModel()).length")
  await q('候选含 this', "inlineCandidates(editor.getModel()).includes('this')")
  await q('候选含关键字 fn/let', "(()=>{const cs=inlineCandidates(editor.getModel()); return 'fn='+cs.includes('fn')+' let='+cs.includes('let')})()")

  console.log('\n════ th → this（模拟 provider 的判定）════')
  await q('前缀 th 的匹配', "(()=>{const cs=inlineCandidates(editor.getModel()); return cs.filter(c=>c.startsWith('th') && c.length>2).join(',') || '(无)'})()")
  const r = await js(`(async () => {
    const m = editor.getModel()
    m.setValue('fn f() {  th' + ${NL} + '}')
    editor.setPosition({ lineNumber: 1, column: 14 })
    const w = m.getWordUntilPosition(editor.getPosition())
    const hit = inlineCandidates(m).find(c => c.length > w.word.length && c.startsWith(w.word))
    return JSON.stringify({ 前缀: w.word, 补全部分: hit ? hit.slice(w.word.length) : null, 完整词: hit || null })
  })()`)
  console.log('  ', String(r))

  await q('还原', `(()=>{ editor.getModel().setValue('// ok' + ${NL}); return 'ok' })()`)
  app.quit()
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
