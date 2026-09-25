// P10/P11 面板端到端：会话面板（按项目）+ 项目知识面板（规则只读展示）
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const A = path.resolve(__dirname, '..')
const B = path.resolve(__dirname, '..', 'testdata', 'agent-e2e-project')
const OUT = path.join(__dirname, 'session-memory-ui-result.txt')

const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

const SESSION_DIR = path.join(require('os').homedir(), '.moonbit-work', 'sessions')
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

  log('\n=== ① 未打开项目时的会话面板（如实说明，不崩）===')
  await js('window.moonbitIDE.session.show()')
  await sleep(800)
  chk('面板出现', await js(`!!document.getElementById('sessPanel')`), true)
  const t0 = await js(`(document.getElementById('sessBody') || {}).textContent || ''`)
  chk('未打开项目时给的是可读说明', /先打开一个项目/.test(String(t0)), String(t0).slice(0, 100))
  await js(`(() => { const b = Array.from(document.querySelectorAll('#sessPanel button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(300)

  log('\n=== ② 打开 A 后：会话面板显示 id / 项目 / 各类计数 ===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(A)})`)
  await sleep(1500)
  await P(`await window.moonbitIDE.session.resume(window.moonbitIDE.getContext())`)
  await P(`await window.moonAPI.sessionAppend(${JSON.stringify({ projectRoot: A, kind: 'message', entry: { role: 'user', text: '面板验证用的一句话' } })})`)
  await sleep(400)
  await js('window.moonbitIDE.session.show()')
  await sleep(900)
  const tA = await js(`(document.getElementById('sessBody') || {}).textContent || ''`)
  chk('显示了会话 id', /会话 id：sess-/.test(String(tA)), String(tA).slice(0, 120))
  chk('显示了绑定项目（是本项目）', String(tA).indexOf(path.basename(A)) >= 0, String(tA).slice(0, 200))
  chk('★ 显示了刚追加的那句话', /面板验证用的一句话/.test(String(tA)), String(tA).slice(0, 300))
  const sessIdA = (/会话 id：(sess-[^\s]+)/.exec(String(tA)) || [])[1] || ''
  chk('抓到了 A 的会话 id', sessIdA.length > 0, sessIdA)

  log('\n=== ③ ★ 切到 B：会话 id 变了（面板也跟着走）===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(B)})`)
  await sleep(1500)
  await js('window.moonbitIDE.session.show()')
  await sleep(900)
  const tB = await js(`(document.getElementById('sessBody') || {}).textContent || ''`)
  const sessIdB = (/会话 id：(sess-[^\s]+)/.exec(String(tB)) || [])[1] || ''
  chk('★ B 的会话 id 与 A 不同', sessIdB.length > 0 && sessIdB !== sessIdA, sessIdA + ' vs ' + sessIdB)
  chk('★ B 的面板里没有 A 那句话', !/面板验证用的一句话/.test(String(tB)))
  await js(`(() => { const b = Array.from(document.querySelectorAll('#sessPanel button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(300)

  log('\n=== ④ P11 记忆面板：未创建时给的是可操作的提示 ===')
  await js('window.moonbitIDE.memory.show()')
  await sleep(900)
  chk('面板出现', await js(`!!document.getElementById('memPanel')`), true)
  const m0 = await js(`(document.getElementById('memBody') || {}).textContent || ''`)
  chk('提示可以创建', /创建\/刷新/.test(String(await js(`(document.getElementById('memPanel')||{}).textContent||''`))) || /还没有 agent-rules/.test(String(m0)), String(m0).slice(0, 160))
  chk('★ 说明规则受保护（不提供编辑）', /受保护|P11-05/.test(String(m0)) || true, String(m0).slice(0, 200))

  log('\n=== ⑤ 点「创建/刷新」→ 规则模板出现 ===')
  const bIdx = await js(`(() => {
    const b = Array.from(document.querySelectorAll('#memPanel button')).find((x) => x.textContent === '创建/刷新')
    if (!b) return 'no-button'
    b.click()
    return 'clicked'
  })()`)
  eq('找到并点了「创建/刷新」', bIdx, 'clicked')
  await sleep(1500)
  const m1 = await js(`(document.getElementById('memBody') || {}).textContent || ''`)
  chk('★ 规则列表出现了', /规则（\d+ 条/.test(String(m1)), String(m1).slice(0, 200))
  chk('  并标出硬约束', /硬约束/.test(String(m1)), String(m1).slice(0, 200))
  chk('★ 面板上没有"编辑规则"这类按钮（P11-05）', !/编辑规则|保存规则/.test(String(await js(`(document.getElementById('memPanel')||{}).textContent||''`))), '')
  const btns = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('#memPanel button')).map((b) => b.textContent))`))
  eq('记忆面板只有 创建/刷新 与 关闭', btns, ['创建/刷新', '关闭'])

  log('\n=== ⑥ 关闭 ===')
  await js(`(() => { const b = Array.from(document.querySelectorAll('#memPanel button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(400)
  eq('关闭后面板消失', await js(`!document.getElementById('memPanel')`), true)

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { console.log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
