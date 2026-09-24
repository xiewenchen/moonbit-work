// P5A 端到端验证：渲染侧收集**真实**状态 → 主进程组装 AgentRequest → 快照可读。
//
// 覆盖：
//   P5A-01/02  契约与校验（message 必填、非法输入被拒）
//   P5A-03     ProjectContext 是**真的**（打开真实项目后 projectType/rootDir 正确）
//   P5A-04     Problems 是**真的**（从统一问题模型取，且数量对得上）
//   P5A-05     快照能看到"Agent 实际收到了什么"
//
// 注意：断言用公共 verify-harness（P19-18 起禁止脚本自带局部 chk）。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(__dirname, 'agent-request-result.txt')
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
  await sleep(3000)

  log('\n=== ① 打开真实项目后再建请求（P5A-03）===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
  await sleep(1500)

  const built = await P(`await window.moonbitIDE.agentRequest.build('帮我看一下这个项目')`)
  chk('build() 成功', built.ok === true, JSON.stringify(built).slice(0, 160))
  const snap = built.snapshot || {}
  eq('快照里 projectType 来自真实识别', snap.project && snap.project.projectType, 'moonbit')
  eq('快照里 rootDir 是刚打开的项目', snap.project && path.basename(String(snap.project.rootDir)), path.basename(ROOT))
  eq('hasProject 为真', snap.hasProject, true)
  eq('requestId 已生成', typeof snap.requestId === 'string' && snap.requestId.length > 0, true)
  eq('message 原样带上', snap.message, '帮我看一下这个项目')
  chk('上下文长度 > 0（真渲染出了东西）', snap.contextChars > 0, String(snap.contextChars))

  log('\n=== ② 取数状态如实（哪一路拿到、哪一路没接）===')
  eq('projectContext 来源为 ok', snap.sources && snap.sources.project, 'ok')
  chk('problems 已接入（ok 或 empty，但绝不是 error）', ['ok', 'empty'].indexOf(snap.sources.problems) >= 0, snap.sources.problems)
  eq('activeFile 未接线 → absent（能区分"没接线"与"接线了没数据"）', snap.sources && snap.sources.activeFile, 'absent')

  log('\n=== ③ Problems 是真实的（P5A-04）===')
  const before = snap.problems.total
  await js(`window.moonbitIDE.problems.report(${JSON.stringify({
    severity: 'error', file: 'conduit/users.mbt', line: 42, message: 'P5A 探针问题', source: 'compiler',
  })})`)
  await sleep(300)
  const built2 = await P(`await window.moonbitIDE.agentRequest.build('再问一次')`)
  const snap2 = built2.snapshot || {}
  chk('造一个问题后，快照里的问题数增加了', snap2.problems.total > before, before + ' → ' + snap2.problems.total)
  eq('error 计数被正确归类', snap2.problems.bySeverity && snap2.problems.bySeverity.error >= 1, true)

  log('\n=== ④ 快照可读（P5A-05）===')
  chk('describe 是一行可读摘要', /req=/.test(String(built2.describe)) && /项目=moonbit/.test(String(built2.describe)), String(built2.describe))
  const last = await P('await window.moonbitIDE.agentRequest.lastSnapshot()')
  eq('lastSnapshot() 拿到的就是最近一次', last.snapshot && last.snapshot.requestId, snap2.requestId)

  log('\n=== ⑤ 校验：非法输入被拒（P5A-01）===')
  const empty = await P(`await window.moonbitIDE.agentRequest.build('')`)
  chk('空 message → 拒绝', empty.ok === false, JSON.stringify(empty))
  chk('  且说明原因', /message/.test(String((empty.errors || []).join(' '))), JSON.stringify(empty.errors))

  log('\n=== ⑥ 关闭项目后仍能提问（无项目态不崩）===')
  await js('window.moonbitIDE.closeProject()')
  await sleep(1200)
  const noProj = await P(`await window.moonbitIDE.agentRequest.build('没项目时问一句')`)
  chk('无项目时 build() 仍成功', noProj.ok === true, JSON.stringify(noProj).slice(0, 140))
  eq('  且 hasProject=false', noProj.snapshot && noProj.snapshot.hasProject, false)
  eq('  project 为 null', noProj.snapshot && noProj.snapshot.project, null)

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
