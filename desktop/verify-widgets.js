// 验证工作台 widget：均匀网格 / 拖拽已挂载 / 增删 / 持久化
const { createHarness } = require('./verify-harness')
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

  const H = createHarness()
  const chk = H.chk

  console.log('=== ① SortableJS 是否真的可用（UMD 加载顺序对不对）===')
  const s0 = JSON.parse(await js(`(() => JSON.stringify({
    sortableType: typeof window.Sortable,
    version: window.Sortable && window.Sortable.version ? window.Sortable.version : '',
  }))()`))
  console.log('  ', JSON.stringify(s0))
  chk('window.Sortable 存在（没被 Monaco 的 define.amd 截胡）', s0.sortableType === 'function', s0.sortableType)
  chk('版本号可读', !!s0.version, s0.version)

  console.log('\n=== ② 工作台：均匀网格 + widget 数量 ===')
  await js(`(() => { const a = document.querySelector('a[data-view="home"]'); if (a) a.click() })()`)
  await sleep(1500)
  const w = JSON.parse(await js(`(() => {
    const grid = document.getElementById('dashGrid')
    const cs = grid ? getComputedStyle(grid) : null
    const cols = cs ? cs.gridTemplateColumns.split(' ').filter(Boolean) : []
    const ws = Array.from(document.querySelectorAll('#dashGrid .widget'))
    return JSON.stringify({
      count: ws.length,
      types: ws.map(x => x.dataset.type),
      cols: cols.length,
      colWidths: Array.from(new Set(cols)),
      eachHasDrag: ws.every(x => !!x.querySelector('.drag')),
      eachHasDel: ws.every(x => !!x.querySelector('.del')),
      sortableBound: !!(grid && window.Sortable && window.Sortable.get(grid)),
      handle: (window.Sortable && grid) ? (window.Sortable.get(grid) ? window.Sortable.get(grid).options.handle : '') : '',
    })
  })()`))
  console.log('  ', JSON.stringify(w))
  chk('默认 5 个 widget', w.count === 5, String(w.count))
  chk('每个都有拖拽手柄 .drag', w.eachHasDrag === true)
  chk('每个都有删除按钮 .del', w.eachHasDel === true)
  chk('Sortable 已绑定到网格', w.sortableBound === true)
  chk('只允许手柄拖动（handle=.drag）', w.handle === '.drag', w.handle)
  chk('网格多列（不是单列堆叠）', w.cols >= 2, `列数 ${w.cols}`)
  chk('各列等宽 → 组件「均匀大小」', w.colWidths.length === 1, JSON.stringify(w.colWidths))

  console.log('\n=== ③ 删除一个组件 ===')
  const del = JSON.parse(await js(`(async () => {
    document.querySelector('#dashGrid .widget .del').click()
    await new Promise(r => setTimeout(r, 500))
    return JSON.stringify({
      count: document.querySelectorAll('#dashGrid .widget').length,
      stored: JSON.parse(localStorage.getItem('moonbit-dash-layout') || '[]').length,
    })
  })()`))
  console.log('  ', JSON.stringify(del))
  chk('删掉后剩 4 个', del.count === 4, String(del.count))
  chk('删除已写入 localStorage', del.stored === 4, String(del.stored))

  console.log('\n=== ④ 用「+ 添加组件」加回来 ===')
  const add = JSON.parse(await js(`(async () => {
    document.getElementById('dashAdd').click()
    await new Promise(r => setTimeout(r, 400))
    const picker = document.getElementById('dashPicker')
    const btns = picker ? Array.from(picker.querySelectorAll('button')) : []
    const first = btns[0] ? btns[0].textContent : ''
    if (btns[0]) btns[0].click()
    await new Promise(r => setTimeout(r, 500))
    return JSON.stringify({
      pickerShown: !!picker,
      options: btns.length,
      picked: first,
      count: document.querySelectorAll('#dashGrid .widget').length,
      stored: JSON.parse(localStorage.getItem('moonbit-dash-layout') || '[]').length,
    })
  })()`))
  console.log('  ', JSON.stringify(add))
  chk('浮层出现且有候选组件', add.pickerShown && add.options >= 1, JSON.stringify(add))
  chk('添加后回到 5 个', add.count === 5, String(add.count))
  chk('添加已写入 localStorage', add.stored === 5, String(add.stored))

  console.log('\n=== ⑤ 拖拽排序后顺序持久化（直接改 DOM 再触发 onEnd 的等价路径）===')
  const order = JSON.parse(await js(`(async () => {
    const grid = document.getElementById('dashGrid')
    const ws = Array.from(grid.querySelectorAll('.widget'))
    // 把最后一个挪到最前，模拟拖拽结果
    grid.insertBefore(ws[ws.length - 1], ws[0])
    const s = window.Sortable.get(grid)
    s.options.onEnd()
    await new Promise(r => setTimeout(r, 400))
    return JSON.stringify({
      dom: Array.from(grid.querySelectorAll('.widget')).map(x => x.dataset.type),
      stored: JSON.parse(localStorage.getItem('moonbit-dash-layout') || '[]'),
    })
  })()`))
  console.log('  ', JSON.stringify(order))
  chk('DOM 顺序 = 持久化顺序（拖拽结果被记住）', JSON.stringify(order.dom) === JSON.stringify(order.stored), `${order.dom} vs ${order.stored}`)

  console.log('\n=== ⑥ 截图 ===')
  await js(`(() => { const a = document.querySelector('a[data-view="home"]'); if (a) a.click() })()`)
  await sleep(1200)
  fs.writeFileSync(path.join(SHOT, 'dashboard-widgets.png'), (await win.webContents.capturePage()).toPNG())
  console.log('  dashboard-widgets.png')

  console.log('\n' + H.summary())
  app.quit()
  setTimeout(() => process.exit(H.exitCode()), 1500)
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
