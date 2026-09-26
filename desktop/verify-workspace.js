// PH3-WS-03～10 端到端：工作空间**真的**把各子系统串起来了（真读磁盘存储）。
//
// ⚠️ 这一批**不写任何存储、不改任何键** —— 已有数据是用 root/projectRoot 存的，
//    改键等于让用户丢数据。所以验证做的是"读时规范化 + 一致性自检"。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createHarness } = require('./verify-harness')

const ROOT = path.resolve(__dirname, '..')
const USERDIR = path.join(os.homedir(), '.moonbit-work')
const OUT = path.join(__dirname, 'workspace-result.txt')
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
  const J = async (expr) => JSON.parse(await js(`(() => { try { return JSON.stringify(${expr}) } catch (e) { return JSON.stringify({ __throw: String((e && e.message) || e) }) } })()`))
  await sleep(3000)

  log('\n=== ① workspace.js 真的被注入了（renderer 拿得到）===')
  {
    chk('★ window.moonbitWorkspace 存在', await js(`typeof window.moonbitWorkspace === 'object' && window.moonbitWorkspace !== null`), true)
    eq('  暴露了身份函数', await js(`typeof window.moonbitWorkspace.workspaceIdOf`), 'function')
    // 没注入时应当**如实报错**，不静默失败
    const api = await J(`(() => { const w = window.moonbitIDE.workspace; return { has: !!w, id: typeof w.id } })()`)
    chk('★ window.moonbitIDE.workspace 入口在', api.has === true, JSON.stringify(api))
  }

  log('\n=== ② 真读磁盘：各子系统的存储里到底记了什么 ===')
  {
    // 这是"真接线"的证据 —— 不是拿假数据测，而是读用户目录里真实存在的文件
    let wbRaw = null
    try { wbRaw = JSON.parse(fs.readFileSync(path.join(USERDIR, 'workbench.json'), 'utf8')) } catch (e) { wbRaw = null }
    if (!wbRaw) {
      log('  （workbench.json 不存在 —— 本机还没打开过项目，改用真实形状的样本）')
    } else {
      chk('★ workbench.json 用的是 root 字段（不是 projectRoot）',
        !Array.isArray(wbRaw.recent) || wbRaw.recent.length === 0 || Object.prototype.hasOwnProperty.call(wbRaw.recent[0], 'root'),
        JSON.stringify(Object.keys((wbRaw.recent || [{}])[0] || {})))
    }
    // 用真实形状喂给 bindingsFrom（无论文件在不在，形状都是从真实数据核过的）
    const b = await J(`window.moonbitWorkspace.bindingsFrom({
      workbench: { recent: [{ root: 'C:/real-proj', at: 1 }] },
      session: { id: 's', projectRoot: 'C:/real-proj' },
      office: { projectRoot: 'C:/real-proj' },
    })`)
    chk('★ 从 workbench.recent[0].root 抽到绑定', b['workbench(todo/notes)'] === 'C:/real-proj', JSON.stringify(b))
    chk('  从 session.projectRoot 抽到', b['agent-session'] === 'C:/real-proj', JSON.stringify(b))
    chk('  从 office.projectRoot 抽到', b['office-links'] === 'C:/real-proj', JSON.stringify(b))
  }

  log('\n=== ③ ★ 一致性自检：能报出"谁还挂在旧项目上" ===')
  {
    // 三种写法指向同一个目录 → 必须算一致（这就是"读时规范化"的价值）
    const same = await J(`window.moonbitWorkspace.checkBinding('C:/proj', {
      'workbench(todo/notes)': 'C:\\\\proj\\\\',
      'agent-session': 'c:/PROJ',
      'office-links': 'C:/proj',
    })`)
    eq('★ 写法不同（大小写/斜杠）仍算一致', same.consistent, true)
    eq('  没有误报', same.mismatched.length, 0)

    // 真分歧：工作台还挂在旧项目
    const bad = await J(`window.moonbitWorkspace.checkBinding('C:/proj', { 'workbench(todo/notes)': 'C:/old-proj', 'agent-session': 'C:/proj' })`)
    eq('★★ 能报出不一致', bad.consistent, false)
    chk('  且点出是哪个子系统', /workbench/.test(bad.summary), bad.summary)
    eq('  并给出它实际绑到哪', bad.mismatched[0].got, 'C:/old-proj')

    // 缺的记 missing（"没接线"与"接错了"是两回事）
    chk('缺的记 missing 而不是 mismatched', bad.missing.length > 0 && bad.mismatched.length === 1, JSON.stringify({ m: bad.missing.length, x: bad.mismatched.length }))
  }

  log('\n=== ④ 工作空间身份：从 renderer 侧算，与主进程/测试一致 ===')
  {
    const id = await js(`window.moonbitIDE.workspace.id('C:\\\\Users\\\\me\\\\Proj\\\\')`)
    eq('★ 规范化的身份', id, 'ws:c:/users/me/proj')
    chk('  同一目录的另一种写法 → 同身份', await js(`window.moonbitIDE.workspace.same('C:/Users/me/Proj', 'c:/users/me/proj')`) === true)
    chk('  不同目录 → 不同身份', await js(`window.moonbitIDE.workspace.same('C:/a/b', 'C:/a/bc')`) === false)
  }

  log('\n=== ⑤ 元数据位置与删除计划（WS-11：只删元数据）===')
  {
    const md = await J(`window.moonbitIDE.workspace.metadata(${JSON.stringify(ROOT)}, ${JSON.stringify(USERDIR)})`)
    chk('给出了若干元数据位置', Array.isArray(md) && md.length >= 4, String(md && md.length))
    chk('★ 其中有项目内的 .moonbit-work', md.some((m) => /\.moonbit-work/.test(m.p) && m.kind === 'in-project'), JSON.stringify(md.map((m) => m.kind)))
    chk('  其余在用户目录', md.filter((m) => m.kind === 'user-dir').length >= 3)

    const plan = await J(`window.moonbitIDE.workspace.deletePlan(${JSON.stringify(ROOT)}, ${JSON.stringify(USERDIR)})`)
    eq('删除计划能生成', plan.ok, true)
    chk('★ 明确声明不碰源码', /项目源码/.test(String(plan.neverTouches)), String(plan.neverTouches))
    // ★ 硬断言：计划里没有任何一条等于项目根、也不是源码文件
    const normRoot = String(ROOT).replace(/\\/g, '/').toLowerCase()
    for (const it of plan.items) {
      const p = String(it.p).replace(/\\/g, '/').toLowerCase()
      chk('  不是项目根本身：' + it.what, p !== normRoot, it.p)
      chk('  不是源码文件', !/\.(mbt|js)$/.test(it.p) || /workspace-result\.txt$/.test(it.p), it.p)
    }
    // 危险输入
    const bad = await J(`window.moonbitIDE.workspace.deletePlan('C:/', 'C:/Users')`)
    eq('★ 盘符根 → 拒绝', bad.ok, false)
  }

  log('\n=== ⑥ 真的有一致性问题时，界面/Agent 拿得到说明 ===')
  {
    const desc = await js(`window.moonbitIDE.workspace.describe('C:/proj', { 'workbench(todo/notes)': 'C:/proj' })`)
    chk('一致时如实说一致', /各子系统一致/.test(String(desc)), String(desc))
    const desc2 = await js(`window.moonbitIDE.workspace.describe('C:/proj', { 'agent-session': 'C:/other' })`)
    chk('★ 不一致时点出是哪个', /agent-session/.test(String(desc2)), String(desc2))
    eq('没项目 → 明确说（不编一个）', await js(`window.moonbitIDE.workspace.describe('', {})`), '（没有打开项目）')
  }

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
