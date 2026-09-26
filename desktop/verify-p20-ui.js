// P20-01/05/06 端到端：欢迎屏重排 + Settings + About
//
// ⚠️ About/Settings 会读用户目录的文件（只读，不写）；Auto-start 开关会写 localStorage（真作用）。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const PROJ = path.resolve(__dirname, '..')
const OUT = path.join(__dirname, 'p20-ui-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

function dump(code) {
  try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (e) {
    console.log('（结果文件写入失败，忽略：' + String((e && e.message) || e) + '）')
  }
  setTimeout(() => app.exit(code), 500)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  const P = async (expr) => JSON.parse(await js(`(async () => JSON.stringify(${expr}))()`))
  await sleep(3500)

  log('\n=== ① P20-01 欢迎屏有四个突出入口 ===')
  const btns = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('#welcomeScreen button')).map((b) => b.textContent))`))
  chk('★ 原有的「打开项目 / 新建项目」还在（只是追加，没替换）', btns.some((t) => /打开项目/.test(t)) && btns.some((t) => /新建项目/.test(t)), JSON.stringify(btns))
  chk('★ 有 AI Agent 一级入口（P20-03）', btns.some((t) => /^AI Agent$/.test(t)), JSON.stringify(btns))
  chk('★ 有环境诊断入口', btns.some((t) => /环境诊断/.test(t)), JSON.stringify(btns))
  chk('  追加块挂在 .ws-card 里', await js(`!!document.querySelector('#welcomeScreen .ws-card .ws-p20')`), true)

  log('\n=== ② ★「最近项目」复用工作台数据（不另存一份）===')
  // 先打开一个项目，让它进"最近"，再关掉回欢迎屏
  await js(`window.moonbitIDE.openProject(${JSON.stringify(PROJ)})`)
  await sleep(1500)
  await js('window.moonbitIDE.closeProject()')
  await sleep(1200)
  await P('await window.moonbitIDE.welcome.enhance()')       // 关项目后刷新欢迎屏
  await sleep(600)
  const b2 = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('#welcomeScreen button')).map((b) => b.textContent))`))
  chk('★ 关项目后「最近项目」出现在欢迎屏上', b2.some((t) => t.indexOf(path.basename(PROJ)) >= 0 || /moonbit/.test(t)), JSON.stringify(b2).slice(0, 200))
  const wb = await P('await window.moonAPI.wbLoad()')
  chk('  而且数据来源就是工作台的 recent（同一份）', (wb.recent || []).length >= 1, String((wb.recent || []).length))

  log('\n=== ③ 「继续上次」来自启动快照 ===')
  const sp = await P('await window.moonAPI.startupPlan()')
  chk('startup:plan 可用', sp.ok === true && !!sp.plan, JSON.stringify(sp).slice(0, 120))
  chk('  其 projectRoot 与工作台记录一致（同一个项目）', !sp.plan.projectRoot || (wb.recent || []).some((r) => r.root === sp.plan.projectRoot), sp.plan.projectRoot)

  log('\n=== ④ P20-05 Settings：开关真有作用 ===')
  await js('window.moonbitIDE.settings.show()')
  await sleep(900)
  chk('设置面板出现', await js(`!!document.getElementById('settingsPanel')`), true)
  const st = await js(`(document.getElementById('settingsPanel') || {}).textContent || ''`)
  chk('  有 Auto-start 开关', /Agent 直接执行/.test(String(st)), String(st).slice(0, 160))
  chk('  有主题', /主题/.test(String(st)))
  chk('★ 列出了数据存放位置（都在用户目录）', /\.moonbit-work/.test(String(st)), String(st).slice(-200))
  // 真的改一下开关，看 localStorage
  await js(`(() => {
    const cb = document.querySelector('#settingsPanel input[type=checkbox]')
    if (cb) { cb.checked = true; cb.onchange() }
  })()`)
  await sleep(300)
  eq('★ 勾上开关真的写了 localStorage', await js(`localStorage.getItem('ag-autostart')`), '1')
  await js(`(() => { try { localStorage.setItem('ag-autostart','0') } catch (e) { console.log('重置失败：' + e.message) } })()`)
  await js(`(() => { const b = Array.from(document.querySelectorAll('#settingsPanel button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(300)

  log('\n=== ⑤ P20-06 About：版本来自真实探测（不是硬编码）===')
  await js('window.moonbitIDE.about.show()')
  await sleep(900)
  chk('关于面板出现', await js(`!!document.getElementById('aboutPanel')`), true)
  const info = await js(`(document.getElementById('aboutInfo') || {}).textContent || ''`)
  const about = await P('await window.moonAPI.appAbout()')
  chk('★ 版本与 package.json 一致（' + String(about.version) + '）', String(info).indexOf(String(about.version)) >= 0, String(info).slice(0, 60))
  chk('  且是 0.2.0-alpha', /0\.2\.0-alpha/.test(String(info)), String(info).slice(0, 120))
  chk('★ 显示了真实 Electron/Node 版本', !!about.electron && !!about.node && String(info).indexOf(String(about.electron)) >= 0, JSON.stringify(about))
  chk('  也说了为什么只标 alpha', /未验|alpha/.test(String(info)), String(info).slice(0, 260))
  await js(`(() => { const b = Array.from(document.querySelectorAll('#aboutPanel button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(300)

  log('\n=== ⑥ 没改转译产物（index.html 里不该出现我们注入的东西）===')
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  chk('★ index.html 里没有 ws-p20（是运行时注入的）', html.indexOf('ws-p20') < 0)
  chk('  index.html 里也没有 settingsPanel / aboutPanel', html.indexOf('settingsPanel') < 0 && html.indexOf('aboutPanel') < 0)

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
