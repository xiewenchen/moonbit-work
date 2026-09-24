// 验证主菜单（办公台）：时钟/日历/待办/便签 + 4 个主视图切换 + 截图
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

  console.log('=== ① 主菜单（办公台）===')
  await js(`(() => { const a = document.querySelector('a[data-view="home"]'); if (a) a.click() })()`)
  await sleep(1500)
  const d = JSON.parse(await js(`(() => JSON.stringify({
    clock: (document.getElementById('dashClock') || {}).textContent || '',
    date: (document.getElementById('dashDate') || {}).textContent || '',
    cal: document.querySelectorAll('#dashCalendar .d').length,
    today: document.querySelectorAll('#dashCalendar .d.today').length,
    todos: (document.getElementById('dashTodos') || {}).textContent || '',
    todoInput: !!document.querySelector('#dashTodos input'),
    todoPh: (document.querySelector('#dashTodos input') || {}).placeholder || '',
    note: !!document.getElementById('dashNoteArea'),
    agenda: (document.getElementById('dashAgenda') || {}).textContent || '',
  }))()`))
  console.log('  ', JSON.stringify(d))
  chk('时钟在走（HH:MM:SS）', /^\d{2}:\d{2}:\d{2}$/.test(d.clock), d.clock)
  chk('日期含「星期」', d.date.includes('星期'), d.date)
  chk('日历渲染当月格子', d.cal >= 28, `格子 ${d.cal}`)
  chk('今天被高亮（1 个）', d.today === 1, `高亮 ${d.today}`)
  chk('待办区有输入框', d.todoInput === true, JSON.stringify(d.todoInput))
  chk('待办输入框有 placeholder', String(d.todoPh).includes('添加待办'), d.todoPh)
  chk('便签 textarea 已建', d.note === true)
  chk('日程区有内容或空状态', d.agenda.length > 0, d.agenda.slice(0, 30))

  console.log('\n=== ② 主视图切换（主页≠编辑器）===')
  for (const v of ['home', 'project', 'agent', 'tools']) {
    const r = JSON.parse(await js(`(async () => {
      const a = document.querySelector('a[data-view="${v}"]'); if (a) a.click()
      await new Promise(r => setTimeout(r, 500))
      const shown = Array.from(document.querySelectorAll('.mainview')).filter(m => getComputedStyle(m).display !== 'none').map(m => m.id)
      const wb = document.getElementById('workbench')
      // display 不继承：父容器 display:none 时子元素计算值仍是 flex，
      // 所以「是否可见」要看 offsetParent（被 display:none 的祖先藏住时为 null）
      return JSON.stringify({ shown, wbVisible: !!(wb && wb.offsetParent) })
    })()`))
    chk(`点「${v}」→ 只显示 mainview-${v}`, r.shown.length === 1 && r.shown[0] === 'mainview-' + v, r.shown.join(','))
    // 关键：非「项目」标签下，编辑器必须不可见
    if (v !== 'project') {
      chk(`   └ 「${v}」里看不到编辑器`, r.wbVisible === false, String(r.wbVisible))
    } else {
      chk('   └ 「项目」里能看到编辑器', r.wbVisible === true, String(r.wbVisible))
    }
  }

  console.log('\n=== ③ 4 个标签的图标互不相同 ===')
  const icons = await js(`(() => {
    const out = {}
    for (const a of document.querySelectorAll('a[data-view]')) {
      const svg = a.querySelector('svg')
      out[a.dataset.view] = svg ? svg.innerHTML.length + ':' + (svg.querySelectorAll('rect').length + '/' + svg.querySelectorAll('path').length + '/' + svg.querySelectorAll('circle').length) : 'none'
    }
    return JSON.stringify(out)
  })()`)
  console.log('  ', icons)
  const uni = new Set(Object.values(JSON.parse(icons)))
  chk('4 个图标各不相同', uni.size === 4, `不同变体 ${uni.size}`)

  console.log('\n=== ④ 截图 ===')
  for (const v of ['home', 'project', 'agent', 'tools']) {
    await js(`(() => { const a = document.querySelector('a[data-view="${v}"]'); if (a) a.click() })()`)
    await sleep(1100)
    fs.writeFileSync(path.join(SHOT, v + '.png'), (await win.webContents.capturePage()).toPNG())
    console.log(`  截图: ${v}.png`)
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
  app.quit()
  setTimeout(() => process.exit(0), 1500)
}).catch((e) => { log('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
