// 工作台（主菜单）基础呈现验证 —— **按新 UI 重写过**
//
// 背景：这个脚本原来期望的是旧工作台的 DOM（dashCalendar / dashTodos / dashNoteArea /
// dashAgenda），而那些 id 在 dash.js 里**出现 0 次** —— 工作台早就重写成
// dashClock / dashDate / dashGrid（dash-clock / dash-cal / dash-note / dash-slot）了。
// 所以它一直报"10 通过 / 7 失败"，看着像实现坏了，其实是**测试在测一套不存在的 UI**。
//
// 重写时同时去重：日历 / 今天高亮 / 翻月 / 点选日期 / 日程 / 便签**都已经由
// verify-dash-v2.js 覆盖**，这里只保留它没验的那几项：
//   ① 时钟真的在走（HH:MM:SS）
//   ② 日期里含「星期」
//   ③ 待办区有输入框（且带 placeholder）
//   ④ 图标各不相同的（不是同一个图标复制）
//   ⑤ 「项目」标签里能看到编辑器
//
// 断言用公共 verify-harness（P19 起所有脚本统一）。
const { createHarness } = require('./verify-harness')
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, 'dash-result.txt')
const SHOT = path.join(__dirname, 'e2e-shots', 'dash')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

function dump(code) {
  try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (e) {
    console.log('（结果文件写入失败，忽略：' + String((e && e.message) || e) + '）')
  }
  setTimeout(() => app.exit(code), 1500)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  win.show(); win.focus()
  await sleep(3000)
  const js = (c) => win.webContents.executeJavaScript(c, true)
  fs.mkdirSync(SHOT, { recursive: true })
  // capturePage 偶发 UnknownVizError（窗口重绘竞争），失败不应中断整个验证
  const safeShot = async (name) => {
    try { fs.writeFileSync(path.join(SHOT, name), (await win.webContents.capturePage()).toPNG()); console.log('  截图 ' + name) }
    catch (e) { console.log('  截图失败（不影响结论）: ' + name) }
  }

  // 确保停在主菜单（工作台在这里）
  await js(`(() => { const a = document.querySelector('a[data-view="home"]'); if (a) a.click() })()`)
  await sleep(1200)

  log('\n=== ① 时钟在走（HH:MM:SS）===')
  const t1 = await js(`(document.getElementById('dashClock') || {}).textContent || ''`)
  chk('时钟元素存在且有内容', String(t1).length > 0, String(t1))
  chk('★ 格式是 HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(String(t1).trim()), String(t1))
  await sleep(2200)
  const t2 = await js(`(document.getElementById('dashClock') || {}).textContent || ''`)
  chk('★ 两秒后时间变了（说明真的在走，不是静态文本）', String(t1) !== String(t2), t1 + ' → ' + t2)

  log('\n=== ② 日期里含「星期」===')
  const d = await js(`(document.getElementById('dashDate') || {}).textContent || ''`)
  chk('日期元素存在且有内容', String(d).length > 0, String(d))
  chk('★ 含「星期X」', /星期[日一二三四五六]/.test(String(d)), String(d))
  chk('  也含年月日', /\d{4}\s*年/.test(String(d)) && /月/.test(String(d)), String(d))

  log('\n=== ③ 待办区有输入框（带 placeholder）===')
  const todo = JSON.parse(await js(`(() => {
    const boxes = Array.from(document.querySelectorAll('#dashGrid input[type="text"], #dashGrid input:not([type])'))
    const ph = boxes.map((b) => b.placeholder).filter(Boolean)
    return JSON.stringify({ count: boxes.length, placeholders: ph })
  })()`))
  chk('★ 工作台里至少有一个文本输入框', todo.count >= 1, JSON.stringify(todo))
  chk('  且带 placeholder（说明是给人用的输入框）', todo.placeholders.length >= 1, JSON.stringify(todo.placeholders))

  log('\n=== ④ 图标各不相同（不是同一个图标复制）===')
  const icons = JSON.parse(await js(`(() => {
    const svgs = Array.from(document.querySelectorAll('#dashGrid svg, .dash-grid svg, #mainview-home svg'))
    // 用 path 的 d 属性当指纹（同一个图标复制出来的会完全一样）
    const ds = svgs.map((s) => (s.querySelector('path') || {}).getAttribute ? (s.querySelector('path').getAttribute('d') || '') : '').filter(Boolean)
    return JSON.stringify({ total: svgs.length, distinct: new Set(ds).size })
  })()`))
  chk('页面上有图标', icons.total >= 1, JSON.stringify(icons))
  chk('★ 图标不是同一个复制出来的（不同指纹数 ≥ 2）', icons.distinct >= 2, JSON.stringify(icons))

  log('\n=== ⑤ 「项目」标签里能看到编辑器 ===')
  const proj = JSON.parse(await js(`(() => {
    const a = document.querySelector('a[data-view="project"]')
    if (a) a.click()
    return JSON.stringify({ clicked: !!a })
  })()`))
  chk('找到了「项目」标签并点击', proj.clicked === true, JSON.stringify(proj))
  await sleep(1500)
  const pv = JSON.parse(await js(`(() => {
    const mv = document.getElementById('mainview-project')
    const visible = !!mv && getComputedStyle(mv).display !== 'none'
    // 编辑器可能是 monaco 或 textarea，找任一
    const ed = mv ? mv.querySelector('.monaco-editor, textarea, [class*=editor]') : null
    return JSON.stringify({ visible, hasEditor: !!ed })
  })()`))
  chk('★「项目」视图可见', pv.visible === true, JSON.stringify(pv))
  chk('★ 里面有编辑器容器', pv.hasEditor === true, JSON.stringify(pv))

  await safeShot('dash-basic.png')
  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => {
  console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1)
})
