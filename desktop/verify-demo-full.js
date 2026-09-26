// P21 产品级演示：用一个**真实** MoonBit 后端项目（conduit）把整套能力串一遍。
//
// 与 verify-agent-e2e 的分工：
//   · 那个验的是 **Agent 那条链**（Ask→Understand→Read→Diagnose→Patch→Confirm→Check→Test→Run→Health→Report）
//   · 这个演示的是**产品全貌**：17 步里既有 Agent，也有 Quality / Database / 项目便签
//
// ⚠️ 一条原则：**不做"看起来全绿"的演示**。本机 R12（MoonBit native 工具链坏）
// 导致 test/run 跑不起来，Browser 需要真起服务 —— 这些步骤**如实标成"因环境没跑"**，
// 而不是跳过不提、也不是记成失败。最后会汇总"跑了 N 步 / 未跑 M 步及原因"。
//
// ⚠️ 会改 conduit/ 的**真实源码**（P21-01 要求"注入一个故意错误"），所以先备份、
// 任何退出路径都还原。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')
const { createMockLlm } = require('./mock-llm')
const { runToolLoop } = require('./agent-adapter')

const PROJ = path.resolve(__dirname, '..', 'conduit')       // ← 真实项目
const SRC = path.join(PROJ, 'slugs.mbt')
const OUT = path.join(__dirname, 'demo-full-result.txt')

const GOOD = 'buf.write_string_utf8(c.to_string())'
// 故意注入：把方法名拼错（MoonBit **有** toString，所以不能靠它 —— 那是踩过的坑：
// 第一版注入 `c.toString()` 结果 check 依然是 0，因为那本来就是合法调用）
const BAD = 'buf.write_string_utf8(c.to_stringX())'

const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

// 演示步骤记录：每步记 [跑了] / [因环境没跑]（这两个是**如实**的两种，不是 PASS/FAIL 的伪装）
const ran = []
const notRun = []
const step = (n, name, ok, detail) => {
  const mark = ok ? '跑了' : '因环境没跑'
  log('  [' + mark + '] ' + n + '. ' + name + (detail ? '　' + detail : ''))
  ;(ok ? ran : notRun).push(n + '. ' + name + (ok ? '' : '（' + (detail || '') + '）'))
}

