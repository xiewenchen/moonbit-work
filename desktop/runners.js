// 可执行入口发现与运行（主进程侧）
//
// 目的（用户要求）：「用 moonbit 跑起来任何项目」+「自动识别可执行入口，让用户选」
//   · 按项目类型扫描可用入口：MoonBit 的 cmd/*、Node 的 package.json scripts、
//     Python 的 main.py/app.py/manage.py、Rust 的 Cargo.toml、Go 的 go.mod
//   · 运行时不写死 moon —— Node 跑 npm、Python 跑 python、Rust 跑 cargo、Go 跑 go
//   · 输出统一以流的方式回传（与 moon:stream 一样的形式），前端复用同一套输出面板
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const has = (p) => { try { return fs.existsSync(p) } catch (_) { return false } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch (_) { return false } }
const listDirs = (p) => {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch (_) { return [] }
}

// 项目类型（与 project-detect.js 的口径一致，这里只需判定，不需要完整描述）
function kindOf(root) {
  if (has(path.join(root, 'moon.mod'))) return 'moonbit'
  if (has(path.join(root, 'package.json'))) return 'node'
  if (has(path.join(root, 'Cargo.toml'))) return 'rust'
  if (has(path.join(root, 'go.mod'))) return 'go'
  for (const f of ['main.py', 'app.py', 'manage.py', 'pyproject.toml', 'requirements.txt']) {
    if (has(path.join(root, f))) return 'python'
  }
  return 'unknown'
}

// 扫出「能跑的入口」列表。每项：{ label, kind, bin, args, cwd }
function findRunners(root) {
  root = path.resolve(root)
  const kind = kindOf(root)
  const out = []
  const add = (label, bin, args, cwd) => out.push({ label, kind, bin, args, cwd: cwd || root })

  if (kind === 'moonbit') {
    // MoonBit：可执行入口通常是含 main 的包（约定在 cmd/* 或包名目录）
    const isPkg = (d) => has(path.join(d, 'moon.pkg')) || has(path.join(d, 'moon.pkg.json'))
    // ① 根目录的 cmd/*
    const cmdDir = path.join(root, 'cmd')
    for (const sub of listDirs(cmdDir)) {
      if (isPkg(path.join(cmdDir, sub))) add('moon run ./cmd/' + sub, 'moon', ['run', './cmd/' + sub])
    }
    // ② 子项目里的 cmd/*（多包布局，如 notes/cmd/main、conduit/cmd/main —— 只扫根目录会漏掉这些）
    for (const d of listDirs(root)) {
      if (d.startsWith('.') || d === '_build' || d === 'node_modules') continue
      const cd = path.join(root, d, 'cmd')
      for (const sub of listDirs(cd)) {
        if (isPkg(path.join(cd, sub))) add('moon run ./' + d + '/cmd/' + sub, 'moon', ['run', './' + d + '/cmd/' + sub])
      }
    }
    // ③ 顶层/子目录里直接放 main.mbt 的
    for (const d of listDirs(root)) {
      if (d.startsWith('.') || d === '_build' || d === 'node_modules') continue
      if (has(path.join(root, d, 'main.mbt'))) add('moon run ./' + d, 'moon', ['run', './' + d])
    }
    if (has(path.join(root, 'main.mbt'))) add('moon run .', 'moon', ['run', '.'])
  } else if (kind === 'node') {
    let pkg = {}
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) } catch (_) {}
    const scripts = (pkg && pkg.scripts) || {}
    // start / dev / serve 这类优先排在前面
    const pref = ['start', 'dev', 'serve', 'develop']
    const names = Object.keys(scripts).sort((a, b) => (pref.indexOf(a) >= 0 ? -1 : 0) - (pref.indexOf(b) >= 0 ? -1 : 0))
    for (const n of names) add('npm run ' + n, 'npm', ['run', n])
  } else if (kind === 'python') {
    for (const f of ['main.py', 'app.py', 'manage.py', 'run.py', '__main__.py']) {
      if (isFile(path.join(root, f))) add('python ' + f, 'python', [f])
    }
  } else if (kind === 'rust') {
    add('cargo run', 'cargo', ['run'])
    add('cargo run --release', 'cargo', ['run', '--release'])
  } else if (kind === 'go') {
    add('go run .', 'go', ['run', '.'])
    add('go build && 运行', 'go', ['build', '.'])
  }
  return { kind, runners: out }
}

// 运行指定入口：onData(chunk) 流式回传，onEnd(result) 结束时回调。
// 用回调而不是 Promise —— 进程是「先启动、很久后结束」，用 Promise 容易写成 resolve 两次。
function spawnRunner({ bin, args, cwd }, onData, onEnd) {
  let child
  try {
    child = spawn(bin, args || [], { cwd: cwd || process.cwd(), shell: false })
  } catch (e) {
    onEnd({ ok: false, error: '启动失败：' + e.message })
    return null
  }
  child.stdout.on('data', (d) => onData(d.toString('utf8')))
  child.stderr.on('data', (d) => onData(d.toString('utf8')))
  child.on('error', (e) => onEnd({ ok: false, error: '无法执行 ' + bin + '：' + e.message }))
  child.on('close', (code) => onEnd({ ok: true, code }))
  return child
}

function registerRunnerIpc({ ipcMain, getWindow }) {
  const send = (ch, payload) => {
    const w = getWindow && getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload)
  }
  let current = null   // 当前运行的子进程（同一时刻只跑一个，避免输出串台）

  ipcMain.handle('runner:list', (_e, root) => {
    try { return { ok: true, ...findRunners(root || process.cwd()) } } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('runner:run', (_e, { bin, args, cwd, label }) => {
    if (current) { try { current.kill() } catch (_) {} current = null }
    send('runner:start', { label: label || bin })
    current = spawnRunner(
      { bin, args, cwd },
      (chunk) => send('runner:data', { data: chunk }),
      (r) => { send('runner:end', r); current = null },
    )
    return { ok: !!current, pid: current ? current.pid : null }
  })

  ipcMain.handle('runner:stop', () => {
    if (!current) return { ok: false, error: '当前没有正在运行的进程' }
    try { current.kill(); current = null; return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  })
}

module.exports = { registerRunnerIpc, findRunners, kindOf }
