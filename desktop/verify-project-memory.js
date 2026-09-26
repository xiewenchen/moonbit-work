// P11 端到端验证：项目级记忆（.moonbit-work/）
//
// 用一个**临时目录**当项目根，避免在真实项目里留下 .moonbit-work/。
// 验的是 P11-01～09 的**接线**（纯逻辑与 store 层已在 test-project-memory.js 里覆盖）。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createHarness } = require('./verify-harness')

const OUT = path.join(__dirname, 'project-memory-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-e2e-'))
let CLEANED = false
function cleanup() {
  if (CLEANED) return
  CLEANED = true
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch (e) {
    console.log('[WARN] 清理临时项目失败：' + String((e && e.message) || e))
  }
}
function dump(code) {
  cleanup()
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

  const MDIR = path.join(ROOT, '.moonbit-work')
  const CTX = { rootDir: ROOT, projectType: 'moonbit', label: '临时的记忆靶子' }

  log('\n=== ① P11-01～03 建布局 ===')
  const ens = await P(`await window.moonAPI.memoryEnsure(${JSON.stringify(ROOT)}, ${JSON.stringify(CTX)})`)
  chk('memoryEnsure 成功', ens.ok === true, JSON.stringify(ens).slice(0, 140))
  chk('目录建出来了', fs.existsSync(MDIR))
  chk('  history/ 建出来了', fs.existsSync(path.join(MDIR, 'history')))
  chk('  project.md 建出来了', fs.existsSync(path.join(MDIR, 'project.md')))
  chk('  agent-rules.md 建出来了', fs.existsSync(path.join(MDIR, 'agent-rules.md')))
  chk('  context.json 建出来了', fs.existsSync(path.join(MDIR, 'context.json')))
  const ctxJson = JSON.parse(fs.readFileSync(path.join(MDIR, 'context.json'), 'utf8'))
  eq('context.json 里项目类型正确', ctxJson.projectType, 'moonbit')

  log('\n=== ② P11-04 Agent 读规则 ===')
  const rules = await P(`await window.moonAPI.memoryRules(${JSON.stringify(ROOT)})`)
  chk('读到规则', rules.ok === true)
  chk('  模板里写明"未经确认不可修改"', /未经确认不可修改/.test(String(rules.raw)), String(rules.raw).slice(0, 80))
  chk('  且能解析成条目', Array.isArray(rules.rules) && rules.rules.length > 0, String(rules.rules.length))

  log('\n=== ③ P11-05 ★ 规则不可无确认修改（端到端）===')
  const refuse = await P(`await window.moonAPI.memoryWriteRules(${JSON.stringify(ROOT)}, '- 偷偷改一条\\n', false)`)
  eq('★ 无确认 → 拒绝', refuse.ok, false)
  chk('  原因说清了', /受保护/.test(String(refuse.error)), String(refuse.error))
  chk('★ 文件没被动', fs.readFileSync(path.join(MDIR, 'agent-rules.md'), 'utf8').indexOf('偷偷改一条') < 0)
  const okw = await P(`await window.moonAPI.memoryWriteRules(${JSON.stringify(ROOT)}, '- 用户确认过的规则\\n', true)`)
  eq('有确认 → 写入成功', okw.ok, true)
  chk('  文件真的变了', fs.readFileSync(path.join(MDIR, 'agent-rules.md'), 'utf8').indexOf('用户确认过的规则') >= 0)

  log('\n=== ④ P11-06 只保存已验证的经验 ===')
  const unverified = await P(`await window.moonAPI.memoryAdd(${JSON.stringify(ROOT)}, ${JSON.stringify({ error: '某个错误', solution: '我猜的修法', verified: false })})`)
  eq('★ 未验证 → 拒绝（"我猜"不是经验）', unverified.ok, false)
  chk('  原因说清了', /已验证|verified/.test(String(unverified.error)), String(unverified.error))

  const added = await P(`await window.moonAPI.memoryAdd(${JSON.stringify(ROOT)}, ${JSON.stringify({ error: 'unbound identifier fooUnbound at line 7', solution: '改成正确的标识符', verified: true, files: ['src/main.mbt'], tags: ['compiler'] })})`)
  chk('已验证 → 保存成功', added.ok === true, JSON.stringify(added).slice(0, 140))
  eq('  计数为 1', added.count, 1)

  log('\n=== ⑤ P11-07 检索只给相关的 ===')
  const hit = await P(`await window.moonAPI.memorySearch(${JSON.stringify(ROOT)}, ${JSON.stringify({ text: 'unbound fooUnbound 报错', file: 'src/main.mbt' })})`)
  eq('★ 命中了那条', (hit.hits || []).length, 1)
  chk('  内容对得上', /unbound/.test(String(hit.hits[0].error)))
  const miss = await P(`await window.moonAPI.memorySearch(${JSON.stringify(ROOT)}, ${JSON.stringify({ text: '今天天气怎么样' })})`)
  eq('★ 无关查询 → 空（不把库倒出来）', (miss.hits || []).length, 0)

  log('\n=== ⑥ P11-08 压缩 / P11-09 删除 ===')
  // 再塞几条同句式的（超过阈值 5）
  for (let i = 0; i < 6; i++) {
    await P(`await window.moonAPI.memoryAdd(${JSON.stringify(ROOT)}, ${JSON.stringify({ error: 'same pattern error at line ' + i, solution: 'fix ' + i, verified: true })})`)
  }
  const before = await P(`await window.moonAPI.memoryExperiences(${JSON.stringify(ROOT)})`)
  chk('库里现在有几条', (before.experiences || []).length >= 6, String((before.experiences || []).length))
  const comp = await P(`await window.moonAPI.memoryCompress(${JSON.stringify(ROOT)})`)
  chk('压缩成功', comp.ok === true, JSON.stringify(comp).slice(0, 120))
  chk('★ 压缩后条数减少', comp.after < comp.before, comp.before + ' → ' + comp.after)
  chk('  removedCount 如实统计', comp.removedCount > 0, String(comp.removedCount))

  const after = await P(`await window.moonAPI.memoryExperiences(${JSON.stringify(ROOT)})`)
  const firstId = (after.experiences || [])[0].id
  const del = await P(`await window.moonAPI.memoryDelete(${JSON.stringify(ROOT)}, ${JSON.stringify(firstId)})`)
  chk('删除成功', del.ok === true, JSON.stringify(del).slice(0, 120))
  eq('  计数减 1', del.count, (after.experiences || []).length - 1)
  const delMiss = await P(`await window.moonAPI.memoryDelete(${JSON.stringify(ROOT)}, 'nope')`)
  eq('删不存在的 → ok=false', delMiss.ok, false)

  log('\n=== ⑧ ★ 规则保护"绕不过去"（review 抓到的绕过路径）===')
  // ⚠️ 先把项目打开：P17 之后 `fs:write` 要求"**已打开项目**"，而本脚本原来只把 ROOT 当参数传。
  //    放在本节**最前面**（而不是后面的写入断言之前）—— 否则本节前半段的写入断言会先失败。
  //    另：openProject 没有返回值，不能用 P() 包（会 JSON.parse(undefined) 抛错）。
  await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
  await new Promise((r) => setTimeout(r, 900))
  const RULE_FILE = path.join(MDIR, 'agent-rules.md')
  const beforeRule = fs.readFileSync(RULE_FILE, 'utf8')

  // review 指出的绕过：保护原本只在 memory:writeRules 上，而 fs:write 是通用写口 ——
  // 直接写 agent-rules.md 就绕过去了。现在判定提到了写盘这一层。
  const sneak = await P(`await window.moonAPI.writeFile(${JSON.stringify(RULE_FILE)}, '- 偷偷改的规则\\n')`)
  eq('★ fs:write 直接写 agent-rules.md → 拒绝', sneak.ok, false)
  chk('  原因与规则保护一致', /受保护/.test(String(sneak.error)), String(sneak.error))
  chk('★★ 文件一个字都没被改', fs.readFileSync(RULE_FILE, 'utf8') === beforeRule)

  const sneakFake = await P(`await window.moonAPI.writeFile(${JSON.stringify(RULE_FILE)}, '- 伪装确认\\n', 1)`)
  eq('传 confirmed:1（非真布尔）也不算确认', sneakFake.ok, false)

  const okConfirmed = await P(`await window.moonAPI.writeFile(${JSON.stringify(RULE_FILE)}, '- 经用户确认的规则\\n', true)`)
  eq('带 confirmed:true 才允许写入', okConfirmed.ok, true)

  // 普通文件不受这条保护影响（不能误伤）
  // ⚠️ 两个前提要说清（这里是全量回归挖出来的）：
  //    ① P17 把 `fs:write` 收窄成"**必须已打开项目**才能写"，而这个脚本从来没调过 openProject
  //       —— 它一直只把 ROOT 当**参数**传来传去。所以这里得先把它打开。
  //       （报错原文：`未打开项目 —— 拒绝写入（避免"没打开项目也能改磁盘上的文件"）`）
  //    ② 写的路径也必须在那个工作区**内**（用 os.tmpdir() 的目录会被正确地拒）。
  // ⚠️ openProject 没有返回值（不要用 P() 包它 —— 那会 JSON.parse(undefined) 抛错，
  //    与之前 openFile 那个坑一模一样）。直接 await js() 即可。
  await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
  await new Promise((r) => setTimeout(r, 900))
  const other = path.join(ROOT, 'verify-memory-noise.txt')
  const okOther = await P(`await window.moonAPI.writeFile(${JSON.stringify(other)}, 'hi')`)
  chk('普通文件写入不受影响（已打开项目 + 在工作区内）', okOther.ok === true, JSON.stringify(okOther).slice(0, 120))
  eq('  内容正确', fs.readFileSync(other, 'utf8'), 'hi')
  try { fs.unlinkSync(other) } catch (_) { /* 删不掉就算 */ }

  log('\n=== ⑨ 无效项目根不崩 ===')
  const bad = await P(`await window.moonAPI.memoryEnsure('C:/__绝对不存在的路径__', null)`)
  eq('无效根 → ok=false（不抛）', bad.ok, false)

  log('\n=== 收尾 ===')
  cleanup()
  chk('临时项目已清理', !fs.existsSync(ROOT))

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
