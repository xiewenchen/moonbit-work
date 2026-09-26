// PH3-Q-10/11 界面入口验证：质量面板的「记为基线」按钮
//
// ⚠️ 这个脚本要回答的是"**用户点得到、点了真有用**"，而不是"后端有 saveBaseline 这个方法"。
//    两者差别很大：接口名字不匹配时，按钮点下去**不报错、也不保存** —— 这种静默失败最难发现。
//
// 真点路径：开面板 → 覆盖 confirm（无头环境弹不出原生对话框）→ 点「记为基线」
//          → 断言退化行说明确说"已记为基线" → 再刷新 → 断言不再是"还没有上次记录"
//          → 断言用户目录真的落了文件 → 最后**清理掉**（不留痕、不影响以后的真实验证）
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const appDir = __dirname
const RESULT = path.join(appDir, 'quality-baseline-result.txt')
const USER_DIR = path.join(os.homedir(), '.moonbit-work')
const BASE_FILE = path.join(USER_DIR, 'quality-last.json')

// 用仓库统一的 harness（不再自己写一份 chk —— 那会被「禁止局部 chk」门禁拦下）
const { createHarness } = require('./verify-harness')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
// ⚠️ 必须写成"直接别名"（即把 H 的 chk 直接赋给本地名），扫描器认这种是迁移后的写法；
//    写成箭头包装（本地名 = (n,ok,d) => H.chk(...)）会被当成"又一份局部 chk 定义"而拦下。
//    另外：**别在这行上方的注释里原样写出那个赋值语句** —— 扫描器用正则扫源码（含注释），
//    注释里的那半句会被当成真定义（这条规则就踩过一次）。
const chk = H.chk
const done = () => {
  // 写结果文件失败不改变结论（但仍要说一声，不静默吞）
  try { fs.writeFileSync(RESULT, lines.join('\n') + '\n', 'utf8') } catch (e) { console.log('  （结果文件写不了：' + String((e && e.message) || e) + '）') }
  log('\n' + H.summary())
  app.exit(H.exitCode())
}

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await new Promise((r) => setTimeout(r, 250)) }
  if (!win) { log('[FATAL] 没拿到窗口'); process.exit(1) }
  await new Promise((r) => setTimeout(r, 3000))
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 先记下用户目录里有没有已存在的基线 —— 跑完要恢复原状（不能污染真实使用）
  let hadBase = false, backup = null
  try { backup = fs.readFileSync(BASE_FILE, 'utf8'); hadBase = true } catch (_) { /* 没有是常态 */ }
  const restore = () => {
    try {
      if (hadBase) fs.writeFileSync(BASE_FILE, backup, 'utf8')
      else if (fs.existsSync(BASE_FILE)) fs.unlinkSync(BASE_FILE)
    } catch (_) { /* 尽力恢复 */ }
  }

  try {
    log('=== ① 面板上真有这个入口（不是只有后端方法）===')
    await js(`window.moonbitIDE.quality.show()`)
    await sleep(1200)
    const hasBtn = await js(`!!document.getElementById('qualitySetBaseline')`)
    chk('★ 质量面板上有「记为基线」按钮', hasBtn === true)
    const btnText = await js(`(document.getElementById('qualitySetBaseline') || {}).textContent || ''`)
    chk('  按钮文案是「记为基线」', /记为基线/.test(String(btnText)), JSON.stringify(btnText))
    const hasRegEl = await js(`!!document.getElementById('qualityRegression')`)
    chk('  退化行也在（id 只有一个，没重复建）', hasRegEl === true)
    const regCount = await js(`document.querySelectorAll('#qualityRegression').length`)
    chk('★ #qualityRegression 只有 1 个', regCount === 1, '实际 ' + regCount)

    log('\n=== ② 点下去真有用（确认对话框要覆盖，无头环境弹不出）===')
    // ⚠️ 点击前的 mtime —— 这才是判断"按钮那次到底写没写"的**真实证据**。
    //    （本来想包装 window.moonAPI.qualitySnapshot 记下返回，但 contextBridge 暴露的 API
    //     是只读的、赋值被静默忽略 —— 诊断里就显示了"（没调到）"，正好自证。）
    let mtimeBeforeClick = null
    try { mtimeBeforeClick = fs.statSync(BASE_FILE).mtimeMs } catch (_) { /* 第一次跑还没有 */ }
    // 覆盖 confirm 让它直接同意；同时把「调用了 confirm」记下来，证明代码确实问了用户
    await js(`(() => { window.__confirmCalls = []; window.confirm = (m) => { window.__confirmCalls.push(String(m)); return true }; return true })()`)
    // 点按钮
    await js(`document.getElementById('qualitySetBaseline').click()`)
    await sleep(2500)
    // 注：本想过包装 window.moonAPI.qualitySnapshot 记下它的返回，但 contextBridge
    //     暴露的 API 是只读的、赋值被静默忽略（诊断里显示"没调到"，正好自证）——
    //     所以判断"到底写没写"一律用**文件的 mtime**这个真实证据。
    log('  · 判断依据：以基线文件 mtime 的变化为准（不依赖任何包装）')
    // ⚠️ 上面的包装**多半无效**：contextBridge 暴露的 API 是只读的，赋值会被静默忽略。
    //    判断"按钮那次到底保存没有"必须用**真实证据**：文件的 mtime。
    let mtimeAfterClick = null
    try { mtimeAfterClick = fs.statSync(BASE_FILE).mtimeMs } catch (_) { /* 没有 */ }
    log('  · 证据：基线文件 mtime = ' + String(mtimeAfterClick) + '（点击前 = ' + String(mtimeBeforeClick) + '）')
    chk('★ 点按钮**确实让基线文件被（重新）写入**', mtimeAfterClick !== null && mtimeAfterClick !== mtimeBeforeClick,
      String(mtimeBeforeClick) + ' → ' + String(mtimeAfterClick))
    const confirmed = await js(`JSON.stringify(window.__confirmCalls || [])`)
    // 覆盖 confirm 前先记下 mtime（要在 click 之前取，所以提到 ② 开头更合适）
    chk('★ 点按钮会先问用户（二次确认，因为它改变比较基准）', /记为基线/.test(String(confirmed)), String(confirmed).slice(0, 80))
    const regAfter = await js(`(document.getElementById('qualityRegression') || {}).textContent || ''`)
    chk('★★ 退化行明确说「已记为基线」（不是静默不保存）', /已记为基线/.test(String(regAfter)), JSON.stringify(String(regAfter).slice(0, 60)))

    log('\n=== ③ 用户目录真的落了记录 ===')
    chk('★ quality-last.json 已写出', fs.existsSync(BASE_FILE))
    let parsed = null
    try { parsed = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')) } catch (_) { /* 解析失败下面断言 */ }
    chk('  内容是合法 JSON', parsed !== null)
    chk('★ 含可比的最小集合：results 是数组', Array.isArray(parsed && parsed.results), JSON.stringify(parsed && Object.keys(parsed)))
    chk('  且每条只存 name/state/passed/failed（不把 detail 全文写进用户目录）',
      Array.isArray(parsed && parsed.results) && parsed.results.every((r) => Object.keys(r).every((k) => ['name', 'state', 'passed', 'failed'].includes(k))),
      JSON.stringify(parsed && parsed.results && parsed.results[0]))
    chk('  有时间戳', Number.isFinite(parsed && parsed.at))

    log('\n=== ④ 再刷新：不再是「还没有上次记录」，而是真做了比较 ===')
    await js(`document.getElementById('qualityPanel') && document.getElementById('qualityPanel').remove()`)
    await js(`window.moonbitIDE.quality.show()`)
    await sleep(2000)
    const reg2 = await js(`(document.getElementById('qualityRegression') || {}).textContent || ''`)
    chk('★ 已经能比较了（不再是 first）', !/还没有上次记录/.test(String(reg2)), JSON.stringify(String(reg2).slice(0, 60)))
    chk('  且给出结论（有退化 / 没有退化 之一）', /退化/.test(String(reg2)), JSON.stringify(String(reg2).slice(0, 60)))

    log('\n=== ⑤ 名字统一（这是原来会静默失败的根因）===')
    // 直接调 IPC：saveBaseline 必须被边界翻译成内部用的 save
    const viaIpc = await js(`(async () => { const r = await window.moonAPI.qualitySnapshot({ saveBaseline: true }); return JSON.stringify({ saved: !!(r && r.regression && r.regression.saved), raw: r && r.snapshot && r.snapshot.regression }) })()`)
    chk('★ 传 saveBaseline 也会真的保存（边界做了名字归一）', /"saved":true/.test(String(viaIpc)), String(viaIpc).slice(0, 140))
  } catch (e) {
    H.chk('验证中途出错（下面几项可能因此没跑到）', false, String((e && e.message) || e))
    log('[FATAL] 验证中途出错：' + String((e && e.stack) || e))
  } finally {
    restore()
  }

  const stillThere = fs.existsSync(BASE_FILE)
  log('\n=== ⑥ 不留痕 ===')
  chk('★ 已恢复用户目录原状（不污染真实使用）', stillThere === hadBase, 'had=' + hadBase + ' now=' + stillThere)
  done()
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
