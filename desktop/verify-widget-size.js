// 验证：所有 widget 尺寸一致（列宽本就一致，本轮补的是行高）+ 日历在 6 行月份是否被裁
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await sleep(250) }
  if (win) { win.show(); win.focus() }
  await sleep(9000)
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const SHOT = path.join(__dirname, 'e2e-shots', 'dash')
  fs.mkdirSync(SHOT, { recursive: true })
  const safeShot = async (n) => { try { fs.writeFileSync(path.join(SHOT, n), (await win.webContents.capturePage()).toPNG()); console.log('  截图 ' + n) } catch (e) { console.log('  截图失败: ' + n) } }

  let pass = 0, fail = 0
  // P19：类型防护 —— 传非布尔（数组/对象）说明用错了函数，必须当场失败
  const chk = (n, ok, d) => {
    if (typeof ok !== 'boolean') { fail++; console.log(`  [FAIL] ${n}   chk 只接受布尔（数组/对象比较请用 eq）：${JSON.stringify(ok)}`); return }
    if (ok) { pass++; console.log(`  [PASS] ${n}`) } else { fail++; console.log(`  [FAIL] ${n}  ${d || ''}`) }
  }

  await js(`(() => { const a = document.querySelector('a[data-view="home"]'); if (a) a.click() })()`)
  await sleep(1600)
  await js(`window.moonbitTheme.set('dark')`)
  await sleep(600)

  console.log('=== ① 所有 widget 尺寸一致 ===')
  const s = JSON.parse(await js(`(() => {
    const ws = Array.from(document.querySelectorAll('.widget'))
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }
    return JSON.stringify({
      n: ws.length,
      items: ws.map((w) => ({ type: w.dataset.type, ...box(w) })),
      gridRows: getComputedStyle(document.getElementById('dashGrid')).gridAutoRows,
    })
  })()`))
  console.log('  ', JSON.stringify(s))
  const hs = [...new Set(s.items.map((i) => i.h))]
  const wd = [...new Set(s.items.map((i) => i.w))]
  chk('所有 widget 高度相同', hs.length === 1, `高度集合 ${JSON.stringify(hs)}`)
  chk('所有 widget 宽度相同', wd.length === 1, `宽度集合 ${JSON.stringify(wd)}`)
  chk('行高由 grid 固定（grid-auto-rows=310px）', s.gridRows === '310px', s.gridRows)
  chk('高度 = 310px（与日历实际所需高度一致）', hs[0] === 310, String(hs[0]))

  console.log('\n=== ② 日历内容不被裁（含 6 行月份）===')
  // 逐月翻，找出 6 行（42 格）的月份，看日历是否溢出
  const months = JSON.parse(await js(`(async () => {
    const out = []
    for (let k = 0; k < 12; k++) {
      const next = document.querySelectorAll('.cal-bar button')[1]  // ›
      if (k > 0 && next) next.click()
      await new Promise(r => setTimeout(r, 260))
      const cal = document.querySelector('.widget[data-type=calendar]')
      if (!cal) break
      const slot = cal.querySelector('.dash-slot')
      const grid = cal.querySelector('.dash-cal')
      const hol = cal.querySelector('.cal-holidays')
      const cells = grid ? grid.querySelectorAll('div').length : 0
      const title = (cal.querySelector('.cal-title') || {}).textContent || ''
      out.push({
        title,
        rows: Math.ceil(cells / 7),   // 注意用 ceil：格子数超 42 时确实是多一行（如 2027-01 是 7 行）
        scrollH: slot.scrollHeight,
        clientH: slot.clientHeight,
        overflow: slot.scrollHeight > slot.clientHeight + 1,
        holBottom: hol ? Math.round(hol.getBoundingClientRect().bottom) : 0,
        cardBottom: Math.round(cal.getBoundingClientRect().bottom),
        holVisible: hol ? Math.round(hol.getBoundingClientRect().bottom) <= Math.round(cal.getBoundingClientRect().bottom) - 2 : true,
      })
    }
    return JSON.stringify(out)
  })()`))
  const six = months.find((m) => m.rows === 6)
  console.log('  6 行月份:', six ? JSON.stringify(six) : '(12 个月内没有 6 行月份)')
  console.log('\n  逐月 scrollH/clientH（⚠=溢出）:')
  for (const m of months) {
    console.log(`    ${m.title.padEnd(12)} rows=${m.rows}  ${m.scrollH}/${m.clientH}${m.overflow ? '  ⚠ 溢出 ' + (m.scrollH - m.clientH) + 'px' : ''}`)
  }
  if (six) {
    chk('6 行月份的日历没被裁（节假日仍完整可见）', six.holVisible === true, `节假日底部 ${six.holBottom} vs 卡片底部 ${six.cardBottom}`)
  } else {
    chk('12 个月内没有 6 行月份（无需担心）', true, '')
  }
  const anyOverflow = months.filter((m) => m.overflow)
  chk('所有月份日历都能完整显示（无需滚动）', anyOverflow.length === 0, `溢出月份: ${JSON.stringify(anyOverflow.map((m) => m.title))}`)

  console.log('\n=== ③ 内容多的卡片在卡内滚动（不撑破行高）===')
  const grow = JSON.parse(await js(`(async () => {
    // 往待办里塞 20 条，看卡片高度是否被撑大
    const before = Math.round(document.querySelector('.widget[data-type=todos]').getBoundingClientRect().height)
    const ta = document.querySelector('.widget[data-type=todos] .add input')
    for (let i = 0; i < 20; i++) {
      ta.value = '压力测试待办 ' + i
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 40))
    }
    await new Promise(r => setTimeout(r, 500))
    const w = document.querySelector('.widget[data-type=todos]')
    const slot = w.querySelector('.dash-slot')
    return JSON.stringify({
      before,
      after: Math.round(w.getBoundingClientRect().height),
      slotScroll: slot.scrollHeight, slotClient: slot.clientHeight,
      scrollable: slot.scrollHeight > slot.clientHeight + 1,
    })
  })()`))
  console.log('  ', JSON.stringify(grow))
  chk('塞 20 条待办后卡片高度不变', grow.before === grow.after, `${grow.before} → ${grow.after}`)
  chk('内容区变为可滚动（不溢出卡片）', grow.scrollable === true, `scroll ${grow.slotScroll} / client ${grow.slotClient}`)

  await safeShot('widgets-uniform.png')
  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
  app.quit()
  setTimeout(() => process.exit(0), 1500)
}).catch((e) => { log('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
