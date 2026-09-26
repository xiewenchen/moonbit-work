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

  log('\n=== ⑦ P9A：可验证的任务理解（接口层）===')
  {
    // 上一节把项目关了；这里重新打开（理解要基于真实 ProjectContext）
    await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
    await sleep(1500)
    const u = await P(`await window.moonbitIDE.agentRequest.understand('修复 conduit/users.mbt 的 500')`)
    chk('understand() 成功', u.ok === true, JSON.stringify(u).slice(0, 160))
    const t = u.understanding || {}
    eq('goal 就是那句话', t.goal, '修复 conduit/users.mbt 的 500')
    eq('project 来自真实 ProjectContext', t.project && t.project.projectType, 'moonbit')
    chk('相关文件里有任务提到的那个，且标了来源',
      (t.relevantFiles || []).some((f) => f.path === 'conduit/users.mbt' && f.why === 'mentionedInTask'),
      JSON.stringify(t.relevantFiles))
    eq('默认需要确认（Gate P8）', t.constraints && t.constraints.needsConfirmBeforeApply, true)
    eq('默认不自动执行', t.constraints && t.constraints.autoStart, false)
    chk('计划非空且每条都说明为什么', (t.proposedActions || []).length > 0 && t.proposedActions.every((a) => !!a.rule), JSON.stringify(t.proposedActions).slice(0, 120))
    chk('相关问题非空且带 id（能点开）', (t.relevantProblems || []).length > 0 && t.relevantProblems.every((p) => !!p.id), JSON.stringify(t.relevantProblems).slice(0, 140))

    // review 指出的穿越：`../../` 这类路径绝不能被当成"工作区里的文件"。
    // 这里放一个真实存在（hosts）与一个不存在的目标，两者都不该进 relevantFiles。
    const esc = await P(`await window.moonbitIDE.agentRequest.understand('看看 ../../../../Windows/System32/drivers/etc/hosts 和 ghost-does-not-exist.mbt')`)
    const escFiles = (esc.understanding && esc.understanding.relevantFiles) || []
    chk('越出 workspace 的路径被拒（不成为相关文件）',
      !escFiles.some((f) => /\\.\\.|Windows|drivers|etc/i.test(String(f.path))), JSON.stringify(escFiles))
    chk('  工作区里不存在的文件也被过滤',
      !escFiles.some((f) => f.path === 'ghost-does-not-exist.mbt'), JSON.stringify(escFiles))
    chk('describe 可读', /goal=/.test(String(u.describe)), String(u.describe))
    const last = await P('await window.moonbitIDE.agentRequest.lastUnderstanding()')
    chk('lastUnderstanding() 能取到最近一次理解', !!last.understanding && typeof last.understanding.goal === 'string', JSON.stringify(last).slice(0, 100))
  }

  log('\n=== ⑧ P9A：界面上真的出现"理解卡"与两个按钮（Confirm-first）===')
  {
    await js(`localStorage.removeItem('ag-autostart')`)   // 默认 Confirm-first
    // 注意：本页的快捷键是 **Ctrl/Cmd + Enter**（见 aiagent.js），不是单独 Enter；
    // 所以这里直接点发送按钮 —— 更贴近真实用户操作。
    const fired = await js(`(() => {
      const inp = document.getElementById('agInput')
      if (!inp) return 'no-input'
      const sb = document.getElementById('agSend')
      if (!sb) return 'no-send-button'
      if (sb.disabled) return 'disabled'
      inp.value = '修复 conduit/users.mbt 里那个 500'
      sb.click()
      return 'fired'
    })()`)
    eq('输入框与发送按钮存在且已点击', fired, 'fired')
    await sleep(2000)
    const cardText = await js(`(() => { const b = document.querySelector('.ag-understanding'); return b ? b.textContent : null })()`)
    chk('理解卡出现在界面上（P9A-03）', !!cardText, String(cardText).slice(0, 60))
    chk('卡上写明"能被核对的"（不是思维链）', /能被核对/.test(String(cardText)))
    chk('卡上列出了目标与项目', /目标：/.test(String(cardText)) && /项目：/.test(String(cardText)), String(cardText).slice(0, 140))
    const btns = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('.ag-understanding button')).map((b) => b.textContent))`))
    eq('两个按钮：开始执行 / 取消', btns, ['开始执行', '取消'])

    // review fix：Auto-start 开关必须**可见且能写** —— 否则只能靠 DevTools 改，行为不可发现
    eq('卡上有 Auto-start 开关', await js(`!!document.getElementById('agAutoStart')`), true)
    chk('  文案说明它不解除「改文件前必须确认」',
      /不影响「改文件前必须确认」/.test(String(cardText)), String(cardText).slice(-80))
    await js(`(() => { const c = document.getElementById('agAutoStart'); if (c) c.click() })()`)
    await sleep(200)
    eq('  点开关真的写进 localStorage', await js(`localStorage.getItem('ag-autostart')`), '1')
    await js(`localStorage.removeItem('ag-autostart')`)   // 还原，别影响后面的用例

    // P9A-05：点「取消」→ 卡消失 + 那句话读回输入框 + 什么动作都没执行
    await js(`(() => { const b = Array.from(document.querySelectorAll('.ag-understanding button')).find((x) => x.textContent === '取消'); if (b) b.click() })()`)
    await sleep(500)
    eq('取消后卡消失', await js(`!document.querySelector('.ag-understanding')`), true)
    eq('取消后那句话读回输入框（方便改了再问）',
      await js(`document.getElementById('agInput').value`), '修复 conduit/users.mbt 里那个 500')
  }

  log('\n=== ⑨ PH3-IDE-01/02：当前文件与选中代码真的进 Context ===')
  {
    // ① 没打开文件时 —— 不能假装有
    const s0 = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentRequest.build('看看当前文件')))()`))
    chk('★ 没打开文件时 activeFile 为空（不假装）', !(s0.snapshot && s0.snapshot.activeFile), JSON.stringify(s0.snapshot && s0.snapshot.activeFile))

    // ② 真打开一个文件（走真实 openFile，与文件树点击同一条路）
    const pkg = path.join(ROOT, 'desktop', 'package.json')
    await js(`window.moonbitIDE.editor.openFile(${JSON.stringify(pkg)})`)
    await sleep(900)
    const st = JSON.parse(await js(`JSON.stringify(window.moonbitIDE.editor.activeFile())`))
    chk('★ 真打开了文件（activeFile 有路径）', !!st && st.path === pkg, JSON.stringify(st && st.path))
    chk('  且带上了内容（agent 才能看）', !!st && st.content.length > 10, st ? String(st.content.length) : 'null')

    const s1 = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentRequest.build('这个文件是干什么的？')))()`))
    chk('★ 快照里出现了 activeFile（PH3-IDE-01 打通）', !!(s1.snapshot && s1.snapshot.activeFile), JSON.stringify(s1.snapshot && s1.snapshot.activeFile))
    chk('  快照记的是路径与字符数（不塞全文）', !!(s1.snapshot.activeFile && s1.snapshot.activeFile.path === pkg && s1.snapshot.activeFile.chars > 0), JSON.stringify(s1.snapshot.activeFile))
    chk('  sources.activeFile 标为 ok（不是 absent）', !!(s1.snapshot && s1.snapshot.sources && s1.snapshot.sources.activeFile === 'ok'), JSON.stringify(s1.snapshot && s1.snapshot.sources))

    // ③ 没选中时 —— 也不假装
    const s2 = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentRequest.build('选中了什么？')))()`))
    chk('★ 没有选区时 selection 为空（不假装）', !(s2.snapshot && s2.snapshot.selection), JSON.stringify(s2.snapshot && s2.snapshot.selection))

    // ④ 真选中 3 行
    const sel = JSON.parse(await js(`JSON.stringify(window.moonbitIDE.editor.selectLines(1, 3))`))
    chk('★ 真造出了一个选区', !!sel && sel.startLine === 1 && sel.endLine === 3, JSON.stringify(sel))
    chk('  且带上了选中文本', !!sel && typeof sel.text === 'string' && sel.text.length > 0, sel ? String(sel.text.length) : 'null')

    const s3 = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentRequest.build('解释我选中的这段')))()`))
    chk('★ 快照里出现了 selection（PH3-IDE-02 打通）', !!(s3.snapshot && s3.snapshot.selection), JSON.stringify(s3.snapshot && s3.snapshot.selection))
    chk('  行号对得上', !!(s3.snapshot.selection && s3.snapshot.selection.startLine === 1 && s3.snapshot.selection.endLine === 3), JSON.stringify(s3.snapshot.selection))
    chk('  sources.selection 标为 ok', !!(s3.snapshot && s3.snapshot.sources && s3.snapshot.sources.selection === 'ok'), JSON.stringify(s3.snapshot && s3.snapshot.sources))
    chk('★ 选中文本确实进了 Context（chars>0）', !!(s3.snapshot.selection && s3.snapshot.selection.chars > 0), JSON.stringify(s3.snapshot.selection))

    // ⑤ 清空选区后又回到"没有"
    await js(`window.moonbitIDE.editor.clearSelection()`)
    const s4 = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentRequest.build('再问一次')))()`))
    chk('★ 清空选区后 selection 又为空（状态是真读的，不是缓存的）', !(s4.snapshot && s4.snapshot.selection))
  }

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
