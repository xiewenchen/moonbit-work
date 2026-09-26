// P13-04～07 端到端：办公文件 ↔ 项目联动（面板 + 关联隔离 + 便签追加）
//
// ⚠️ 会写用户目录的两个文件（office-links.json / workbench.json），所以进去前备份、
// 任何退出路径都还原 —— 与 P12 改 opencode 配置同样的处理。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createHarness } = require('./verify-harness')

const A = path.resolve(__dirname, '..')
const B = path.resolve(__dirname, '..', 'testdata', 'agent-e2e-project')
const DIR = path.join(os.homedir(), '.moonbit-work')
const FILES = [path.join(DIR, 'office-links.json'), path.join(DIR, 'workbench.json')]
const OUT = path.join(__dirname, 'office-result.txt')

const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

let BACKUPS = null
let BACKED_UP = false
let RESTORED = false
function backupNow() {
  if (BACKED_UP) return
  BACKUPS = FILES.map((f) => ({ f, data: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null }))
  BACKED_UP = true
}
function restore() {
  if (RESTORED) return
  RESTORED = true
  if (!BACKED_UP || !BACKUPS) return
  for (const b of BACKUPS) {
    try {
      if (b.data === null) { if (fs.existsSync(b.f)) fs.unlinkSync(b.f) } else fs.writeFileSync(b.f, b.data, 'utf8')
    } catch (e) {
      console.log('[WARN] 还原 ' + b.f + ' 失败：' + String((e && e.message) || e))
    }
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

backupNow()

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  const P = async (expr) => JSON.parse(await js(`(async () => JSON.stringify(${expr}))()`))
  await sleep(3000)

  log('\n=== ① 面板能打开（未打开项目时给可读说明）===')
  await js('window.moonbitIDE.office.show()')
  await sleep(800)
  chk('面板出现', await js(`!!document.getElementById('officePanel')`), true)
  const t0 = await js(`(document.getElementById('officeList') || {}).textContent || ''`)
  chk('未打开项目时说明可读', /先打开一个项目/.test(String(t0)), String(t0).slice(0, 80))

  log('\n=== ② P13-04 关联：本项目 ===')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(A)})`)
  await sleep(1500)
  const l1 = await P(`await window.moonbitIDE.office.link({ file: 'C:/Users/me/Downloads/甲报告.docx', kind: 'docx', projectRoot: ${JSON.stringify(A)} })`)
  chk('关联成功', l1.ok === true, JSON.stringify(l1).slice(0, 140))
  eq('  列表里有它', (l1.links || []).map((x) => x.name), ['甲报告.docx'])
  await js('window.moonbitIDE.office.show()')
  await sleep(900)
  const tA = await js(`(document.getElementById('officeList') || {}).textContent || ''`)
  chk('★ 面板上能看到这条关联', /甲报告/.test(String(tA)), String(tA).slice(0, 160))

  log('\n=== ③ ★ 关联也按项目隔离 ===')
  const lB = await P(`await window.moonbitIDE.office.link({ file: 'C:/Users/me/Downloads/乙表格.xlsx', kind: 'xlsx', projectRoot: ${JSON.stringify(B)} })`)
  chk('B 也关联成功', lB.ok === true)
  const aList = await P(`await window.moonbitIDE.office.links(${JSON.stringify(A)})`)
  const bList = await P(`await window.moonbitIDE.office.links(${JSON.stringify(B)})`)
  eq('★ A 只看到 A 的', (aList.links || []).map((x) => x.name), ['甲报告.docx'])
  eq('★ B 只看到 B 的', (bList.links || []).map((x) => x.name), ['乙表格.xlsx'])
  chk('★ A 的列表里没有 B 的文件', !JSON.stringify(aList.links).includes('乙表格'))
  eq('没给项目 → 空（不倒全部）', (await P(`await window.moonbitIDE.office.links(null)`)).links.length, 0)
  eq('反查文件归属', (await P(`await window.moonbitIDE.office.projectOf('C:/Users/me/Downloads/甲报告.docx')`)).projectRoot, A)

  log('\n=== ④ P13-05/06 预览与送进 Agent（每样都带出处）===')
  const pv = await P(`await window.moonbitIDE.office.preview({ meta: { title: '季度经营报告', creator: '张三', pages: '8' }, file: 'a.docx', kind: 'docx' })`)
  chk('预览列出元信息', pv.preview.hasMeta === true && pv.preview.rows.length >= 3, JSON.stringify(pv.preview).slice(0, 160))
  chk('  并写明"不是排版还原"', /不是排版还原/.test(pv.preview.note), pv.preview.note)
  const pv0 = await P(`await window.moonbitIDE.office.preview({})`)
  eq('★ 没元信息 → hasMeta=false（不装作有）', pv0.preview.hasMeta, false)

  const sn = await P(`await window.moonbitIDE.office.toAgent({ file: 'C:/Users/me/Downloads/甲报告.docx', kind: 'docx', text: '第三季度营收增长 12%' })`)
  chk('送进 Agent 成功', sn.ok === true, JSON.stringify(sn).slice(0, 120))
  chk('★ 片段里标明了文件与类型', /甲报告\.docx/.test(sn.snippet) && /docx/.test(sn.snippet), sn.snippet.slice(0, 120))
  chk('★ 也标明了它已关联的项目', String(sn.snippet).indexOf(path.basename(A)) >= 0 || String(sn.snippet).indexOf(A) >= 0, sn.snippet.slice(0, 220))
  chk('带上正文', /营收增长/.test(sn.snippet))

  log('\n=== ⑤ ★ P13-07 结论追加到便签（不覆盖原有）===')
  const note0 = await P(`await window.moonbitIDE.workbench.load(${JSON.stringify(A)})`)
  const before = String(note0.note || '')
  const s1 = await P(`await window.moonbitIDE.office.summaryToNote({ projectRoot: ${JSON.stringify(A)}, summary: '第一条 Agent 结论' })`)
  chk('追加成功', s1.ok === true, JSON.stringify(s1).slice(0, 140))
  const s2 = await P(`await window.moonbitIDE.office.summaryToNote({ projectRoot: ${JSON.stringify(A)}, summary: '第二条 Agent 结论' })`)
  chk('再追加一次也成功', s2.ok === true)
  const after = String((await P(`await window.moonbitIDE.workbench.load(${JSON.stringify(A)})`)).note || '')
  chk('★ 两条结论都在（追加而非覆盖）', /第一条 Agent 结论/.test(after) && /第二条 Agent 结论/.test(after), after.slice(0, 200))
  chk('★ 原有便签内容也还在', before === '' || after.indexOf(before.trim().slice(0, 30)) >= 0, after.slice(0, 160))

  log('\n=== ⑥ 解除关联 ===')
  const un = await P(`await window.moonbitIDE.office.unlink('C:/Users/me/Downloads/甲报告.docx')`)
  chk('解除成功', un.ok === true, JSON.stringify(un).slice(0, 120))
  eq('  列表空了', (await P(`await window.moonbitIDE.office.links(${JSON.stringify(A)})`)).links.length, 0)

  log('\n=== 收尾 ===')
  restore()
  chk('用户文件已还原', true)

  log('\n=== ⑦ P13-04 补：从「中转站」选文件（不再手填路径）===')
  {
    // 造一个真的 Office 文件并备份，让它出现在中转站列表里
    const probeFile = path.join(A, 'relay-probe.docx')
    fs.writeFileSync(probeFile, 'PK\u0003\u0004not-a-real-docx', 'utf8')
    const bk = await P(`await window.moonAPI.relayBackup(${JSON.stringify(probeFile)}, 'verify-office 造')`)
    chk('造了一个中转站条目（relayBackup）', bk && bk.ok !== false, JSON.stringify(bk).slice(0, 120))

    // 重开面板（refresh 里会拉 relay 列表）
    await js('window.moonbitIDE.office.show()')
    await sleep(1000)
    chk('★ 面板里出现了「从中转站选」区', await js(`!!document.getElementById('officeRelay')`), true)
    const box = await js(`(document.getElementById('officeRelay') || {}).textContent || ''`)
    chk('★ 列表里含刚备份的那个文件（说明数据真的来自 relay）', String(box).indexOf('relay-probe.docx') >= 0, String(box).slice(0, 200))

    // 点"看元信息" → 元信息直接喂给预览
    await js(`(() => {
      const rows = Array.from(document.querySelectorAll('#officeRelay > div'))
      const r = rows.find((x) => x.textContent.indexOf('relay-probe.docx') >= 0)
      const b = r && Array.from(r.querySelectorAll('button')).find((x) => x.textContent === '看元信息')
      if (b) b.click()
    })()`)
    await sleep(800)
    const metaOut = await js(`(() => { const o = document.getElementById('officeOut'); return o && o.style.display !== 'none' ? o.textContent : '' })()`)
    chk('★ 点「看元信息」后显示了内容', String(metaOut).length > 0, String(metaOut).slice(0, 140))
    chk('  且写明了没有内置属性（假 docx 不该假装读出元信息）', /没有可读的内置属性|出处|内置/.test(String(metaOut)), String(metaOut).slice(0, 120))

    // 点"关联到本项目" → 关联成功（这一步以前要手填路径）
    const beforeLinks = (await P(`await window.moonbitIDE.office.links(${JSON.stringify(A)})`)).links.length
    await js(`(() => {
      const rows = Array.from(document.querySelectorAll('#officeRelay > div'))
      const r = rows.find((x) => x.textContent.indexOf('relay-probe.docx') >= 0)
      const b = r && Array.from(r.querySelectorAll('button')).find((x) => x.textContent === '关联到本项目')
      if (b) b.click()
    })()`)
    await sleep(1200)
    const after = await P(`await window.moonbitIDE.office.links(${JSON.stringify(A)})`)
    chk('★ 一键关联成功（不用手填路径）', after.links.length > beforeLinks, beforeLinks + '→' + after.links.length)
    chk('  关联到的就是那个文件', (after.links || []).some((l) => String(l.file).indexOf('relay-probe.docx') >= 0), JSON.stringify(after.links).slice(0, 160))

    // 收尾：解关联 + 删探针
    await P(`await window.moonbitIDE.office.unlink(${JSON.stringify(probeFile)})`)
    try { fs.unlinkSync(probeFile) } catch (e) { log('  （探针文件删除失败，忽略：' + e.message + '）') }
  }

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
