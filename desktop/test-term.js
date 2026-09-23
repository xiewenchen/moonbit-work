// 集成终端自检：在 Electron 主进程里用 node-pty 起一个真 PTY，执行命令并检查输出。
// 运行： npx electron test-term.js
const { app } = require('electron')

let pty = null
try {
  pty = require('node-pty')
} catch (e) {
  console.log('[test] node-pty 加载失败:', e.message)
}

app.whenReady().then(() => {
  if (!pty) {
    console.log('[test] ❌ node-pty 不可用（终端将回退到 child_process）')
    app.exit(1)
    return
  }
  const shell = process.env.COMSPEC || 'cmd.exe'
  const p = pty.spawn(shell, ['/c', 'echo PTY_OK & echo line2'], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
  })
  let out = ''
  let sawResize = false
  p.onData((d) => {
    out += d
  })
  try {
    p.resize(120, 40)
    sawResize = true
  } catch (_) {
    /* ignore */
  }
  p.onExit(({ exitCode }) => {
    console.log('[test] exit code =', exitCode)
    console.log('[test] 输出 =', JSON.stringify(out))
    console.log('[test] resize 可用 =', sawResize)
    const ok = out.includes('PTY_OK') && out.includes('line2') && exitCode === 0
    console.log(ok ? '[test] ✅ 真 PTY 工作正常' : '[test] ❌ PTY 输出异常')
    app.exit(ok ? 0 : 1)
  })
})
