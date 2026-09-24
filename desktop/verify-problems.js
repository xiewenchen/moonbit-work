// 问题统一模型的接线验证（P4-10 + Gate P4）
//
// 验的是「五类问题真的进了同一个 Store，并且面板从它渲染」——
// 而不只是"模型单测通过"（那已经由 test-problem-model.js 覆盖）。
//
// 用 window.moonbitIDE.problems.report(...) 写入一条「Agent 发现」（P4-08 的正当入口），
// 再断言：面板出现该行、list() 能看到、重复写入被去重、点击能跳到源码。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, 'problems-result.txt')
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

const ROOT = path.resolve(__dirname, '..')
const TARGET_FILE = path.join(ROOT, 'hello', 'cmd', 'main', 'main.mbt')   // 一个真实存在的源文件

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  await sleep(3000)

  let pass = 0, fail = 0
  const chk = (n, ok, d) => { if (ok) { pass++; log('  [PASS] ' + n) } else { fail++; log('  [FAIL] ' + n + (d ? '  ' + d : '')) } }

  log('\n=== ① 模块加载 ===')
  chk('window.MoonbitProblems 存在（script 已加载）', (await js('typeof window.MoonbitProblems')) === 'object', await js('typeof window.MoonbitProblems'))
  chk('window.moonbitIDE.problems 存在', (await js('typeof window.moonbitIDE.problems')) === 'object', await js('typeof window.moonbitIDE.problems'))
  chk('五个来源常量齐备', (await js('Object.keys(window.MoonbitProblems.PROBLEM_SOURCE).sort().join(",")')), 'AGENT,API,COMPILER,LSP,RUNTIME,TEST')

  log('\n=== ② 初始：没有问题 ===')
  {
    await js('window.moonbitIDE.problems.refresh()')
    await sleep(300)
    chk('list() 为空', (await js('window.moonbitIDE.problems.list().length')) === 0, await js('String(window.moonbitIDE.problems.list().length)'))
    const panelText = await js(`(() => { const el = document.getElementById('problems'); return el ? el.textContent.trim() : 'no-el' })()`)
    chk('面板显示「没有问题」', /没有问题/.test(String(panelText)), String(panelText).slice(0, 40))
  }

  log('\n=== ③ 写入一条「Agent 发现」→ 面板出现（P4-08 + 面板接线）===')
  {
    const n = await js(`window.moonbitIDE.problems.report(${JSON.stringify({ message: '这里的边界条件可能有问题', file: TARGET_FILE, line: 3, severity: 'warning' })})`)
    chk('report() 写入 1 条', n === 1, String(n))
    await sleep(300)
    const list = JSON.parse(await js('JSON.stringify(window.moonbitIDE.problems.list())'))
    chk('list() 能看到，且来源是 agent', [list.length, list[0] && list[0].source], [1, 'agent'])
    chk('severity 与位置正确', [list[0].severity, list[0].line], ['warning', 3])

    const rows = await js(`document.querySelectorAll('#problems .diag').length`)
    chk('问题面板渲染出 1 行', rows === 1, String(rows))
    const text = await js(`(() => { const el = document.getElementById('problems'); return el ? el.textContent : '' })()`)
    chk('面板文本含文件名与消息', /main\.mbt/.test(String(text)) && /边界条件/.test(String(text)), String(text).slice(0, 80))
  }

  log('\n=== ④ 去重 + stats（P4-11）===')
  {
    await js(`window.moonbitIDE.problems.report(${JSON.stringify({ message: '这里的边界条件可能有问题', file: TARGET_FILE, line: 3, severity: 'warning' })})`)
    await sleep(200)
    chk('相同发现再报一次 → 仍是 1 条', (await js('window.moonbitIDE.problems.list().length')) === 1, await js('String(window.moonbitIDE.problems.list().length)'))
    const st = JSON.parse(await js('JSON.stringify(window.moonbitIDE.problems.stats())'))
    chk('stats 反映 agent 来源', [st.total, st.bySource.agent], [1, 1])
  }

  log('\n=== ⑤ 点击跳转（P4-10）===')
  {
    const before = await js('document.querySelectorAll("#tabs .tab").length')
    await js(`(() => { const row = document.querySelector('#problems .diag'); if (row) row.click() })()`)
    await sleep(1200)
    const after = await js('document.querySelectorAll("#tabs .tab").length')
    const opened = await js(`(() => { const t = document.querySelector('#tabs .tab'); return t ? t.textContent : '' })()`)
    chk('点击后打开了文件（标签页增加）', after > before, `before=${before} after=${after}`)
    chk('打开的是目标文件', /main\.mbt/.test(String(opened)), String(opened))
  }

  log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  dump(fail === 0 ? 0 : 1)
})
