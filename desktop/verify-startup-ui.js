// P20 端到端：启动恢复 / 异常退出降级 / 环境诊断 / 面板统一入口
//
// ⚠️ 会写 ~/.moonbit-work/startup.json（用户的），进去前备份、任何退出路径都还原。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createHarness } = require('./verify-harness')

const FILE = path.join(os.homedir(), '.moonbit-work', 'startup.json')
const OUT = path.join(__dirname, 'startup-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

let BACKUP = null
let BACKED_UP = false
let RESTORED = false
function backupNow() {
  if (BACKED_UP) return
  try { BACKUP = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null } catch (e) { BACKUP = null }
  BACKED_UP = true
}
function restore() {
  if (RESTORED) return
  RESTORED = true
  if (!BACKED_UP) return
  try {
    if (BACKUP === null) { if (fs.existsSync(FILE)) fs.unlinkSync(FILE) } else fs.writeFileSync(FILE, BACKUP, 'utf8')
  } catch (e) {
    console.log('[WARN] 还原 startup.json 失败：' + String((e && e.message) || e))
  }
}
function dump(code) {
  restore()
  try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (e) {
    console.log('（结果文件写入失败，忽略：' + String((e && e.message) || e) + '）')
  }
  setTimeout(() => app.exit(code), 500)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

backupNow()

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  const P = async (expr) => JSON.parse(await js(`(async () => JSON.stringify(${expr}))()`))
  await sleep(3000)

  log('\n=== ① P20 面板统一入口（让 7 个面板可见）===')
  await js('window.moonbitIDE.panels.menu()')
  await sleep(800)
  chk('面板菜单出现', await js(`!!document.getElementById('panelMenu')`), true)
  const btns = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('#panelMenu button')).map((b) => b.textContent))`))
  chk('★ 列出了 7 个面板 + 关闭', btns.length === 8, JSON.stringify(btns))
  chk('  含环境诊断', btns.some((t) => /环境诊断/.test(t)), JSON.stringify(btns))
  chk('  含工作台/工程状态/数据库/会话/项目知识/办公文件', ['工作台', '工程状态', '数据库', '会话', '项目知识', '办公文件'].every((k) => btns.some((t) => t.indexOf(k) >= 0)), JSON.stringify(btns))
  // 点第一个（环境诊断）应该真的打开环境面板
  await js(`(() => { const b = Array.from(document.querySelectorAll('#panelMenu button')).find((x) => /环境诊断/.test(x.textContent)); if (b) b.click() })()`)
  await sleep(2000)
  chk('★ 点「环境诊断」真的打开了环境面板', await js(`!!document.getElementById('envPanel')`), true)
  chk('  且菜单已关闭（不叠两层）', await js(`!document.getElementById('panelMenu')`), true)

  log('\n=== ② P20-09 环境检查：5 项都在 + 只说事实 ===')
  const items = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('#envList > div')).map((d) => d.textContent))`))
  chk('列了 5 项', items.length === 5, String(items.length))
  chk('★ 每项都写了"为什么需要"', items.every((t) => /为什么需要：/.test(String(t))), JSON.stringify(items).slice(0, 160))
  const env = await P('await window.moonbitIDE.env.check()')
  chk('env.check 返回 ok', env.ok === true)
  chk('  含 items 与 summary', (env.env.items || []).length === 5 && typeof env.env.summary === 'string', JSON.stringify(env.env.summary))
  // node 一定在（我们就是 node 跑的）
  eq('★ node 一定检测到', env.env.items.find((x) => x.id === 'node').found, true)
  chk('  并带版本号', /\d+\.\d+/.test(String(env.env.items.find((x) => x.id === 'node').version)), String(env.env.items.find((x) => x.id === 'node').version))
  chk('★ 缺的项给了可执行建议（不是"环境异常"）', env.env.items.filter((x) => !x.found).every((x) => !!x.hint && x.hint.length > 10), JSON.stringify(env.env.items.filter((x) => !x.found).map((x) => x.id)))
  await js(`(() => { const b = Array.from(document.querySelectorAll('#envPanel button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(300)

  log('\n=== ③ ★ P20-07/08 启动恢复：正常退出 vs 异常退出 ===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(path.resolve(__dirname, '..'))})`)
  await sleep(1500)
  // 模拟一次"正常退出"：先更新位置，再 markCleanExit
  await P(`await window.moonbitIDE.startup.update({ projectRoot: ${JSON.stringify(path.resolve(__dirname, '..'))}, tabs: ['a.mbt', 'b.mbt'], activeFile: 'b.mbt' })`)
  await P('await window.moonbitIDE.startup.markCleanExit()')
  const planClean = await P('await window.moonbitIDE.startup.plan()')
  eq('正常退出 → reason=clean-exit', planClean.plan.reason, 'clean-exit')
  eq('★ 标签被完整恢复', planClean.plan.tabs.length, 2)
  eq('★ 当前文件也恢复', planClean.plan.activeFile, 'b.mbt')

  // 模拟"异常退出"：只 markRunning（没有 cleanExit）
  await P('await window.moonbitIDE.startup.markRunning()')
  const planCrash = await P('await window.moonbitIDE.startup.plan()')
  eq('★ 异常退出被识别', planCrash.plan.reason, 'after-crash')
  eq('★★ 只恢复项目', planCrash.plan.projectRoot, path.resolve(__dirname, '..'))
  eq('★★ 标签不恢复', planCrash.plan.tabs.length, 0)
  eq('★★ 当前文件不恢复', planCrash.plan.activeFile, null)
  chk('  并说明了为什么', /没有正常退出/.test(planCrash.plan.message), planCrash.plan.message)

  log('\n=== ④ 磁盘上只有启动快照该有的键 ===')
  const info = await P('await window.moonbitIDE.startup.file()')
  chk('文件路径在用户目录', String(info.file).indexOf('.moonbit-work') >= 0, info.file)
  eq('★ 键只有快照该有的那些', info.keys, ['activeFile', 'at', 'cleanExit', 'projectRoot', 'projectType', 'running', 'tabs', 'version'])
  chk('★ 快照里没有文件正文（只记位置）', !JSON.stringify(info.snapshot).includes('fn main'), JSON.stringify(info.snapshot).slice(0, 120))

  log('\n=== 收尾 ===')
  restore()
  chk('startup.json 已还原', true)

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
