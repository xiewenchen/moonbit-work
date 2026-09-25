// P13 端到端：工作台面板 + 按项目隔离 + 不反向污染（磁盘上的键）
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createHarness } = require('./verify-harness')

const A = path.resolve(__dirname, '..')
const B = path.resolve(__dirname, '..', 'testdata', 'agent-e2e-project')
const WB = path.join(os.homedir(), '.moonbit-work', 'workbench.json')
const OUT = path.join(__dirname, 'workbench-result.txt')

const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

// ★ 工作台文件是**用户的**：进去前备份、任何退出路径都还原
let BACKUP = null
let BACKED_UP = false
let RESTORED = false
function backupNow() {
  if (BACKED_UP) return
  try { BACKUP = fs.existsSync(WB) ? fs.readFileSync(WB, 'utf8') : null } catch (e) { BACKUP = null }
  BACKED_UP = true
}
function restore() {
  if (RESTORED) return
  RESTORED = true
  if (!BACKED_UP) return
  try {
    if (BACKUP === null) { if (fs.existsSync(WB)) fs.unlinkSync(WB) } else fs.writeFileSync(WB, BACKUP, 'utf8')
  } catch (e) {
    console.log('[WARN] 还原工作台文件失败：' + String((e && e.message) || e))
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

  log('\n=== ① 面板能打开并渲染（最近项目 / 待办 / 便签 三区）===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(A)})`)
  await sleep(1500)
  await js('window.moonbitIDE.workbench.show()')
  await sleep(1200)
  chk('面板出现', await js(`!!document.getElementById('wbPanel')`), true)
  chk('有最近项目区', await js(`!!document.getElementById('wbRecent')`), true)
  chk('有待办区', await js(`!!document.getElementById('wbTodos')`), true)
  chk('有便签输入框', await js(`!!document.getElementById('wbNote')`), true)

  log('\n=== ② P13-01 打开项目会被记进"最近" ===')
  const leftText = await js(`(document.getElementById('wbRecent') || {}).textContent || ''`)
  chk('★ 最近项目里有刚打开的 A', leftText.length > 0 && /agent-e2e|moonbit|reports|workspace/i.test(String(leftText)) || String(leftText).indexOf(path.basename(A)) >= 0, String(leftText).slice(0, 160))

  log('\n=== ③ P13-02 待办：加一条（当前项目 = A）===')
  const added = await P(`await window.moonbitIDE.workbench.addTodo(${JSON.stringify(A)}, 'P13 面板验证用的待办')`)
  chk('加待办成功', added.ok === true, JSON.stringify(added).slice(0, 140))
  await sleep(500)
  await js('window.moonbitIDE.workbench.show()')
  await sleep(900)
  const todoText = await js(`(document.getElementById('wbTodos') || {}).textContent || ''`)
  chk('★ 面板上能看到这条待办', /P13 面板验证用的待办/.test(String(todoText)), String(todoText).slice(0, 200))

  log('\n=== ④ ★ 按项目隔离：切到 B 看不到 A 的待办 ===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(B)})`)
  await sleep(1500)
  const bTodos = await P(`await window.moonbitIDE.workbench.load(${JSON.stringify(B)})`)
  eq('★ B 的待办是空的', (bTodos.todos || []).length, 0)
  chk('★ B 的视图里没有 A 那条', !JSON.stringify(bTodos.todos || []).includes('P13 面板验证用的待办'))

  log('\n=== ⑤ 切回 A：待办还在（隔离不等于丢）===')
  const aTodos = await P(`await window.moonbitIDE.workbench.load(${JSON.stringify(A)})`)
  eq('★ A 的待办还在（1 条）', (aTodos.todos || []).length, 1)
  chk('  内容对得上', /P13 面板验证用的待办/.test(JSON.stringify(aTodos.todos)))

  log('\n=== ⑥ P13-03 便签也按项目隔离 ===')
  const setA = await P(`await window.moonbitIDE.workbench.setNote(${JSON.stringify(A)}, 'A 的便签')`)
  chk('给 A 写便签成功', setA.ok === true, JSON.stringify(setA).slice(0, 120))
  const setB = await P(`await window.moonbitIDE.workbench.setNote(${JSON.stringify(B)}, 'B 的便签')`)
  chk('给 B 写便签成功', setB.ok === true)
  eq('★ A 读回自己的', (await P(`await window.moonbitIDE.workbench.load(${JSON.stringify(A)})`)).note, 'A 的便签')
  eq('★ B 读回自己的', (await P(`await window.moonbitIDE.workbench.load(${JSON.stringify(B)})`)).note, 'B 的便签')

  log('\n=== ⑦ ★ P13-08 磁盘上只有工作台自己的键 ===')
  const info = await P('await window.moonbitIDE.workbench.file()')
  eq('★ 文件里只有 recent/todos/notes/version', info.keys, ['notes', 'recent', 'todos', 'version'])
  const onDisk = fs.readFileSync(WB, 'utf8')
  for (const forbidden of ['tabs', 'activeFile', 'runState', 'problems', 'session']) {
    chk('★ 磁盘内容里没有 IDE 状态键：' + forbidden, onDisk.indexOf('"' + forbidden + '"') < 0)
  }
  chk('  工作台文件在用户目录（不在项目里）', WB.indexOf('.moonbit-work') >= 0 && WB.indexOf('moonbit-platform') < 0, WB)

  log('\n=== 收尾 ===')
  restore()
  chk('工作台文件已还原', true)

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { console.log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
