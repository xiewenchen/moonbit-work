// P16-10～12 端到端验证：Quality Center 面板 + 看日志 + 看文件
//
// 数据来自已有验证产物（不重跑测试），所以这个验证跑得很快。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const OUT = path.join(__dirname, 'quality-ui-result.txt')
const PROBE = path.join(__dirname, 'zz-probe-result.txt')   // 临时造一份“失败”的产物
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

function cleanup() {
  try { if (fs.existsSync(PROBE)) fs.unlinkSync(PROBE) } catch (e) {
    console.log('[WARN] 清理探针产物失败：' + String((e && e.message) || e))
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

  log('\n=== ⓪ 造一份“失败”的产物（否则没有失败项可跳）===')
  fs.writeFileSync(PROBE, '  [FAIL] 故意失败的一条\n结果：1 通过 / 2 失败 / 共 3 项\n', 'utf8')
  chk('探针产物已写入', fs.existsSync(PROBE))

  log('\n=== ① P16-10 数据源：聚合已有产物（不重跑）===')
  const snap = await P('await window.moonAPI.qualitySnapshot()')
  chk('qualitySnapshot 成功', snap.ok === true, JSON.stringify(snap).slice(0, 140))
  const s = snap.snapshot || {}
  chk('给了总体状态', typeof s.overall === 'string', String(s.overall))
  chk('给了 canProceed 与原因', s.canProceed && typeof s.canProceed.ok === 'boolean' && !!s.canProceed.reason, JSON.stringify(s.canProceed))
  chk('带各状态计数', !!(s.stats && s.stats.byState), JSON.stringify(s.stats))
  chk('★ 确实扫到了已有验证产物（本次仓库里有一批）', (s.scannedFiles || 0) >= 1, String(s.scannedFiles))
  chk('  且不是全部 NOT_RUN（说明真的解析出了结果）', (s.all || []).some((x) => x.state !== 'NOT_RUN') || s.overall === 'PASS', JSON.stringify((s.all || []).map((x) => x.name + ':' + x.state).slice(0, 4)))

  log('\n=== ② P16-10 面板真的能打开并渲染 ===')
  await js('window.moonbitIDE.quality.show()')
  await sleep(1200)
  chk('面板出现', await js(`!!document.getElementById('qualityPanel')`), true)
  const text = await js(`(() => { const p = document.getElementById('qualityPanel'); return p ? p.textContent : '' })()`)
  chk('面板里有总体状态描述', /工程状态：/.test(String(text)), String(text).slice(0, 120))
  chk('面板里有"可以继续 / 先别继续"的判断', /可以继续|先别继续/.test(String(text)), String(text).slice(0, 200))
  const rows = await js(`document.querySelectorAll('#qualityList > div').length`)
  chk('列出了条目', rows >= 2, String(rows))

  log('\n=== ③ P16-11 点"看日志"→ 显示原文 ===')
  const clicked = await js(`(() => {
    const b = Array.from(document.querySelectorAll('#qualityPanel button')).find((x) => x.textContent === '看日志')
    if (!b) return 'no-button'
    b.click()
    return 'clicked'
  })()`)
  eq('找到并点了"看日志"', clicked, 'clicked')
  await sleep(700)
  const d1 = await js(`(() => { const d = document.getElementById('qualityDetail'); return d && d.style.display !== 'none' ? d.textContent : '' })()`)
  chk('★ 日志面板显示出来了', String(d1).length > 0, String(d1).slice(0, 120))
  chk('  且确实是验证脚本的原文（含 PASS/结果字样）', /\[PASS\]|结果[:：]|✅/.test(String(d1)), String(d1).slice(0, 100))

  log('\n=== ④ P16-12 点"跳到 …"→ 定位到那份产物 ===')
  const jumped = await js(`(() => {
    const b = Array.from(document.querySelectorAll('#qualityPanel button')).find((x) => /^跳到 /.test(x.textContent))
    if (!b) return 'no-button'
    b.click()
    return 'clicked:' + b.textContent
  })()`)
  chk('★ 找到了"跳到 …"按钮并点击（失败项才有）', String(jumped).indexOf('clicked:') === 0, jumped)
  await sleep(700)
  const d2 = await js(`(() => { const d = document.getElementById('qualityDetail'); return d && d.style.display !== 'none' ? d.textContent : '' })()`)
  chk('定位后面板有内容', String(d2).length > 0, String(d2).slice(0, 100))

  log('\n=== ⑤ 读日志的边界：不许读任意文件 ===')
  const bad = await P(`await window.moonAPI.qualityLog('C:/Windows/System32/drivers/etc/hosts')`)
  eq('★ 非验证产物 → 拒绝', bad.ok, false)
  chk('  说明原因', /不是允许的验证产物|路径越界/.test(String(bad.error)), String(bad.error))
  const bad2 = await P(`await window.moonAPI.qualityLog('../../etc/passwd')`)
  eq('★ 相对路径穿越 → 拒绝', bad2.ok, false)

  log('\n=== ⑥ 关闭 ===')
  await js(`(() => { const b = Array.from(document.querySelectorAll('#qualityPanel button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(400)
  eq('关闭后面板消失', await js(`!document.getElementById('qualityPanel')`), true)

  log('\n=== ⑦ PH3-IDE-08：Agent 验证结果也进 Quality ===')
  {
    // 模拟主进程推来一次"验证失败"的结果（走的是真实的收件代码路径：置 __lastAgentVerify）
    await js(`(() => {
      window.__lastAgentVerify = { name: 'agent-verify（最近一次）', text: '检查：失败\\n结果：12 通过 / 3 失败', ok: false, at: Date.now() }
      return true
    })()`)
    const snap = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.quality.snapshot()))()`))
    chk('quality.snapshot 成功', snap.ok === true, JSON.stringify(snap).slice(0, 120))
    const s = snap.snapshot || {}
    const hit = (s.all || []).find((x) => String(x.name).indexOf('最近一次') >= 0)
    chk('★ Agent 的验证结果出现在工程状态里', !!hit, JSON.stringify((s.all || []).map((x) => x.name).slice(0, 8)))
    chk('★ 而且是 FAIL（3 个失败不美化）', !!hit && hit.state === 'FAIL', hit ? hit.state : 'missing')
    chk('  带上了通过/失败计数', !!hit && hit.passed === 12 && hit.failed === 3, hit ? (hit.passed + '/' + hit.failed) : '')

    // 通过的情况也要如实标 PASS
    await js(`(() => { window.__lastAgentVerify = { name: 'agent-verify（最近一次）', text: '结果：20 通过 / 0 失败', ok: true, at: Date.now() }; return true })()`)
    const snap2 = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.quality.snapshot()))()`))
    const hit2 = (snap2.snapshot.all || []).find((x) => String(x.name).indexOf('最近一次') >= 0)
    chk('★ 全通过时标 PASS', !!hit2 && hit2.state === 'PASS', hit2 ? hit2.state : 'missing')

    // 没跑过验证时不能凭空多出一条
    await js(`(() => { delete window.__lastAgentVerify; return true })()`)
    const snap3 = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.quality.snapshot()))()`))
    const hit3 = (snap3.snapshot.all || []).find((x) => String(x.name).indexOf('最近一次') >= 0)
    eq('★ 没跑过验证时不会凭空出现一条', hit3, undefined)
  }

  log('\n=== ⑧ PH3-Q-06/07/08：事实层接线（真实 commit / 环境 / mtime）===')
  {
    const snap = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.quality.snapshot()))()`))
    const s = snap.snapshot || {}
    chk('★ 快照带上了 fact 字段（旧字段仍在）', !!s.fact, JSON.stringify(Object.keys(s).slice(0, 12)))
    chk('  旧字段没被换掉（overall/all/failures 都还在）', typeof s.overall === 'string' && Array.isArray(s.all) && Array.isArray(s.failures))
    const f = s.fact || {}
    chk('★ fact.commit 是真实的短 hash（读 .git/HEAD）', /^[0-9a-f]{7,8}$/.test(String(f.commit)), String(f.commit))
    eq('★ fact.environment 是本机平台', f.environment, 'windows')
    eq('★ fact.origin 记 LOCAL（是本机跑 verify 脚本产出的，不是 CI）', f.origin, 'LOCAL')
    chk('  fact.overall 与旧的 overall 一致', f.overall === s.overall, f.overall + ' vs ' + s.overall)
    chk('  有可读描述', /工程状态：/.test(String(f.describe)), String(f.describe).slice(0, 80))

    // 每条结果都带"什么时候跑的"（来自产物 mtime，不是编的）
    const withTime = (s.all || []).filter((x) => Number.isFinite(x.verifiedAt))
    chk('★ 结果带 verifiedAt（来自产物文件 mtime）', withTime.length > 0, withTime.length + '/' + (s.all || []).length)
    const t0 = withTime[0] && withTime[0].verifiedAt
    chk('  而且是个合理的时间戳（不是 0）', Number.isFinite(t0) && t0 > 1600000000000, String(t0))

    // PH3-Q-05：每条结果都有 provenance 的四个字段
    const p0 = (withTime[0] || {}).provenance
    chk('★ 带 provenance（谁跑的/何时/什么命令/什么环境）', !!p0, JSON.stringify(p0))
    eq('  谁跑的', p0.origin, 'LOCAL')
    eq('  什么环境', p0.env, 'windows')
    chk('  哪个 commit', /^[0-9a-f]{7,8}$/.test(String(p0.commit)), String(p0.commit))
    chk('★ 工具链命令如实留 null（结果里本来就没记，不编）', p0.command === null, JSON.stringify(p0.command))

    // PH3-Q-08：Agent 的只读工具也拿到同一份事实
    const ag = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentTools.call('qualityStatus', {})))()`))
    chk('★ Agent 的 qualityStatus 工具能拿到', ag.ok === true, JSON.stringify(ag).slice(0, 120))
    const agFact = (ag.data && ag.data.fact) || null
    chk('★ 而且里面也有 fact（Agent 能据此判断能不能继续）', !!agFact, JSON.stringify(agFact && Object.keys(agFact)))
    chk('  带 canProceed（PH3-Q-09）', !!(agFact && agFact.canProceed), JSON.stringify(agFact && agFact.canProceed))
  }

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