let BACKUP = null
let BACKED_UP = false
let RESTORED = false
function backupNow() {
  if (BACKED_UP) return
  try { BACKUP = fs.existsSync(SRC) ? fs.readFileSync(SRC, 'utf8') : null } catch (e) { BACKUP = null }
  BACKED_UP = true
}
function restore() {
  if (RESTORED) return
  RESTORED = true
  if (!BACKED_UP || BACKUP === null) return
  try { fs.writeFileSync(SRC, BACKUP, 'utf8') } catch (e) {
    console.log('[WARN] 还原 conduit/slugs.mbt 失败：' + String((e && e.message) || e))
  }
}
function dump(code) {
  restore()
  log('')
  log('══ 演示结论 ══')
  log('  真的跑了：' + ran.length + ' 步')
  for (const x of ran) log('    ✓ ' + x)
  if (notRun.length) {
    log('  因环境没跑：' + notRun.length + ' 步（不是失败，也不是"跳过不提"）')
    for (const x of notRun) log('    ○ ' + x)
  }
  try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (e) {
    console.log('（结果文件写入失败，忽略：' + String((e && e.message) || e) + '）')
  }
  setTimeout(() => app.exit(code), 500)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { spawnSync } = require('child_process')
/**
 * 跑 moon check。
 *
 * ⚠️ **必须带 `--target native`**：`moon.mod` 里 `preferred_target = "wasm"`，
 * 而 `conduit`（依赖 moonbitlang/async）只在 native 侧被检查 —— 不带 target 时
 * 会得到 `Finished. moon: no work to do`，**看起来全绿其实压根没检查 conduit**。
 * （第一版就栽在这：注入了一个错误，check 依然 0，白排查一轮。）
 */
function moonCheck(dir) {
  const r = spawnSync('moon', ['check', '--target', 'native'], { cwd: dir, encoding: 'utf8', timeout: 180000, shell: true })
  return { code: r.status, out: String((r.stdout || '') + (r.stderr || '')) }
}

backupNow()

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  const P = async (expr) => JSON.parse(await js(`(async () => JSON.stringify(${expr}))()`))
  await sleep(3000)

  log('══ P21 产品级演示（真实项目：conduit，含 HTTP/PG/Redis + 4 个测试文件）══')

  // ── 01 注入故意错误 ─────────────────────────────────────────────
  log('\n── P21-01 准备：注入一个故意错误 ──')
  const good = fs.readFileSync(SRC, 'utf8')
  chk('靶文件里找得到要改的那一行', good.indexOf(GOOD) >= 0, GOOD)
  fs.writeFileSync(SRC, good.replace(GOOD, BAD), 'utf8')
  chk('已注入（to_string → toString）', fs.readFileSync(SRC, 'utf8').indexOf(BAD) >= 0)
  step(1, '注入故意错误', true, 'conduit/slugs.mbt 的 slugify 里')

  // ── 02 IDE 打开 ───────────────────────────────────────────────
  log('\n── P21-02 IDE 打开 ──')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(PROJ)})`)
  await sleep(1800)
  const ctx = await P('window.moonbitIDE.getContext()')
  eq('打开的是 conduit', path.basename(String(ctx.rootDir)), 'conduit')
  step(2, 'IDE 打开项目', true, '识别为 ' + String(ctx.projectType))

  // ── 03 LSP/check 报错（用**真实** check 输出）──────────────────
  log('\n── P21-03 报错（真实 moon check 的输出）──')
  const broken = moonCheck(PROJ)
  chk('★ 注入后 check 确实失败（不是恒绿）', broken.code !== 0, 'code=' + broken.code)
  // 真实报错的形态有好几种，这里覆盖常见的：
  //   `Type Char has no method to_stringX.`（方法不存在）
  //   `The value identifier xxx is unbound.`（标识符未定义）
  // 第一版只写了后两种，于是抓成了末尾的 "Error: failed to run check for target Native"。
  const realMsg = (broken.out.match(/(?:has no method|The value identifier|Unknown method|unbound|Type mismatch)[^\n]*/) || [''])[0].trim()
    || broken.out.split('\n').filter((l) => l.trim()).slice(-3).join(' ').trim()
  log('     真实报错：' + realMsg.slice(0, 110))
  const lineNo = (() => { const m = /:(\d+):\d+/.exec(broken.out); return m ? Number(m[1]) : null })()
  await js(`window.moonbitIDE.problems.report(${JSON.stringify({ severity: 'error', file: 'slugs.mbt', line: lineNo, message: realMsg.slice(0, 200), source: 'compiler' })})`)
  await sleep(400)
  chk('问题进了统一问题模型', ((await P('window.moonbitIDE.problems.list()')) || []).some((p) => /toString|to_string|Unknown|unbound/i.test(String(p.message))))
  step(3, '报错进问题模型', true, 'file=slugs.mbt')

  // ── 04/05 Agent 查看 + Explain（可验证的任务理解）─────────────
  log('\n── P21-04/05 Agent 查看 + Explain ──')
  // 任务文本用**相对当前项目**的路径（workspace 已经就是 conduit/）——
  // 第一版写了 `conduit/slugs.mbt`，于是 exists('conduit/slugs.mbt') 为 false、
  // relevantFiles 直接是空的（看着像"Agent 没找到相关文件"，其实是路径基准弄错了）。
  const u = await P(`await window.moonbitIDE.agentRequest.understand('修复 slugs.mbt 里的报错')`)
  chk('Agent 形成了理解', u.ok === true, JSON.stringify(u).slice(0, 120))
  const t = u.understanding || {}
  chk('★ 相关文件里有 slugs.mbt（不是瞎猜）', (t.relevantFiles || []).some((f) => /slugs\.mbt/.test(f.path)), JSON.stringify((t.relevantFiles || []).map((f) => f.path)))
  chk('★ 相关问题被识别（带 id，能点开）', (t.relevantProblems || []).length >= 1 && !!t.relevantProblems[0].id)
  chk('★ 给出了计划，且每条说明为什么', (t.proposedActions || []).length > 0 && t.proposedActions.every((a) => !!a.rule), JSON.stringify(t.proposedActions))
  step(4, 'Agent 查看（Context）', true, '相关文件 ' + (t.relevantFiles || []).length + ' 个')
  step(5, 'Agent Explain（计划）', true, (t.proposedActions || []).map((a) => a.action).join(' → '))

  // ── 06 Agent Read（真调只读工具）──────────────────────────────
  log('\n── P21-06 Agent Read ──')
  const llm = createMockLlm([
    { toolCalls: [{ name: 'readFile', args: { path: 'slugs.mbt' } }] },
    { text: '看明白了：slugify 里用了 MoonBit 没有的 toString()，应为 to_string()。' },
  ])
  const toolsShim = { call: async (name, args) => await P(`await window.moonbitIDE.agentTools.call(${JSON.stringify(name)}, ${JSON.stringify(args)})`) }
  const loop = await runToolLoop({ llm, tools: toolsShim, prompt: t.goal })
  eq('读了 slugs.mbt', loop.steps.map((s) => s.name), ['readFile'])
  eq('  且读成功', loop.steps[0].ok, true)
  const fi = await P(`await window.moonbitIDE.agentTools.call('readFile', { path: 'slugs.mbt' })`)
  chk('★ 读到的就是那份坏文件（含注入的那行）', fi && fi.ok === true && /to_stringX/.test(JSON.stringify(fi.data || {})), JSON.stringify(fi).slice(0, 160))
  // 注：runToolLoop 回灌给模型的 tool 消息只留 800 字符，而 slugs.mbt 有 94 行 ——
  // 注入行在中间，**回灌消息里找不到它是正常的**（第一版就是错在拿回灌内容断言）。
  chk('★ 回灌消息被截断过（这是设计：只留摘要，不塞全文）', JSON.stringify(llm.calls()[1].messages).length <= 1200, String(JSON.stringify(llm.calls()[1].messages).length))
  step(6, 'Agent Read（真读文件）', true, 'tool=readFile')

  // ── 07/08/09 Patch：生成 → 预览 → 应用 ─────────────────────────
  log('\n── P21-07/08/09 Patch：生成 → 预览 → 应用 ──')
  const proposed = await P(`await window.moonAPI.agentPatchPropose(${JSON.stringify({
    file: 'slugs.mbt', old: BAD, new: GOOD, summary: 'toString() → to_string()',
  })})`)
  chk('生成了补丁（带一次性 token）', proposed.ok === true && !!proposed.token, JSON.stringify(proposed).slice(0, 140))
  chk('★ 预览里能看到改动', /toString/.test(String(proposed.preview)) && /to_string/.test(String(proposed.preview)))
  chk('★ 生成阶段**不写盘**（Gate P8：要用户确认）', fs.readFileSync(SRC, 'utf8').indexOf(BAD) >= 0)
  step(7, 'Agent Patch（生成）', true, '含 token 与预览')
  step(8, 'Preview（人可读）', true, 'toString → to_string')

  const applied = await P(`await window.moonAPI.agentPatchApply(${JSON.stringify(proposed.token)})`)
  chk('★ 用户确认后应用成功', applied.ok === true, JSON.stringify(applied).slice(0, 140))
  chk('★ 文件真的被改了', fs.readFileSync(SRC, 'utf8').indexOf(BAD) < 0)
  step(9, 'Apply（确认后落盘）', true, '留了备份可回滚')

  // ── 10 Check（真跑，且应恢复绿）───────────────────────────────
  log('\n── P21-10 Check ──')
  const fixed = moonCheck(PROJ)
  eq('★ 修好后 check 恢复 0（这是"修好了"的硬证据）', fixed.code, 0)
  step(10, 'Check（真跑 moon check）', true, '由失败恢复为 0')

  // ── 11/12 Test / Run（R12 挡住，如实）─────────────────────────
  log('\n── P21-11/12 Test / Run ──')
  const verified = await P(`await window.moonAPI.agentVerifyRun('slugs.mbt')`)
  const rep = (verified && verified.report) || {}
  const names = (rep.steps || []).map((s) => s.name)
  const testStep = (rep.steps || []).find((s) => s.name === 'test')
  chk('验证闭环跑起来了', names.length > 0, JSON.stringify(names))
  step(11, 'Test', testStep && testStep.ok === true, testStep && testStep.ok ? '' : '本机 R12：moon test 零输出（退出码异常）')
  const runStep = (rep.steps || []).find((s) => s.name === 'run')
  step(12, 'Run', !!(runStep && runStep.ok), runStep && runStep.ok ? '' : (names.indexOf('run') < 0 ? '失败即停，未跑到 run（R12）' : 'R12'))

  // ── 13 Browser（需真起服务）───────────────────────────────────
  log('\n── P21-13 Browser ──')
  step(13, 'Browser（自动开页面）', false, '需要项目真跑起来并给 URL；本机 R12 使 serve 无法构建')

  // ── 14 API（没服务就如实）─────────────────────────────────────
  log('\n── P21-14 API 调试 ──')
  const api = await P(`await window.moonbitIDE.agentTools.exec.call('apiRequest', { url: 'http://127.0.0.1:8080/api/tags' })`)
  const apiOk = api && api.ok === true
  chk(apiOk ? 'API 请求成功' : '★ 服务没起来时如实报错（不是假装有数据）', apiOk || /连不上|ECONN|refused|timeout/i.test(String(api && api.error)), String(api && (api.error || '')).slice(0, 100))
  step(14, 'API 调试', apiOk, apiOk ? '' : '后端未运行（需 docker + PG/Redis），如实报错')

  // ── 15 Database（没客户端就如实）──────────────────────────────
  log('\n── P21-15 Database ──')
  const db = await P(`await window.moonbitIDE.database.tables('public')`)
  const dbOk = db && db.ok === true
  chk(dbOk ? '读到表列表' : '★ 没装 psql 时如实说"未找到客户端"（不是"表是空的"）', dbOk || /未找到 psql 客户端/.test(String(db && db.error)), String(db && (db.error || '')).slice(0, 110))
  step(15, 'Database（只读查询）', dbOk, dbOk ? '' : '未装 psql 客户端，如实报错')

  // ── 16 Quality ───────────────────────────────────────────────
  log('\n── P21-16 Quality ──')
  const q = await P('await window.moonbitIDE.quality.snapshot()')
  const qs = (q && q.snapshot) || {}
  chk('工程状态聚合成功', typeof qs.overall === 'string', JSON.stringify(qs).slice(0, 120))
  log('     扫到验证产物 ' + (qs.scannedFiles == null ? '?' : qs.scannedFiles) + ' 份　｜ 工程状态：' + String(qs.overall))
  log('     ' + String(qs.describe || ''))
  // 注：这里只断言"能聚合出结论"。具体是 PASS 还是 FAIL 取决于 desktop/ 下有哪些
  // *-result.txt（刚跑过一堆验证就会是 FAIL —— 那里面有过期产物，属正常）。
  chk('★ 聚合结论是五态之一', ['PASS', 'FAIL', 'WARN', 'SKIP', 'NOT_RUN'].indexOf(String(qs.overall)) >= 0, String(qs.overall))
  if (qs.scannedFiles === 0 || String(qs.overall) === 'NOT_RUN') {
    log('     （注意：扫到 0 份产物 —— 演示进程的 desktop/ 下没有 *-result.txt）')
  }
  step(16, 'Quality（工程状态）', true, String(qs.overall) + '（扫到 ' + (qs.scannedFiles == null ? '?' : qs.scannedFiles) + ' 份产物）')

  // ── 17 Agent 总结 → 项目便签 ─────────────────────────────────
  log('\n── P21-17 Agent 总结 → 便签 ──')
  const sum = await P(`await window.moonAPI.officeSummaryToNote(${JSON.stringify({
    projectRoot: PROJ,
    summary: 'P21 演示：注入 toString() 错误 → Agent 读文件定位 → 生成补丁（确认后应用）→ moon check 由失败恢复为 0。',
  })})`)
  chk('总结写进了项目便签', sum.ok === true, JSON.stringify(sum).slice(0, 120))
  const note = (await P(`await window.moonAPI.wbLoad(${JSON.stringify(PROJ)})`)).note || ''
  chk('★ 便签里确实有这段总结', /P21 演示/.test(note), String(note).slice(0, 120))
  step(17, 'Agent 总结 → 便签', true, '追加（不覆盖原有）')

  // ── 收尾：还原真实源码 ───────────────────────────────────────
  log('\n── 收尾：还原 conduit 源码 ──')
  restore()
  chk('★ conduit/slugs.mbt 已还原', fs.readFileSync(SRC, 'utf8').indexOf(BAD) < 0)
  const back = moonCheck(PROJ)
  eq('  还原后 check 仍为 0', back.code, 0)

  log('')
  log(H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
