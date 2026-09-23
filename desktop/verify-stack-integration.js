// GUI 集成验证：真实堆栈能否被吃到 → 进问题面板 → 点击跳转 → 整行高亮
//
// 与"正则单测"的区别：这一步走的是**真实链路** ——
//   runMoon（流式）→ log() → scanRuntimeStack() → runtimeLocs
//   → refreshProblemPanel() → 问题面板 DOM
//   → highlightErrorLines() → Monaco 装饰
//
// 不真造崩溃：直接喂真实堆栈文本给 log()，验证消费端。堆栈文本取自
// crash-raw.txt（`moon run ide-backend/crashprobe --target native` 的真实输出字节）。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await new Promise(r=>setTimeout(r,250)) }
  await new Promise(r=>setTimeout(r,6000))
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const q = async (l, c) => { try { console.log(`  ${l}: ${String(await js(c)).slice(0,200)}`) } catch (e) { console.log(`  ${l}: <失败 ${String(e.message).slice(0,70)}>`) } }

  let pass = 0, fail = 0
  const check = (n, c, d='') => { if (c) { pass++; console.log(`  [PASS] ${n}`) } else { fail++; console.log(`  [FAIL] ${n}  ${d}`) } }

  // 读真实堆栈（若文件不在，退化用等价文本）
  const rawPath = path.join(__dirname, '..', 'crash-raw.txt')
  let raw
  try {
    raw = fs.readFileSync(rawPath, 'utf8')
    console.log('  （使用真实堆栈文件 crash-raw.txt）')
  } catch (_) {
    raw = [
      'before crash',
      'PanicError',
      '    at moonbit_panic (C:\\Users\\x\\.moon\\lib\\runtime\\backtrace.c:177)',
      '    at @mbp/platform/ide-backend/crashprobe.crash_probe (C:\\Users\\x\\proj\\ide-backend\\crashprobe\\main.mbt:7)',
      '    at main (C:\\Users\\x\\proj\\ide-backend\\crashprobe\\main.mbt:14)',
    ].join('\r\n')
    console.log('  （crash-raw.txt 不在，使用等价文本）')
  }

  console.log('\n=== ① 清空既有运行时位置，避免上一轮的干扰 ===')
  await q('清空 runtimeLocs', "(()=>{ runtimeLocs = []; runtimeHintUntil = 0; refreshProblemPanel(); return runtimeLocs.length })()")

  console.log('\n=== ② 把真实堆栈逐块喂给 log()（模拟 stdout 分块到达）===')
  // 关键：**故意拆成多块**，因为 PanicError 与堆栈行很可能不在同一块里
  const chunks = raw.split(/\r?\n/).map((l) => l + '\r\n')
  const feed = await js(`(async () => {
    const parts = ${JSON.stringify(chunks)};
    for (const p of parts) { log(p); }
    await new Promise(r => setTimeout(r, 300));
    return JSON.stringify({ 帧数: runtimeLocs.length, 明细: runtimeLocs.map(x => x.file.split(/[\\\\/]/).pop() + ':' + x.line + (x.col && x.col > 1 ? ':' + x.col : '')) })
  })()`)
  console.log('  ', String(feed))
  const f = JSON.parse(feed)
  check('真实堆栈被吃到（帧数 > 0）', f.帧数 > 0, `帧数=${f.帧数}`)
  check('含崩溃点 main.mbt（行 7）', f.明细.some(d => d.includes('main.mbt:7')), f.明细.join(','))
  check('无列号时 col 被兜底为 1（不出现 NaN/undefined）',
    !f.明细.some(d => d.includes('NaN') || d.includes('undefined')), f.明细.join(','))

  console.log('\n=== ③ 问题面板里是否真的出现了条目 ===')
  const panel = await js(`(() => {
    const el = document.getElementById('problems')
    const items = Array.from(el.querySelectorAll('.diag'))
    return JSON.stringify({
      条目数: items.length,
      含运行时错误位置: el.textContent.includes('运行时错误位置'),
      含not_found占位: el.textContent.includes('没有问题'),
      样本文本: el.textContent.slice(0, 160),
    })
  })()`)
  console.log('  ', String(panel))
  const p = JSON.parse(panel)
  check('问题面板有运行时条目', p.含运行时错误位置 === true, p.样本文本)
  check('不再是"没有问题"占位', p.含not_found占位 === false)

  console.log('\n=== ④ 点击条目能否跳转（复用面板里的 onclick） ===')
  const jump = await js(`(async () => {
    const el = document.getElementById('problems')
    const items = Array.from(el.querySelectorAll('.diag'))
    const runtimeItem = items.find(i => i.textContent.includes('运行时错误位置'))
    if (!runtimeItem) return 'no-item'
    try {
      runtimeItem.onclick && runtimeItem.onclick()
    } catch (e) {
      // 跳转目标文件可能没打开 → 观察是否抛错而不是静默
      return 'click-threw: ' + String(e && e.message).slice(0, 60)
    }
    await new Promise(r => setTimeout(r, 300))
    const pos = editor.getPosition()
    return 'clicked, 光标=' + (pos ? pos.lineNumber + ':' + pos.column : 'null')
  })()`)
  console.log('  ', String(jump))
  check('条目可点击且未抛异常', !String(jump).startsWith('click-threw'), String(jump))

  console.log('\n=== ⑤ 整行高亮（装饰集合）是否建立 ===')
  const deco = await js(`(() => {
    const has = typeof errorDecorationCollection !== 'undefined' && errorDecorationCollection !== null
    let len = -1
    try { len = has ? errorDecorationCollection.length : -1 } catch (e) { len = -2 }
    return JSON.stringify({ 集合已建: has, 装饰数: len, 有高亮CSS: !!Array.from(document.styleSheets).some(s => { try { return Array.from(s.cssRules||[]).some(r => r.selectorText && r.selectorText.includes('runtime-error-line')) } catch(e){ return false } }) })
  })()`)
  console.log('  ', String(deco))
  const d = JSON.parse(deco)
  check('装饰集合已建立', d.集合已建 === true)
  check('高亮 CSS 已定义', d.有高亮CSS === true)
  check('装饰数 ≥ 0（未抛错）', d.装饰数 >= 0, `装饰数=${d.装饰数}`)

  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass+fail} 项`)
  app.quit()
})
