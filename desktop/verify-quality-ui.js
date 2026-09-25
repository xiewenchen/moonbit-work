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

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { console.log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
