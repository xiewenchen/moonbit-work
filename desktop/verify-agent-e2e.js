// P9C：第一次真正的 Agent E2E（Phase 2.1）
//
// 目标是把清单里那条链**整条走一遍**，而不是各自单测完就算：
//   Ask → Understand → Read → Diagnose → Patch → Confirm → Check → Test → Run → Health → Report
//
// 三处"真"：
//   ① 靶项目是真的（testdata/agent-e2e-project，独立零依赖），并且用**三态对照**证明它可信：
//      干净 → `moon check` 绿；注入错误 → 红；修好后 → 又绿。
//      （不做这三次 check 的话，就无法排除"check 恒返回 ok"这种假阳性 —— review 指出。）
//   ② 读文件走真的只读工具表；改文件走真的 Patch 流程（用户确认后才写）
//   ③ check/test/run/health 走真的验证闭环（P9），结果**如实**记录
//
// "LLM"由 MockLLM 扮演（P9B）—— 所以这个 E2E **不依赖任何真实 API 额度**，可离线反复跑。
//
// ⚠️ 本脚本会**真的改靶项目文件**，所以：**先备份**（在任何可能提前退出的检查之前），
//    并且只有"确实备份过"才允许还原 —— 否则会出现"把源文件删掉"的事故。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const { createHarness } = require('./verify-harness')
const { createMockLlm } = require('./mock-llm')
const { runToolLoop } = require('./agent-adapter')

const E2E_DIR = path.resolve(__dirname, '..', 'testdata', 'agent-e2e-project')
const SRC = path.join(E2E_DIR, 'src', 'main.mbt')
const OUT = path.join(__dirname, 'agent-e2e-result.txt')

// 坏版 / 好版都写全，方便"注入 → 修好"来回切
const BROKEN = '///|\nfn main {\n  println(greeting("world"))\n}\n\nfn greeting(name : String) -> String {\n  "hello, " + missingIdent\n}\n'
const FIXED = '///|\nfn main {\n  println(greeting("world"))\n}\n\nfn greeting(name : String) -> String {\n  "hello, " + name\n}\n'

const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

