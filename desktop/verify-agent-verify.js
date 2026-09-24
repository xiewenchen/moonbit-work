// 验证闭环的接线验证（P9 接线段）
//
// 用**真实场景**：在本仓库上跑闭环 ——
//   check（`moon check --target native`）在本机是**成功**的；
//   test（`moon test --target native`）在本机是**失败**的（R12：本地工具链坏）。
//   于是闭环应当：check ✓ → test ✗ → **立刻停**（不跑 run/health）→ 报告 VERIFY_FAILED，
//   并把 test 的失败**灌进统一问题模型**（问题面板能看到）。
//
// 这正好覆盖了"失败即停"与"失败 → Problem"两条最关键的接线行为，且不需要 LLM。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, 'agent-verify-result.txt')
const ROOT = path.resolve(__dirname, '..')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
function dump(code) {
  try {
    fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  } catch (e) {
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
  await sleep(3000)

  let pass = 0, fail = 0
  const chk = (n, ok, d) => { if (ok) { pass++; log('  [PASS] ' + n) } else { fail++; log('  [FAIL] ' + n + (d ? '  ' + d : '')) } }

  log('\n=== ① 打开真实项目并确认识别结果 ===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
  await sleep(1500)
  const info = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.call("getProjectInfo")))()'))
  chk('已打开 MoonBit 项目', [info.ok, info.data && info.data.kind], [true, 'moonbit'])

  log('\n=== ② 跑闭环（真实 moon check / moon test）===')
  const t0 = Date.now()
  const r = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.verify.run("AGENTS.md")))()'))
  const elapsed = Date.now() - t0
  log('   耗时 ' + Math.round(elapsed / 1000) + 's；report=' + JSON.stringify(r.report || {}).slice(0, 200))

  chk('invoke 本身成功返回', r.ok === true, JSON.stringify(r).slice(0, 120))
  chk('**结论是未通过**（因为本机 moon test 是坏的）', r.verified === false, String(r.verified))
  chk('状态是 verify_failed', r.report && r.report.status, 'verify_failed')

  const steps = (r.report && r.report.steps) || []
  const names = steps.map((s) => s.name)
  chk('步骤含 apply 与 check', [names.includes('apply'), names.includes('check')], [true, true])
  chk('check 通过（本机 moon check 是好的）', (steps.find((s) => s.name === 'check') || {}).ok, true)
  chk('test 未通过', (steps.find((s) => s.name === 'test') || {}).ok === false, JSON.stringify(steps.find((s) => s.name === 'test')))
  chk('**失败即停：没有跑 run / health**', [names.includes('run'), names.includes('health')], [false, false])

  log('\n=== ③ 失败 → 统一 Problem ===')
  const ps = (r.report && r.report.problems) || []
  chk('产生了问题', ps.length >= 1, String(ps.length))
  chk('来源是 test', ps[0] && ps[0].source, 'test')
  chk('带严重度与描述', [ps[0] && ps[0].severity, typeof (ps[0] && ps[0].message)], ['error', 'string'])

  log('\n=== ④ 报告文本可用 ===')
  chk('返回了人可读报告', /验证报告/.test(String(r.text)) && /VERIFY_FAILED/.test(String(r.text)), String(r.text).slice(0, 80))
  chk('报告含步骤表', /\| 步骤 \| 结果 \|/.test(String(r.text)), true)

  log('\n=== ⑤ 结果确实进了问题面板（接线的意义）===')
  {
    const store = JSON.parse(await js('JSON.stringify(window.moonbitIDE.problems.list())'))
    chk('统一问题模型里有 test 来源的问题', store.some((p) => p.source === 'test'), JSON.stringify(store.map((p) => p.source)))
    const domRows = await js(`document.querySelectorAll('#problems .diag').length`)
    chk('问题面板渲染出了条目', domRows >= 1, String(domRows))
    const bodyText = await js('document.body.textContent')
    chk('输出面板里出现验证报告文本', /验证报告/.test(String(bodyText)), true)
  }

  log('\n=== ⑥ last() 与本次一致 ===')
  {
    const last = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.verify.last()))()'))
    chk('last().report 与刚才一致', [last.ok, last.report && last.report.status], [true, 'verify_failed'])
  }

  log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  dump(fail === 0 ? 0 : 1)
})
