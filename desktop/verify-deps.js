// 验证 3.5 依赖管理：命令面板「带参命令」的两步流转
// 只验 UI 状态机，不真跑 moon add/remove（避免改到 moon.mod）
require('./main.js')
const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await new Promise(r=>setTimeout(r,250)) }
  await new Promise(r=>setTimeout(r,6000))
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const q = async (l, c) => { try { console.log(`  ${l}: ${String(await js(c)).slice(0,160)}`) } catch (e) { console.log(`  ${l}: <失败 ${String(e.message).slice(0,60)}>`) } }

  let pass = 0, fail = 0
  const check = (name, cond, detail='') => { if (cond) { pass++; console.log(`  [PASS] ${name}`) } else { fail++; console.log(`  [FAIL] ${name}  ${detail}`) } }

  console.log('=== ① 命令面板里能列到依赖管理命令 ===')
  const labels = await js("commands().map(c=>c.label)")
  check('有 moon tree', labels.some(l => l.includes('tree')), '')
  check('有 moon update', labels.some(l => l.includes('update')), '')
  check('有 moon add（带参）', labels.some(l => l.includes('add')), '')
  check('有 moon remove（带参）', labels.some(l => l.includes('remove')), '')

  console.log('\n=== ② 带参命令的元数据 ===')
  const meta = await js("JSON.stringify(commands().filter(c=>c.needsArg).map(c=>({label:c.label, needsArg:c.needsArg, hasRunWithArg: typeof c.runWithArg==='function'})))")
  console.log('  ', String(meta).slice(0, 220))

  console.log('\n=== ③ 进入「参数模式」的 UI 流转 ===')
  await q('打开命令面板', "(()=>{ openPalette(); return document.getElementById('palette').classList.contains('open') })()")
  await q('进入参数模式（选 moon add）', "(()=>{ const c=commands().find(x=>x.label.includes('add')); activateCommand(c); return 'called' })()")
  await new Promise(r=>setTimeout(r,300))
  const st = await js("JSON.stringify({ 面板仍打开: document.getElementById('palette').classList.contains('open'), placeholder: document.getElementById('paletteInput').placeholder, 提示文本: document.getElementById('paletteList').textContent.slice(0,80), argMode已设: paletteArgMode !== null, argMode标签: paletteArgMode ? paletteArgMode.label : null })")
  console.log('  ', String(st))
  const s = JSON.parse(st)
  check('面板保持打开（不急着关）', s.面板仍打开 === true)
  check('placeholder 变成参数提示', s.placeholder.includes('包名'), s.placeholder)
  check('列表显示操作提示', s.提示文本.includes('回车执行'), s.提示文本)
  check('argMode 已置位', s.argMode已设 === true, String(s.argMode标签))

  console.log('\n=== ④ 参数模式下输入不会把提示覆盖掉 ===')
  await q('触发 oninput', "(()=>{ document.getElementById('paletteInput').value='moonbitlang/x'; filterPalette('moonbitlang/x'); return 'ok' })()")
  await q('提示是否还在', "document.getElementById('paletteList').textContent.includes('回车执行')")

  console.log('\n=== ⑤ 空输入回车不应执行（防误触） ===')
  const r = await js(`(async () => {
    let called = false
    const c = commands().find(x => x.label.includes('add'))
    // 换成一个探针版本，检查 submitArg 的守卫逻辑
    const orig = c.runWithArg
    c.runWithArg = () => { called = true }
    paletteArgMode = { ...c }
    submitArg('')            // 空 → 不应执行
    const emptyCalled = called
    paletteArgMode = { ...c }
    submitArg('   ')         // 仅空白 → 不应执行
    const blankCalled = called
    paletteArgMode = { ...c }
    submitArg('moonbitlang/x')  // 有值 → 应执行
    const realCalled = called
    c.runWithArg = orig
    return JSON.stringify({ 空输入: emptyCalled, 仅空白: blankCalled, 有值: realCalled })
  })()`)
  console.log('  ', String(r))
  const rr = JSON.parse(r)
  check('空输入不执行', rr.空输入 === false)
  check('仅空白不执行', rr.仅空白 === false)
  check('有值才执行', rr.有值 === true)

  console.log('\n=== ⑥ 退出：Esc 应回到命令列表 ===')
  await q('重新进参数模式', "(()=>{ activateCommand(commands().find(x=>x.label.includes('add'))); return paletteArgMode !== null })()")
  await q('Esc', "(()=>{ openPalette(); return 'ok' })()")
  await q('argMode 已清', "paletteArgMode === null")

  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass+fail} 项`)
  app.quit()
})