// ── 备份 / 还原 ────────────────────────────────────────────────────────────────
let BACKUP = null
let BACKED_UP = false          // ★「确实备份过」与「原本不存在」是两件事
let RESTORED = false           // ★ 只还原一次
function backupNow() {
  if (BACKED_UP) return
  try { BACKUP = fs.existsSync(SRC) ? fs.readFileSync(SRC, 'utf8') : null } catch (e) { BACKUP = null }
  BACKED_UP = true
}
function restore() {
  if (RESTORED) return
  RESTORED = true
  if (!BACKED_UP) return       // 还没备份过 → **绝不动文件**（这是上次删掉源文件的根因）
  try {
    if (BACKUP === null) { if (fs.existsSync(SRC)) fs.unlinkSync(SRC) }
    else fs.writeFileSync(SRC, BACKUP, 'utf8')
  } catch (e) {
    console.log('[WARN] 还原靶项目失败：' + String((e && e.message) || e))
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

/** 直接跑 `moon check`（本机可用）—— 用来做"干净/注入/修好"的三态对照 */
function moonCheck(dir) {
  const r = spawnSync('moon', ['check'], { cwd: dir, encoding: 'utf8', timeout: 180000, shell: true })
  return { code: r.status, out: String((r.stdout || '') + (r.stderr || '')) }
}

// ★ 备份要在**任何早退之前**完成
backupNow()

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  const P = async (expr) => JSON.parse(await js(`(async () => JSON.stringify(${expr}))()`))
  await sleep(3000)

  // ── 三态对照（先证明靶子可信）─────────────────────────────────
  log('\n=== ⓪ 靶子可信性：干净 → 注入 → 修好 的三态对照 ===')
  fs.writeFileSync(SRC, FIXED, 'utf8')
  const clean = moonCheck(E2E_DIR)
  eq('★ 干净版本 moon check 退出码 0', clean.code, 0)
  fs.writeFileSync(SRC, BROKEN, 'utf8')
  const broken = moonCheck(E2E_DIR)
  chk('★ 注入错误后 check **确实失败**（不是恒绿）', broken.code !== 0, 'code=' + broken.code)
  chk('  且报错就是我们注入的那个标识符', /missingIdent|unbound/i.test(broken.out), broken.out.split('\n').slice(-4).join(' ').slice(0, 160))
  const realMsg = (broken.out.match(/The value identifier[^\n]*/) || ['The value identifier missingIdent is unbound.'])[0].trim()
  log('   （下面这条 Problem 就用真实 check 的报错文案：' + realMsg + '）')

  // ── P9C-01 注入错误（保持注入状态，下面走 IDE/Agent 链路）───────
  log('\n=== ① P9C-01 注入错误 ===')
  chk('靶文件处于注入错误状态', fs.readFileSync(SRC, 'utf8').indexOf('missingIdent') >= 0)

  // ── P9C-02 IDE 打开 ───────────────────────────────────────────
  log('\n=== ② P9C-02 IDE 打开 ===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(E2E_DIR)})`)
  await sleep(1800)
  const ctx = await P('window.moonbitIDE.getContext()')
  chk('项目已打开', !!ctx && !!ctx.rootDir, JSON.stringify(ctx).slice(0, 100))
  eq('打开的正是靶项目', path.basename(String(ctx.rootDir)), 'agent-e2e-project')

  // ── P9C-03 产生 Problem ───────────────────────────────────────
  log('\n=== ③ P9C-03 产生 Problem ===')
  await js(`window.moonbitIDE.problems.report(${JSON.stringify({
    severity: 'error', file: 'src/main.mbt', line: 7, message: realMsg, source: 'compiler',
  })})`)
  await sleep(400)
  const probs = await P('window.moonbitIDE.problems.list()')
  chk('问题模型里有这条 error', (probs || []).some((p) => p.severity === 'error' && /missingIdent/.test(String(p.message))), String((probs || []).length))

  // ── P9C-04 Agent 获取 Context ─────────────────────────────────
  log('\n=== ④ P9C-04 获取 Context ===')
  const built = await P(`await window.moonbitIDE.agentRequest.build('修复 src/main.mbt 里的未定义标识符')`)
  chk('Context 构建成功', built.ok === true, JSON.stringify(built).slice(0, 140))
  eq('快照里带着这个问题', built.snapshot.problems.total >= 1, true)
  // 取数状态**不能是 error**（是 ok 还是 empty 取决于当下有没有数据）
  chk('problems 这一路取数正常（不是 error）', String(built.snapshot.sources.problems).indexOf('error') !== 0, String(built.snapshot.sources.problems))

  // ── P9C-05 Ask → Understand ───────────────────────────────────
  log('\n=== ⑤ P9C-05 Ask → Understand ===')
  const u = await P(`await window.moonbitIDE.agentRequest.understand('修复 src/main.mbt 里的未定义标识符')`)
  chk('理解成功', u.ok === true, JSON.stringify(u).slice(0, 140))
  const t = u.understanding || {}
  eq('目标就是这句话', t.goal, '修复 src/main.mbt 里的未定义标识符')
  chk('相关文件里有 src/main.mbt', (t.relevantFiles || []).some((f) => f.path === 'src/main.mbt'), JSON.stringify(t.relevantFiles))
  chk('相关问题被识别（带 id）', (t.relevantProblems || []).length >= 1 && !!t.relevantProblems[0].id)
  eq('默认需要确认（Gate P8）', t.constraints.needsConfirmBeforeApply, true)

  // ── P9C-06 LLM 分析 + 真调 readFile ───────────────────────────
  log('\n=== ⑥ P9C-06 LLM 分析 → readFile → 结果回灌 ===')
  const llm = createMockLlm([
    { toolCalls: [{ name: 'readFile', args: { path: 'src/main.mbt' } }] },
    { text: '看明白了：greeting 里用了未定义的 missingIdent，应改成 name。' },
  ])
  const toolsShim = { call: async (name, args) => await P(`await window.moonbitIDE.agentTools.call(${JSON.stringify(name)}, ${JSON.stringify(args)})`) }
  const loop = await runToolLoop({ llm, tools: toolsShim, prompt: t.goal })
  eq('循环正常结束', [loop.ok, loop.stopped], [true, 'done'])
  eq('真的调了 readFile', loop.steps.map((s) => s.name), ['readFile'])
  eq('readFile 成功', loop.steps[0].ok, true)
  // 断言回灌内容里有**靶文件独有**的串（不要用 "hello" —— 文件里本来就有，几乎恒真）
  chk('模型拿到的就是那份坏文件（回灌里有 missingIdent）', /missingIdent/.test(JSON.stringify(llm.calls()[1].messages)), true)
  chk('模型给出了分析结论', /missingIdent/.test(loop.text), loop.text)

  // ── P9C-07 生成 Patch ─────────────────────────────────────────
  log('\n=== ⑦ P9C-07 生成 Patch ===')
  const proposed = await P(`await window.moonAPI.agentPatchPropose(${JSON.stringify({
    file: 'src/main.mbt', old: '"hello, " + missingIdent', new: '"hello, " + name', summary: '修掉未定义标识符',
  })})`)
  chk('propose 成功（拿到一次性 token 与预览）', proposed.ok === true && !!proposed.token, JSON.stringify(proposed).slice(0, 160))
  chk('预览里能看到改动', /missingIdent/.test(String(proposed.preview)) && /name/.test(String(proposed.preview)))
  chk('**propose 阶段不写盘**（Gate P8）', fs.readFileSync(SRC, 'utf8').indexOf('missingIdent') >= 0)

  // ── P9C-08 用户确认 ───────────────────────────────────────────
  log('\n=== ⑧ P9C-08 用户确认 ===')
  // 真实产品里这是点对话框的「应用」；脚本里就是"用户点了一下"。
  // 要断言的是：**确认之前没有任何写盘**（上一节刚验过），确认之后才写。
  chk('确认前文件仍是坏的', fs.readFileSync(SRC, 'utf8').indexOf('missingIdent') >= 0)

  // ── P9C-09 Apply ─────────────────────────────────────────────
  log('\n=== ⑨ P9C-09 Apply ===')
  const applied = await P(`await window.moonAPI.agentPatchApply(${JSON.stringify(proposed.token)})`)
  chk('apply 成功', applied.ok === true, JSON.stringify(applied).slice(0, 160))
  const afterApply = fs.readFileSync(SRC, 'utf8')
  chk('文件**真的**被改了（missingIdent → name）', afterApply.indexOf('missingIdent') < 0 && afterApply.indexOf('+ name') >= 0, afterApply.slice(0, 120))
  chk('apply 留下备份路径（可回滚）', !!applied.backupPath, String(applied.backupPath))
  const fixedCheck = moonCheck(E2E_DIR)
  eq('★ 修好后 moon check 恢复退出码 0（E2E 的核心结论）', fixedCheck.code, 0)

  // ── P9C-10～13 验证闭环 ──────────────────────────────────────
  log('\n=== ⑩～⑬ P9C-10~13 验证闭环（check → test → run → health）===')
  const verified = await P(`await window.moonAPI.agentVerifyRun('src/main.mbt')`)
  const rep = (verified && verified.report) || {}
  const steps = rep.steps || []
  const names = steps.map((s) => s.name)
  chk('闭环跑起来了', names.length > 0, JSON.stringify(names))
  eq('第一步是 apply', names[0], 'apply')
  chk('包含 check 这步', names.indexOf('check') >= 0, JSON.stringify(names))
  const checkStep = steps.find((s) => s.name === 'check')
  chk('★ 闭环里的 check 通过', !!(checkStep && checkStep.ok), JSON.stringify(checkStep))

  // ★ 不把失败吞掉：有失败步骤就必须体现为 ok=false，且失败之后不能再有成功步骤
  const failIdx = steps.findIndex((s) => s.ok !== true)
  if (failIdx >= 0) {
    eq('★ 有失败步骤 → 报告 ok=false（不假绿）', rep.ok, false)
    chk('★ 失败即停：失败之前没有未跑的步骤、失败之后没有成功步骤',
      steps.slice(failIdx).every((s) => s.ok !== true), JSON.stringify(steps.map((s) => s.name + ':' + String(s.ok))))
    log('   未通过的步骤：' + steps[failIdx].name + ' → ' + String(steps[failIdx].error || '').slice(0, 120))
    log('   （本机 `moon test` 零输出属已知环境限制 R12 —— 如实记录，不当成通过）')
  } else {
    eq('★ 全部步骤通过 → 报告 ok=true', rep.ok, true)
  }
  chk('报告里有 status（不是空壳）', !!rep.status, String(rep.status))
  chk('报告是给人看的（含结论行）', /验证报告|结论/.test(String(verified.text || '')), String(verified.text || '').slice(0, 80))

  // ── P9C-14 报告 ──────────────────────────────────────────────
  log('\n=== ⑭ P9C-14 报告 ===')
  const lastSnap = await P('await window.moonbitIDE.agentRequest.lastSnapshot()')
  chk('最后仍有 context 快照可查', !!lastSnap.snapshot, JSON.stringify(lastSnap).slice(0, 100))
  log('   ---- 验证报告原文（节选）----')
  log(String(verified.text || '（无报告）').split('\n').slice(0, 14).map((l) => '   ' + l).join('\n'))

  // ── 收尾 ────────────────────────────────────────────────────
  log('\n=== 收尾 ===')
  restore()
  chk('靶项目已恢复干净版本', fs.readFileSync(SRC, 'utf8').indexOf('missingIdent') < 0)
  eq('恢复后的内容与备份完全一致', fs.readFileSync(SRC, 'utf8'), BACKUP)

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
