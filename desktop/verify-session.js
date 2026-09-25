// P10 端到端验证：会话与**项目**绑定
//
// 用两个**真实**项目来回切：A = moonbit-platform，B = testdata/agent-e2e-project。
// 验的是 P10-08（恢复）/ P10-09（切项目自动切会话）/ P10-10（关项目结束）/ **P10-11（禁止跨项目污染）**。
//
// ⚠️ 会写用户目录 `~/.moonbit-work/sessions/`，所以跑完**清掉这次产生的两份**。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const A = path.resolve(__dirname, '..')                                   // moonbit-platform
const B = path.resolve(__dirname, '..', 'testdata', 'agent-e2e-project')  // 靶项目
const OUT = path.join(__dirname, 'session-result.txt')

const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

let CLEANED = false
function cleanup() {
  if (CLEANED) return
  CLEANED = true
  try {
    const store = require('./session-store')
    for (const r of [A, B]) {
      const f = path.join(store.SESSION_DIR, store.fileFor(r))
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
  } catch (e) {
    console.log('[WARN] 清理会话文件失败：' + String((e && e.message) || e))
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

  // ── 开 A 项目 → 拿会话 → 写两条记录 ────────────────────────────
  log('\n=== ① 打开 A 项目，恢复/新建会话，并记两条 ===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(A)})`)
  await sleep(1500)
  const ra = await P(`await window.moonAPI.sessionResume({ projectContext: window.moonbitIDE.getContext() })`)
  chk('sessionResume 成功', ra.ok === true, JSON.stringify(ra).slice(0, 140))
  eq('会话绑的是 A 项目', ra.session.projectRoot, A)
  const sessA = ra.session.id
  log('   A 的会话：' + ra.describe)

  const ap1 = await P(`await window.moonAPI.sessionAppend(${JSON.stringify({ projectRoot: A, kind: 'message', entry: { role: 'user', text: 'A 项目的秘密：只属于 A' } })})`)
  chk('往 A 追加了一条消息', ap1.ok === true, JSON.stringify(ap1).slice(0, 120))
  await P(`await window.moonAPI.sessionAppend(${JSON.stringify({ projectRoot: A, kind: 'toolCall', entry: { name: 'readFile', ok: true, ms: 3 } })})`)

  // ── 切到 B → 必须是**另一条**会话 ─────────────────────────────
  log('\n=== ② 切到 B 项目 → 应当是另一条会话（P10-09）===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(B)})`)
  await sleep(1500)
  const rb = await P(`await window.moonAPI.sessionResume({ projectContext: window.moonbitIDE.getContext() })`)
  chk('B 也拿到了会话', rb.ok === true)
  eq('B 的会话绑的是 B 项目', rb.session.projectRoot, B)
  chk('★ B 的会话 id 与 A **不同**（没复用）', rb.session.id !== sessA, rb.session.id + ' vs ' + sessA)
  chk('★ B 看不到 A 的消息（跨项目污染检查）', !JSON.stringify(rb.session).includes('A 项目的秘密'), JSON.stringify(rb.session.messages))
  eq('B 的消息还是空的', rb.session.messages.length, 0)

  await P(`await window.moonAPI.sessionAppend(${JSON.stringify({ projectRoot: B, kind: 'message', entry: { role: 'user', text: 'B 项目的问题' } })})`)

  // ── 切回 A → 应当**恢复** A 原来那条（含之前消息）──────────────
  log('\n=== ③ 切回 A → 恢复原会话与内容（P10-08）===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(A)})`)
  await sleep(1500)
  const ra2 = await P(`await window.moonAPI.sessionResume({ projectContext: window.moonbitIDE.getContext() })`)
  eq('★ 回到 A 的会话（同一条 id）', ra2.session.id, sessA)
  eq('★ A 的消息被恢复（1 条）', ra2.session.messages.length, 1)
  chk('★ 恢复的内容里就是 A 那句', JSON.stringify(ra2.session.messages).includes('A 项目的秘密'))
  chk('★ 恢复的会话里**没有** B 的消息', !JSON.stringify(ra2.session).includes('B 项目的问题'))
  chk('restored 标记为真（是从磁盘恢复的）', ra2.restored === true, String(ra2.restored))

  // ── 渲染侧的会话键必须按项目（**真调** aiagent 的 sessionKey，不是自己拼一个键自证）──
  log('\n=== ④ 渲染侧的会话键真的按项目分 ===')
  chk('aiagent 暴露了只读的会话键函数', await js(`typeof window.moonbitAgentSessionKey`) === 'function')
  const keyA = await js(`(() => { try { return window.moonbitAgentSessionKey() } catch (e) { return 'ERR:' + e.message } })()`)
  eq('★ 当前（A 项目）的会话键含项目根', keyA, 'moonbit-agent-session:' + A)

  // 切到 B 再取一次 —— 证明它**随项目变**（旧实现是同一个全局键，所以会串）
  await js(`window.moonbitIDE.openProject(${JSON.stringify(B)})`)
  await sleep(1400)
  const keyB = await js(`(() => { try { return window.moonbitAgentSessionKey() } catch (e) { return 'ERR:' + e.message } })()`)
  eq('★ 切到 B 后键也跟着变', keyB, 'moonbit-agent-session:' + B)
  chk('★ 两个键不同（旧实现是同一个全局键 → 会串项目）', keyA !== keyB)
  eq('  旧的全局键从未被写入', await js(`(() => { try { return localStorage.getItem('moonbit-agent-session') } catch (_) { return null } })()`), null)
  chk('  aiagent 不再引旧全局键（源码里只在注释中提到）',
    !/localStorage\.(get|set|remove)Item\(\s*'moonbit-agent-session'\s*\)/.test(fs.readFileSync(path.join(__dirname, 'aiagent.js'), 'utf8')))

  // 切回 A，后面的用例仍按 A 走
  await js(`window.moonbitIDE.openProject(${JSON.stringify(A)})`)
  await sleep(1400)
  eq('切回 A 后键又变回来', await js(`window.moonbitAgentSessionKey()`), 'moonbit-agent-session:' + A)

  // ── 关闭项目 → 结束会话上下文（P10-10）───────────────────────
  log('\n=== ⑤ 关闭项目 → 结束会话上下文（P10-10）===')
  await js('window.moonbitIDE.closeProject()')
  await sleep(1200)
  const endRes = await P(`await window.moonAPI.sessionEnd(${JSON.stringify(A)})`)
  chk('会话已结束', endRes.ok === true && endRes.session.state === 'ended', JSON.stringify(endRes).slice(0, 120))
  const ra3 = await P(`await window.moonAPI.sessionResume(${JSON.stringify({ projectContext: null })})`)
  eq('无项目时拿到的是不绑定项目的会话', ra3.session.projectRoot, null)
  chk('★ 无项目会话与 A/B 都不是同一条', ra3.session.id !== sessA && ra3.session.id !== rb.session.id)

  // ── 已结束的会话不复活 ───────────────────────────────────────
  log('\n=== ⑥ 已结束的会话不会被复活 ===')
  const ra4 = await P(`await window.moonAPI.sessionResume(${JSON.stringify({ projectContext: { rootDir: A, projectType: 'moonbit' } })})`)
  chk('★ 拿到的是新会话（不是已 ended 的那条）', ra4.session.id !== sessA, ra4.session.id + ' vs ' + sessA)
  eq('  新会话绑的还是 A', ra4.session.projectRoot, A)

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
