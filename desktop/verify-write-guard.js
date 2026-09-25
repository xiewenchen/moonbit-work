// P17-02 验证：fs:write 收窄到工作区 —— 既不破坏保存，也挡得住越界写
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createHarness } = require('./verify-harness')

const ROOT = path.resolve(__dirname, '..')                 // 工作区用真实的项目根
const OUTSIDE = path.join(os.tmpdir(), '__p17_outside__.txt')
const INSIDE = path.join(ROOT, 'desktop', '__p17_inside__.txt')
const RULES = path.join(ROOT, '.moonbit-work', 'agent-rules.md')
const OUT = path.join(__dirname, 'write-guard-result.txt')

const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

let CLEANED = false
function cleanup() {
  if (CLEANED) return
  CLEANED = true
  for (const f of [OUTSIDE, INSIDE]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch (e) {
      console.log('[WARN] 清理 ' + f + ' 失败：' + String((e && e.message) || e))
    }
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

  log('\n=== ① 打开项目后：工作区**内**可写（不破坏“保存文件”）===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
  await sleep(1500)
  const okWrite = await P(`await window.moonAPI.writeFile(${JSON.stringify(INSIDE)}, 'hello from P17')`)
  chk('★ 工作区内写入成功（保存文件这条路径没被误伤）', okWrite.ok === true, JSON.stringify(okWrite).slice(0, 140))
  chk('  文件真的写出来了', fs.existsSync(INSIDE))
  eq('  内容正确', fs.readFileSync(INSIDE, 'utf8'), 'hello from P17')

  log('\n=== ② ★ 工作区**外**写入被拒（收窄生效）===')
  const bad = await P(`await window.moonAPI.writeFile(${JSON.stringify(OUTSIDE)}, 'should not appear')`)
  eq('★ 越界写入 → 拒绝', bad.ok, false)
  chk('  原因说清了边界', /拒绝写入工作区之外/.test(String(bad.error)), String(bad.error).slice(0, 160))
  chk('★★ 那个文件根本没被创建', !fs.existsSync(OUTSIDE))

  log('\n=== ③ 相对路径穿越也被拒 ===')
  const esc = await P(`await window.moonAPI.writeFile(${JSON.stringify(path.join(ROOT, '..', '__p17_escape__.txt'))}, 'x')`)
  eq('★ ../ 穿越 → 拒绝', esc.ok, false)

  log('\n=== ④ agent-rules.md 仍受 P11 保护（两层守卫都要生效）===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
  await sleep(800)
  // 先确保规则文件存在（ensureLayout 会建）
  await P(`await window.moonAPI.memoryEnsure(${JSON.stringify(ROOT)}, null)`)
  await sleep(500)
  const rulesBefore = fs.existsSync(RULES) ? fs.readFileSync(RULES, 'utf8') : null
  const sneak = await P(`await window.moonAPI.writeFile(${JSON.stringify(RULES)}, '- 偷偷改规则\\n')`)
  eq('★ 写 agent-rules.md → 仍被拒（受保护）', sneak.ok, false)
  chk('  原因是规则保护而不是工作区', /受保护/.test(String(sneak.error)), String(sneak.error).slice(0, 160))
  if (rulesBefore !== null) eq('  规则文件没被动', fs.readFileSync(RULES, 'utf8'), rulesBefore)

  log('\n=== ⑤ 关闭项目后不允许写（没打开项目就不该改磁盘）===')
  await js('window.moonbitIDE.closeProject()')
  await sleep(1200)
  const noProj = await P(`await window.moonAPI.writeFile(${JSON.stringify(INSIDE)}, 'should not')`)
  eq('★ 未打开项目 → 拒绝', noProj.ok, false)
  chk('  原因说明是没打开项目', /未打开项目/.test(String(noProj.error)), String(noProj.error).slice(0, 140))

  log('\n=== 收尾 ===')
  cleanup()
  chk('临时文件已清理', !fs.existsSync(INSIDE) && !fs.existsSync(OUTSIDE))

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
