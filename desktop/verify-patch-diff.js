// PH3-IDE-06/07 端到端：Patch 显示在 Monaco diff + 跳到修改位置。
//
// ⚠️ 会写一个临时文件到项目根（用于"跳转"验证），结束时删掉。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(__dirname, 'patch-diff-result.txt')
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
  await sleep(3000)

  const probe = path.join(ROOT, 'patch-diff-probe.txt')
  fs.writeFileSync(probe, '第一行\n第二行\n第三行\n', 'utf8')
  await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
  await sleep(1500)

  log('\n=== ① PH3-IDE-06：Patch 渲染成 Monaco diff（不是一段文本）===')
  {
    const r = JSON.parse(await js(`(() => {
      try {
        return JSON.stringify(window.moonbitIDE.editor.showPatchDiff({
          file: ${JSON.stringify(probe)},
          old: '第一行\\n第二行\\n第三行\\n',
          new: '第一行\\n第二行（改过）\\n第三行\\n第四行（新增）\\n',
          summary: '改第二行并加一行',
        }))
      } catch (e) { return JSON.stringify({ ok: false, error: 'throw: ' + String((e && e.message) || e) }) }
    })()`))
    chk('showPatchDiff 报成功', r.ok === true, JSON.stringify(r).slice(0, 140))
    await sleep(1200)
    chk('★ 出现 diff 遮罩', await js(`!!document.getElementById('patchDiffMask')`), true)
    chk('★ 出现 diff 容器', await js(`!!document.getElementById('patchDiffHost')`), true)

    // Monaco 真的把它渲染成了 diff 编辑器（不是普通编辑器）
    const isDiff = await js(`(() => {
      const h = document.getElementById('patchDiffHost')
      if (!h) return 'no-host'
      if (h.querySelector('.monaco-diff-editor')) return 'diff'
      if (h.querySelector('.monaco-editor')) return 'plain-editor'
      return 'empty:' + h.innerHTML.length
    })()`)
    eq('★ 真的是 Monaco **diff** 编辑器（.monaco-diff-editor）', isDiff, 'diff')

    // 只读：diff 编辑器的 original/modified 都不许编辑
    const ro = await js(`(() => {
      const h = document.getElementById('patchDiffHost')
      return h ? !!h.querySelector('.monaco-diff-editor') : false
    })()`)
    chk('  容器里确实是 diff 结构', ro === true)
  }

  log('\n=== ② PH3-IDE-07：点「跳到修改位置」→ 打开真实文件 ===')
  {
    const before = await js(`document.getElementById('stFile').textContent`)
    const clicked = await js(`(() => { const b = document.getElementById('patchDiffJump'); if (!b) return 'no-button'; b.click(); return 'clicked' })()`)
    eq('找到并点了「跳到修改位置」', clicked, 'clicked')
    await sleep(1500)
    const after = await js(`document.getElementById('stFile').textContent`)
    chk('★ 状态栏显示的文件变了（说明真的打开了）', before !== after, before + ' → ' + after)
    chk('  打开的正是补丁里的那个文件', String(after).indexOf('patch-diff-probe.txt') >= 0, String(after))
    eq('★ 跳转后 diff 面板自动关掉', await js(`!!document.getElementById('patchDiffMask')`), false)
  }

  log('\n=== ③ 边界：缺信息时如实拒绝（不假装显示了）===')
  {
    const noFile = JSON.parse(await js(`JSON.stringify(window.moonbitIDE.editor.showPatchDiff({ old: 'a', new: 'b' }))`))
    eq('没 file → 拒绝', noFile.ok, false)
    chk('  说明原因', /file/.test(String(noFile.error)), String(noFile.error))
    eq('  且没有留下遮罩', await js(`!!document.getElementById('patchDiffMask')`), false)

    const noText = JSON.parse(await js(`JSON.stringify(window.moonbitIDE.editor.showPatchDiff({ file: 'x.txt' }))`))
    eq('没有 old/new → 拒绝', noText.ok, false)
    chk('  说明原因', /old\/new/.test(String(noText.error)), String(noText.error))

    const empty = JSON.parse(await js(`JSON.stringify(window.moonbitIDE.editor.showPatchDiff(null))`))
    eq('null 不炸', empty.ok, false)
  }

  log('\n=== ④ 关闭按钮也能收掉面板 ===')
  {
    await js(`window.moonbitIDE.editor.showPatchDiff({ file: 'a.txt', old: 'a', new: 'b' })`)
    await sleep(900)
    chk('面板又出现了', await js(`!!document.getElementById('patchDiffMask')`), true)
    await js(`(() => { const b = Array.from(document.querySelectorAll('#patchDiffMask button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
    await sleep(400)
    eq('★ 点关闭后面板消失', await js(`!!document.getElementById('patchDiffMask')`), false)
  }

  try { fs.unlinkSync(probe) } catch (e) { log('  （探针文件删除失败，忽略：' + e.message + '）') }
  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
