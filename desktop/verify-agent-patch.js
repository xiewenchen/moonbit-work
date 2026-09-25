// Patch 的 UI 接线验证（P8 补完）
//
// 验的是整条链路：**提案 → 预览（真实对话框）→ 用户点应用/取消 → 落盘或放弃**。
// 关键断言是"用户取消时文件一个字节都不许变" —— 这是 Patch 存在的意义。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const OUT = path.join(__dirname, 'agent-patch-result.txt')
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

// 造一个临时 workspace（不动用户真实项目）
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'mbpatch-'))
const SRC = path.join(WS, 'demo.mbt')
fs.writeFileSync(SRC, 'fn main {\n  println("hi")\n}\n', 'utf8')
// 造一个真的 .git/config（否则“危险目标”会被“路径解析不了”提前拦下，测不到危险判定本身）
fs.mkdirSync(path.join(WS, '.git'), { recursive: true })
fs.writeFileSync(path.join(WS, '.git', 'config'), '[core]\n', 'utf8')
const ORIGINAL = fs.readFileSync(SRC, 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  await sleep(3000)

  let pass = 0, fail = 0
    /** 布尔断言：**只接受布尔**（detail 仅在失败时显示）。
   *  ⚠️ 误用防护：传数组/对象进来会**立刻判失败**并提示用 `eq` ——
   *  历史上 25 处 `eq('x', [a,b], [c,d])` 因为数组恒为真而**永远通过**，等于没验。 */
  const chk = (n, ok, detail) => {
    if (typeof ok !== 'boolean') {
      fail++; log('  [FAIL] ' + n + '   ⚠️ chk 只接受布尔（数组/对象比较请用 eq）：' + JSON.stringify(ok))
      return
    }
    if (ok) { pass++; log('  [PASS] ' + n) } else { fail++; log('  [FAIL] ' + n + (detail ? '  ' + detail : '')) }
  }
  /** 相等断言：JSON 相等比较（数组/对象用这个）*/
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; log('  [PASS] ' + n) }
    else { fail++; log('  [FAIL] ' + n + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
  }
  const propose = async (p) => JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentTools.patch.propose(${JSON.stringify(p)})))()`))
  const apply = async (token) => JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentTools.patch.apply(${JSON.stringify(token)})))()`))
  const cancel = async (token) => JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentTools.patch.cancel(${JSON.stringify(token)})))()`))
  const readSrc = () => fs.readFileSync(SRC, 'utf8')

  log('\n=== ① 打开临时 workspace ===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(WS)})`)
  await sleep(1200)
  const ws = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.workspace()))()'))
  eq('workspace 指向临时项目', path.normalize(ws.workspace || ''), path.normalize(WS))

  log('\n=== ② propose：校验 + 预览 + token ===')
  const good = await propose({ file: 'demo.mbt', old: 'println("hi")', new: 'println("hello")', summary: '改输出' })
  eq('正常 patch → ok + token + preview', [good.ok, typeof good.token, /demo\.mbt/.test(String(good.preview))], [true, 'string', true])
  eq('带 diff 分析', [typeof good.analysis.addedLines, good.analysis.ok], ['number', true])

  eq('越界 → 拒', (await propose({ file: '../outside.mbt', old: 'a', new: 'b' })).reason, 'outside-workspace')
  eq('危险目标（.git）→ 拒', (await propose({ file: '.git/config', old: 'a', new: 'b' })).reason, 'dangerous')
  eq('old 匹配不上 → 拒', (await propose({ file: 'demo.mbt', old: '不存在的内容', new: 'x' })).reason, 'bad-patch')

  log('\n=== ③ 取消 → 文件一个字节都不许变 ===')
  {
    const p = await propose({ file: 'demo.mbt', old: 'println("hi")', new: 'println("CANCELED")', summary: '会被取消' })
    const c = await cancel(p.token)
    eq('cancel 成功', [c.ok, c.cancelled], [true, true])
    const after = await apply(p.token)                      // token 已失效
    eq('取消后 token 失效', [after.ok, after.reason], [false, 'no-token'])
    chk('**文件内容没变**', readSrc() === ORIGINAL, JSON.stringify(readSrc().slice(0, 30)))
  }

  log('\n=== ④ apply：真的改 + 真的备份 + token 一次性 ===')
  {
    const p = await propose({ file: 'demo.mbt', old: 'println("hi")', new: 'println("APPLIED")', summary: '真的改' })
    const r = await apply(p.token)
    eq('apply 成功', [r.ok, typeof r.backupPath], [true, 'string'])
    chk('文件真的改了', /APPLIED/.test(readSrc()), readSrc().slice(0, 40))
    chk('**备份存在且内容是改前的**', fs.existsSync(r.backupPath) && fs.readFileSync(r.backupPath, 'utf8') === ORIGINAL, true)
    eq('token 一次性（再 apply 被拒）', (await apply(p.token)).reason, 'no-token')
  }

  log('\n=== ⑤ 真实对话框：点「应用」===')
  {
    const before = readSrc()
    // fire-and-forget：让 proposeAndApply 挂在那里等用户点，我们再去点按钮
    await js(`(() => { window.__pr = window.moonbitIDE.agentTools.patch.proposeAndApply(${JSON.stringify({ file: 'demo.mbt', old: 'println("APPLIED")', new: 'println("VIA-DIALOG")', summary: '走对话框' })}); return 'started' })()`)
    await sleep(900)
    const has = await js(`!!document.getElementById('patchDialog')`)
    chk('对话框出现了', has, true)
    const btnText = await js(`Array.from(document.querySelectorAll('#patchDialog button')).map(b => b.textContent).join(',')`)
    eq('有「取消 / 应用」两个按钮', btnText, '取消,应用')
    const title = await js(`(document.querySelector('#patchDialog') || {}).textContent || ''`)
    chk('标题含文件名与摘要', /demo\.mbt/.test(String(title)) && /走对话框/.test(String(title)), true)

    await js(`Array.from(document.querySelectorAll('#patchDialog button')).find(b => b.textContent === '应用').click()`)
    await sleep(1200)
    chk('对话框已关闭', await js(`!document.getElementById('patchDialog')`), true)
    const r = JSON.parse(await js('(async () => JSON.stringify(await window.__pr))()'))
    chk('应用结果 ok', r.ok === true, JSON.stringify(r).slice(0, 80))
    chk('文件经对话框改了', /VIA-DIALOG/.test(readSrc()), readSrc().slice(0, 40))
    chk('改动前的内容确实不同', readSrc() !== before, true)
  }

  log('\n=== ⑥ 真实对话框：点「取消」→ 文件不变 ===')
  {
    const before = readSrc()
    await js(`(() => { window.__pr2 = window.moonbitIDE.agentTools.patch.proposeAndApply(${JSON.stringify({ file: 'demo.mbt', old: 'println("VIA-DIALOG")', new: 'println("SHOULD-NOT-APPEAR")', summary: '会被取消' })}); return 'started' })()`)
    await sleep(900)
    chk('对话框出现', await js(`!!document.getElementById('patchDialog')`), true)
    await js(`Array.from(document.querySelectorAll('#patchDialog button')).find(b => b.textContent === '取消').click()`)
    await sleep(1000)
    const r = JSON.parse(await js('(async () => JSON.stringify(await window.__pr2))()'))
    eq('结果是 cancelled', [r.ok, r.reason], [false, 'cancelled'])
    chk('**文件一个字节都没变**', readSrc() === before, readSrc().slice(0, 40))
    chk('对话框已关闭', await js(`!document.getElementById('patchDialog')`), true)
  }

  log('\n=== ⑦ 审计 ===')
  {
    const a = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.patch.audit()))()'))
    const rows = a.audit || []
    chk('有审计记录', rows.length >= 2, String(rows.length))
    eq('含 applied 与 cancelled 两类', [rows.some((x) => x.reason === 'applied'), rows.some((x) => x.reason === 'cancelled')], [true, true])
  }

  log('\n=== ⑧ Agent 侧没有"直接写文件"的能力 ===')
  {
    eq('patch API 只有 propose/apply/cancel（+审计）', JSON.parse(await js('JSON.stringify(Object.keys(window.moonbitIDE.agentTools.patch).sort())')),
      ['apply', 'audit', 'cancel', 'propose', 'proposeAndApply'])
    eq('没有 writeFile 这类入口', (await js('typeof window.moonbitIDE.agentTools.patch.writeFile')), 'undefined')
  }

  log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  try {
    fs.rmSync(WS, { recursive: true, force: true })
  } catch (e) {
    log('（临时目录清理失败，忽略：' + String((e && e.message) || e) + '）')
  }
  dump(fail === 0 ? 0 : 1)
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
