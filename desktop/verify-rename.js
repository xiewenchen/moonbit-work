// 验证 rename 的「数据面」：LSP 到底返回多少处改动、是不是同一个文件。
//
// 说明：Monaco 侧的行为（原子应用、一次 Ctrl+Z 全撤、versionId 过期拒绝）
// 是框架自身保证，脚本不重复验证 —— 那三条由真人按 F2 手验。
// 这个脚本只回答两个我问得起的问题：
//   1. LSP 返回的 WorkspaceEdit 里，当前文件有多少处？（决定确认框里的"将改 N 处"）
//   2. 是否真的只涉及当前文件？（决定"跨文件暂未开放"的提示对不对）
// 复用真实主进程：所有 IPC（含 lsp:* / backend:*）都在 main.js 里注册。
// 自己 createWindow 会拿不到任何 handler —— 这是踩过的坑，规矩就是 require main.js。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = process.argv[2]
if (!ROOT) { console.error('用法: electron verify-rename.js <项目根>'); process.exit(1) }

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('  [PASS] ' + m) }
const no = (m) => { fail++; console.log('  [FAIL] ' + m) }

app.whenReady().then(async () => {
  // 等 main.js 把窗口建好
  await new Promise((r) => setTimeout(r, 3000))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.error('没拿到 main.js 创建的窗口'); app.exit(1); return }

  const file = path.join(ROOT, 'http', 'http.mbt')
  if (!fs.existsSync(file)) { console.error('找不到 ' + file); app.exit(1); return }
  const text = fs.readFileSync(file, 'utf8')

  // safe_byte 在 http.mbt 里被调用多次 —— 是个理想的改名对象（同文件多处）
  const N = (text.match(/\bsafe_byte\b/g) || []).length
  console.log(`\n【rename 数据面】http.mbt 里 safe_byte 出现 ${N} 次`)

  const r = await win.webContents.executeJavaScript(`(async () => {
    const root = ${JSON.stringify(ROOT)}
    const file = ${JSON.stringify(file)}
    const text = ${JSON.stringify(text)}
    const started = await window.moonAPI.lspStart(root)
    if (!started || !started.ok) return { err: 'lsp start failed: ' + (started && started.error) }
    await window.moonAPI.lspOpen({ root, file, text })
    // safe_byte 的定义在 28 行附近（0-based 27 行、列 4 左右）
    const lines = text.split(/\\r?\\n/)
    let ln = -1, ch = -1
    for (let i = 0; i < lines.length; i++) {
      const c = lines[i].indexOf('fn safe_byte')
      if (c >= 0) { ln = i; ch = c + 3; break }
    }
    if (ln < 0) {
      for (let i = 0; i < lines.length; i++) {
        const c = lines[i].indexOf('safe_byte')
        if (c >= 0) { ln = i; ch = c; break }
      }
    }
    const rr = await window.moonAPI.lspRename({ root, file, line: ln, character: ch, newName: 'safe_byte_renamed' })
    if (!rr || !rr.ok || !rr.result) return { err: 'rename failed: ' + (rr && rr.error), found: { ln, ch } }
    const changes = rr.result.changes || {}
    const keys = Object.keys(changes)
    const norm = (s) => { try { return decodeURIComponent(String(s)).toLowerCase() } catch (_) { return String(s).toLowerCase() } }
    const curKey = keys.find((k) => norm(k).endsWith('/http.mbt'))
    return {
      found: { ln, ch },
      fileCount: keys.length,
      curFileEdits: curKey ? changes[curKey].length : 0,
      allSameFile: keys.length === 1,
      sample: curKey ? changes[curKey].slice(0, 3).map((e) => (e.range.start.line + 1) + ':' + (e.range.start.character + 1)) : [],
      newText: curKey && changes[curKey][0] ? changes[curKey][0].newText : null,
    }
  })()`)

  if (r && r.err) {
    no('rename 未返回可用编辑：' + r.err)
  } else {
    console.log('  定位到: 行 ' + (r.found.ln + 1) + ' 列 ' + (r.found.ch + 1))
    console.log('  涉及文件数: ' + r.fileCount + '，当前文件编辑数: ' + r.curFileEdits)
    console.log('  前几处: ' + JSON.stringify(r.sample) + '  新文本: ' + JSON.stringify(r.newText))

    if (r.curFileEdits > 1) ok(`当前文件返回多于一处的编辑（${r.curFileEdits} 处）→ 确认框里的"将改 N 处"有真实依据`)
    else no(`当前文件只返回 ${r.curFileEdits} 处编辑，预期多处`)

    if (r.allSameFile) ok('本次改动只涉及当前文件 → "跨文件暂未开放"的提示与事实一致')
    else console.log('  [NOTE] 涉及多个文件（' + r.fileCount + '），前端会过滤掉非当前文件并提示用户')

    if (r.newText === 'safe_byte_renamed') ok('编辑的 newText 与传入的新名字一致')
    else no('newText 与预期不符: ' + JSON.stringify(r.newText))
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  app.exit(fail ? 1 : 0)
})
