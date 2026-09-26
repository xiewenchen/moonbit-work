// PH3-SESSION-VIEW 验证：会话「导出 Markdown」
//
// ⚠️ 这个模块的 10 个导出函数**只在 test-session-view 里被调用过** ——
//    也就是"逻辑写好了、测过了，但产品里点不到"。查缺补漏时扫出来的。
//    所以这个脚本要回答的是"**用户在面板上点得到、点了真能拿到东西**"。
//
// 真路径：开项目 → 开会话面板 → 断言有导出按钮 → 真点 → 断言界面说导出成功
//        → 直接调 IPC 拿回文本，断言它是 Markdown 且是白名单字段（不含内部字段）
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const OUT = path.join(__dirname, 'session-export-result.txt')
const FIXTURE = path.join(__dirname, 'testdata', 'agent-e2e-project')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await new Promise((r) => setTimeout(r, 250)) }
  if (!win) { log('[FATAL] 没拿到窗口'); process.exit(1) }
  await new Promise((r) => setTimeout(r, 3000))
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  try {
    log('=== ① 先打开项目（会话是按项目绑定的）===')
    await js(`window.moonbitIDE.openProject(${JSON.stringify(FIXTURE)})`)
    await sleep(2500)
    const opened = await js(`!!(window.moonbitIDE.getContext && window.moonbitIDE.getContext())`)
    H.chk('项目已打开（会话导出需要它）', opened === true)

    log('\n=== ② 面板上真的有点得到的入口 ===')
    await js(`window.moonbitIDE.session.show()`)
    await sleep(1500)
    const hasBtn = await js(`!!document.getElementById('sessionExportBtn')`)
    H.chk('★ 会话面板上有「导出 Markdown」按钮', hasBtn === true)
    const label = await js(`(document.getElementById('sessionExportBtn') || {}).textContent || ''`)
    H.chk('  文案正确', /导出/.test(String(label)), JSON.stringify(label))

    log('\n=== ③ 直接调 IPC：导出内容必须真的是 Markdown，且是白名单字段 ===')
    const ex = JSON.parse(await js(`(async () => {
      const c = window.moonbitIDE.getContext()
      const r = await window.moonAPI.sessionExport({ projectRoot: c.rootDir, format: 'md' })
      return JSON.stringify({ ok: r && r.ok, format: r && r.format, len: String((r && r.text) || '').length, text: String((r && r.text) || '').slice(0, 400), err: r && r.error })
    })()`))
    H.chk('★ 导出成功（不是"逻辑写了但调不通"）', ex.ok === true, String(ex.err || ''))
    H.eq('  格式是 md', ex.format, 'md')
    H.chk('  文本非空', ex.len > 0, ex.len + ' 字符')
    H.chk('★ 开头是 Markdown 标题（# 开头）', /^#\s/.test(String(ex.text)), JSON.stringify(String(ex.text).slice(0, 60)))
    H.chk('  含「项目：」元信息', /项目：/.test(String(ex.text)))
    H.chk('  含统计行', /统计：/.test(String(ex.text)))
    // ⚠️ 白名单的意义：内部字段不该出现在导出里
    H.chk('★★ 不含内部字段（白名单生效，不是把 session JSON 化）',
      !/"role"\s*:/.test(String(ex.text)) && !/"messages"\s*:/.test(String(ex.text)),
      JSON.stringify(String(ex.text).slice(0, 120)))

    log('\n=== ④ 点按钮：界面要如实反馈 ===')
    await js(`document.getElementById('sessionExportBtn').click()`)
    await sleep(2000)
    // ⚠️ 面板 id 是 sessPanel（不是 sessionPanel —— 第一版我猜错了，报"面板没了"）
    const hintText = await js(`(document.getElementById('sessHint') || {}).textContent || '(没有 sessHint 元素)'`)
    H.chk('★ 点完界面有明确反馈（不静默）', /已导出|导出失败/.test(String(hintText)), JSON.stringify(String(hintText)))
    H.chk('  且这次是成功（不是失败）', /已导出/.test(String(hintText)), JSON.stringify(String(hintText)))
    H.chk('★ 反馈里带上了实际字符数（不是只说"成功"）', /已导出\s*\d+/.test(String(hintText)), JSON.stringify(String(hintText)))

    log('\n=== ⑤ 没有项目时要如实拒绝（不能导出个空文件）===')
    await js(`window.moonbitIDE.closeProject && window.moonbitIDE.closeProject()`)
    await sleep(1200)
    const noProj = JSON.parse(await js(`(async () => {
      const r = await window.moonAPI.sessionExport({ projectRoot: '', format: 'md' })
      return JSON.stringify({ ok: r && r.ok, err: r && r.error })
    })()`))
    H.chk('★ 没有项目时拒绝并说明原因', noProj.ok !== true, JSON.stringify(noProj))
    H.chk('  且给出可读理由', /项目|会话/.test(String(noProj.err || '')), String(noProj.err))
  } catch (e) {
    H.chk('验证中途出错（下面几项可能因此没跑到）', false, String((e && e.message) || e))
    log('[FATAL] 验证中途出错：' + String((e && e.stack) || e))
  }

  log('\n' + H.summary())
  try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (e) { console.log('  （结果文件写不了：' + String((e && e.message) || e) + '）') }
  app.exit(H.exitCode())
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
