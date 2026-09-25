// 端到端实测：IDE 里点「运行」→ 真的跑起来 → 输出回到界面。
// 这是用户报告的核心问题（「根本运行不出来任何项目」）的验收。
require('./main.js')
const { app, BrowserWindow } = require('electron')

const ROOT = process.argv[2] || ''
if (!ROOT) { console.error('用法: electron verify-run-e2e.js <项目目录>'); process.exit(1) }

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 3000))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.error('没拿到窗口'); app.exit(1); return }

  const r = await win.webContents.executeJavaScript(`(async () => {
    const root = ${JSON.stringify(ROOT)}
    // ① 入口识别
    const list = await window.moonAPI.runnerList(root)
    if (!list || !list.ok) return { err: '入口识别失败: ' + (list && list.error) }
    // ② 挑一个会输出后能停掉的入口（notes 服务启动会打日志）
    const spec = list.runners.find((x) => x.label.indexOf('notes') >= 0) || list.runners[0]
    // ③ 收集流式输出
    const chunks = []
    const off = window.moonAPI.onRunnerData((p) => chunks.push(typeof p === 'string' ? p : (p && p.data) || ''))
    window.moonAPI.onRunnerEnd((p) => chunks.push('\\n[进程结束 code=' + (p && p.code) + ']'))
    await window.moonAPI.runnerRun(spec)
    await new Promise((res) => setTimeout(res, 70000))
    await window.moonAPI.runnerStop()
    await new Promise((res) => setTimeout(res, 800))
    return {
      kind: list.kind,
      runners: list.runners.length,
      picked: spec.label,
      outLen: chunks.join('').length,
      out: chunks.join('').slice(0, 500),
    }
  })()`)

  console.log('\n  === 结果 ===')
  if (r && r.err) { console.log('  ❌ ' + r.err) }
  else {
    console.log('  项目类型: ' + r.kind + '   识别入口: ' + r.runners + ' 个')
    console.log('  运行目标: ' + r.picked)
    console.log('  输出长度: ' + r.outLen + ' 字符')
    console.log('  ── 输出前 500 字 ──')
    console.log((r.out || '(无输出)').split('\n').map((l) => '    ' + l).join('\n'))
    console.log('\n  ' + (r.outLen > 0 ? '✅ 运行有输出 —— IDE 里能看到项目结果' : '❌ 无输出 —— 问题仍存在'))
  }
  app.exit(0)
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
