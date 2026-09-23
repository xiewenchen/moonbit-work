// 验证本轮三个需求：① 日历(翻月/今日高亮/节假日标红) ② 可编辑交互(点选/右键新建日程/笔记日程可编辑) ③ 顶部横幅(可关闭/不新开窗口而跳转)
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

  let pass = 0, fail = 0
  const chk = (n, ok, d) => { if (ok) { pass++; console.log(`  [PASS] ${n}`) } else { fail++; console.log(`  [FAIL] ${n}  ${d || ''}`) } }

  // 清掉上次的横幅隐藏记录，保证能测到横幅
  await js(`localStorage.removeItem('moonbit-banner-hidden')`)
  await win.webContents.reload()
  await sleep(8000)
  await js(`(() => { const a = document.querySelector('a[data-view="home"]'); if (a) a.click() })()`)
  await sleep(1500)

  console.log('=== ③ 顶部横幅 ===')
  const b = JSON.parse(await js(`(() => {
    const go = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('去主菜单看看'))
    const close = Array.from(document.querySelectorAll('button')).find(x => x.textContent.replace(/\\s+/g,'') === '关闭')
    return JSON.stringify({
      hasGo: !!go, hasClose: !!close,
      goTarget: go ? (go.getAttribute('target') || '(无)') : '',
      goHref: go ? go.getAttribute('href') : '',
    })
  })()`))
  console.log('  ', JSON.stringify(b))
  chk('有「去主菜单看看」按钮', b.hasGo === true)
  chk('有「关闭」按钮', b.hasClose === true)
  chk('链接**不再**带 target（不会再新开窗口）', b.goTarget === '(无)', b.goTarget)

  // 点「去主菜单看看」应切到主菜单标签（而不是开窗口）
  const goRes = JSON.parse(await js(`(async () => {
    document.querySelector('a[data-view="project"]').click()
    await new Promise(r => setTimeout(r, 400))
    const before = Array.from(document.querySelectorAll('a[data-view].active')).map(a => a.dataset.view)
    const go = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('去主菜单看看'))
    go.click()
    await new Promise(r => setTimeout(r, 600))
    return JSON.stringify({
      before,
      after: Array.from(document.querySelectorAll('a[data-view].active')).map(a => a.dataset.view),
      mainviews: Array.from(document.querySelectorAll('.mainview')).filter(m => getComputedStyle(m).display !== 'none').map(m => m.id),
      winCount: 1,
    })
  })()`))
  console.log('  ', JSON.stringify(goRes))
  chk('点它 → 切到「主菜单」标签', goRes.after[0] === 'home', JSON.stringify(goRes.after))
  chk('点它 → 主内容区显示 mainview-home', goRes.mainviews[0] === 'mainview-home', JSON.stringify(goRes.mainviews))

  // 关闭横幅
  const closeRes = JSON.parse(await js(`(async () => {
    const close = Array.from(document.querySelectorAll('button')).find(x => x.textContent.replace(/\\s+/g,'') === '关闭')
    close.click()
    await new Promise(r => setTimeout(r, 500))
    const stillVisible = Array.from(document.querySelectorAll('a')).some(a => a.textContent.includes('去主菜单看看') && a.offsetParent)
    return JSON.stringify({ stillVisible, stored: localStorage.getItem('moonbit-banner-hidden') })
  })()`))
  console.log('  ', JSON.stringify(closeRes))
  chk('点「关闭」→ 横幅真的收起来了', closeRes.stillVisible === false, String(closeRes.stillVisible))
  chk('关闭状态被记住', closeRes.stored === '1', String(closeRes.stored))

  console.log('\n=== ① 日历：翻月 / 今日高亮 / 节假日标红 ===')
  const cal = JSON.parse(await js(`(() => {
    const bar = document.querySelector('.cal-bar')
    return JSON.stringify({
      hasBar: !!bar,
      btns: bar ? Array.from(bar.querySelectorAll('button')).map(x => x.textContent.trim()) : [],
      title: bar ? bar.querySelector('.cal-title').textContent : '',
      today: document.querySelectorAll('.dash-cal .d.today').length,
      holidays: document.querySelectorAll('.dash-cal .d.holiday').length,
      holidayText: (document.querySelector('.cal-holidays') || {}).textContent || '',
      holidayColor: (() => { const h = document.querySelector('.dash-cal .d.holiday'); return h ? getComputedStyle(h).color : '' })(),
    })
  })()`))
  console.log('  ', JSON.stringify(cal))
  chk('有月份导航（‹ › 今天）', cal.hasBar && cal.btns.length >= 3, JSON.stringify(cal.btns))
  chk('标题显示年月', /\d{4} 年 \d{1,2} 月/.test(cal.title), cal.title)
  chk('今日被高亮（恰好 1 个）', cal.today === 1, String(cal.today))
  chk('当月有节假日标红（2026-09 中秋）', cal.holidays > 0, `标红 ${cal.holidays} 天`)
  chk('节假日文字里写明节日名', cal.holidayText.includes('中秋'), cal.holidayText)
  chk('节假日颜色是红（rgb(238,94,82)）', cal.holidayColor === 'rgb(238, 94, 82)', cal.holidayColor)

  // 翻月到 10 月，应看到国庆 7 天
  const oct = JSON.parse(await js(`(async () => {
    const next = document.querySelectorAll('.cal-bar button')[2]
    next.click()
    await new Promise(r => setTimeout(r, 500))
    return JSON.stringify({
      title: document.querySelector('.cal-title').textContent,
      holidays: document.querySelectorAll('.dash-cal .d.holiday').length,
      text: (document.querySelector('.cal-holidays') || {}).textContent || '',
    })
  })()`))
  console.log('  ', JSON.stringify(oct))
  chk('点 › 能翻到下个月', oct.title.includes('10 月'), oct.title)
  chk('10 月国庆 7 天标红', oct.holidays === 7, String(oct.holidays))
  chk('文字标出国庆', oct.text.includes('国庆'), oct.text)

  console.log('\n=== ② 可编辑交互：点选日期 / 右键新建日程 / 日程可编辑 ===')
  const sel = JSON.parse(await js(`(async () => {
    const cell = document.querySelector('.dash-cal .d[data-date="2026-10-01"]')
    if (!cell) return JSON.stringify({ err: 'no-cell' })
    cell.click()
    await new Promise(r => setTimeout(r, 500))
    return JSON.stringify({
      selected: document.querySelectorAll('.dash-cal .d.selected').length,
      selectedDate: document.querySelector('.dash-cal .d.selected').dataset.date,
      agendaDate: (document.querySelector('.agenda-date') || {}).textContent || '',
    })
  })()`))
  console.log('  ', JSON.stringify(sel))
  chk('点日期 → 出现选中态', sel.selected === 1 && sel.selectedDate === '2026-10-01', JSON.stringify(sel))
  chk('日程组件跟着切到这天', String(sel.agendaDate).includes('2026-10-01'), sel.agendaDate)

  const menu = JSON.parse(await js(`(async () => {
    const cell = document.querySelector('.dash-cal .d[data-date="2026-10-01"]')
    const r = cell.getBoundingClientRect()
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 10), clientY: Math.round(r.top + 10) }))
    await new Promise(r2 => setTimeout(r2, 500))
    const m = document.getElementById('dayMenu')
    const hasInput = !!(m && m.querySelector('input'))
    const hasAddBtn = !!(m && Array.from(m.querySelectorAll('button')).some(x => x.textContent.includes('新建日程')))
    return JSON.stringify({ shown: !!m, hasInput, hasAddBtn, head: m ? m.querySelector('.day-menu-head').textContent : '' })
  })()`))
  console.log('  ', JSON.stringify(menu))
  chk('右键日期 → 弹出菜单', menu.shown === true)
  chk('菜单里有输入框', menu.hasInput === true)
  chk('菜单里有「＋ 新建日程」', menu.hasAddBtn === true)
  chk('菜单标出是哪一天', menu.head === '2026-10-01', menu.head)

  // 在菜单里输入并回车 → 日程建立
  const created = JSON.parse(await js(`(async () => {
    const m = document.getElementById('dayMenu')
    const inp = m.querySelector('input')
    inp.value = '国庆去看升旗'
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise(r => setTimeout(r, 600))
    const all = JSON.parse(localStorage.getItem('moonbit-dash-events') || '{}')
    const rows = Array.from(document.querySelectorAll('.widget[data-type=agenda] .row')).map(x => x.textContent)
    return JSON.stringify({
      stored: all['2026-10-01'] || [],
      menuGone: !document.getElementById('dayMenu'),
      agendaRows: rows,
      calDot: document.querySelectorAll('.dash-cal .d .has-event').length,
    })
  })()`))
  console.log('  ', JSON.stringify(created))
  chk('新建的日程写进 localStorage', created.stored.length === 1 && created.stored[0].text === '国庆去看升旗', JSON.stringify(created.stored))
  chk('回车后菜单收起', created.menuGone === true)
  chk('日程组件里能看到它', created.agendaRows.some((r) => r.includes('国庆去看升旗')), JSON.stringify(created.agendaRows))
  chk('日历上那天出现「有日程」小点', created.calDot >= 1, String(created.calDot))

  // 便签可编辑
  const note = JSON.parse(await js(`(async () => {
    const ta = document.querySelector('.widget[data-type=notes] textarea')
    if (!ta) return JSON.stringify({ err: 'no-textarea' })
    ta.value = '这是一条便签'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 700))
    return JSON.stringify({ stored: JSON.parse(localStorage.getItem('moonbit-dash-notes') || '""') })
  })()`))
  console.log('  ', JSON.stringify(note))
  chk('便签可编辑且自动保存', note.stored === '这是一条便签', String(note.stored))

  console.log('\n=== 截图 ===')
  await js(`(() => { const a = document.querySelector('a[data-view="home"]'); if (a) a.click() })()`)
  await sleep(1200)
  fs.writeFileSync(path.join(SHOT, 'v2-calendar-interaction.png'), (await win.webContents.capturePage()).toPNG())
  console.log('  v2-calendar-interaction.png')

  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
  app.quit()
  setTimeout(() => process.exit(0), 1500)
})
