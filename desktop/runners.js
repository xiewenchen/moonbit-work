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
const { resolveSpawn } = require('./spawn-util')

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

// 从包路径取一个**能看懂的名字**：
//   ./hello/cmd/main  → hello        （cmd 上一级）
//   ./demo            → demo
//   ./cmd/main        → （项目根）
//   .                 → （项目根）
function niceName(p) {
  const parts = String(p).replace(/^\.\//, '').split('/').filter((x) => x && x !== '.')
  if (!parts.length) return '项目根'
  const i = parts.indexOf('cmd')
  if (i > 0) return parts[i - 1]
  if (i === 0) return '项目根'
  return parts[parts.length - 1]
}

// 常见 npm 脚本名 → 中文（用户看不懂 dev/start/serve 这些词）
const SCRIPT_CN = {
  start: '启动服务', dev: '开发模式启动', develop: '开发模式启动', serve: '启动服务', server: '启动服务',
  build: '构建', test: '跑测试', lint: '代码检查', format: '格式化', fmt: '格式化',
  preview: '预览', watch: '监听模式（改文件自动重建）', clean: '清理产物', deploy: '部署',
  electron: '启动桌面应用', dist: '打包安装包', pack: '打包', typecheck: '类型检查', e2e: '端到端测试',
}

// 「能真正把项目跑起来」的脚本名 —— 标「推荐」，免得用户去点那些空脚本
// （Strapi 项目里就有个叫 `strapi` 的脚本，内容只是裸 `strapi`，点了只打印帮助）
const PRIMARY_SCRIPTS = new Set(['start', 'dev', 'develop', 'serve', 'server'])

// 给脚本名配中文标题：完整名优先；否则按「前缀:后缀」翻译（test:backend → 跑测试 · backend）；
// 都不认识就退回原名（不硬翻，免得译错）。
function scriptLabel(n) {
  if (SCRIPT_CN[n]) {
    return SCRIPT_CN[n] + (PRIMARY_SCRIPTS.has(n) ? '（推荐）' : '')
  }
  const i = String(n).indexOf(':')
  if (i > 0) {
    const head = n.slice(0, i)
    const tail = n.slice(i + 1)
    if (SCRIPT_CN[head]) return SCRIPT_CN[head] + ' · ' + tail
  }
  return '运行 ' + n
}

// 这个包是否依赖外部服务（PG / Redis）？
// 依赖的话，点了运行会**静默干等**（连不上就一直不监听），所以要先告诉用户。
function needsBackends(pkgDir) {
  try {
    for (const f of fs.readdirSync(pkgDir)) {
      if (!f.endsWith('.mbt')) continue
      const s = fs.readFileSync(path.join(pkgDir, f), 'utf8')
      if (/pg\/client|redis\/client|pg_port|redis_port|ensure_schema|with_db/.test(s)) return true
    }
  } catch (_) {}
  return false
}

// 扫出「能跑的入口」列表。每项：{ label, hint, kind, bin, args, cwd }
// label = 人话（给用户看），hint = 实际命令（给懂的人核对）
function findRunners(root) {
  root = path.resolve(root)
  const kind = kindOf(root)
  const out = []
  const add = (label, bin, args, cwd, hint) => out.push({ label, hint: hint || ([bin].concat(args || [])).join(' '), kind, bin, args, cwd: cwd || root })

  if (kind === 'moonbit') {
    // MoonBit：可执行入口通常是含 main 的包（约定在 cmd/* 或包名目录）
    const isPkg = (d) => has(path.join(d, 'moon.pkg')) || has(path.join(d, 'moon.pkg.json'))
    // 必须显式带 --target native：模块级 preferred_target 可能是 wasm（本项目就是），
    // 而可执行入口几乎都是 native-only 包 —— 不带 target 时 moon 会用 wasm 构建，
    // 报 “does not support target backend 'wasm'”，表现就是「任何入口都跑不起来」。
    // 依赖 PG/Redis 的入口在 hint 里标一下 —— 否则用户点下去只会看到一片沉默
    const RUN = (p, cmd) => {
      const dir = path.resolve(root, p)
      const warn = needsBackends(dir) ? '   ⚠ 依赖 PostgreSQL + Redis，需先启动' : ''
      add('运行 ' + niceName(p), 'moon', ['run', p, '--target', 'native'], root, cmd + warn)
    }
    // ① 根目录的 cmd/*
    const cmdDir = path.join(root, 'cmd')
    for (const sub of listDirs(cmdDir)) {
      if (isPkg(path.join(cmdDir, sub))) RUN('./cmd/' + sub, 'moon run --target native ./cmd/' + sub)
    }
    // ② 子项目里的 cmd/*（多包布局，如 notes/cmd/main、conduit/cmd/main —— 只扫根目录会漏掉这些）
    for (const d of listDirs(root)) {
      if (d.startsWith('.') || d === '_build' || d === 'node_modules') continue
      const cd = path.join(root, d, 'cmd')
      for (const sub of listDirs(cd)) {
        if (isPkg(path.join(cd, sub))) RUN('./' + d + '/cmd/' + sub, 'moon run --target native ./' + d + '/cmd/' + sub)
      }
    }
    // ③ 顶层/子目录里直接放 main.mbt 的
    for (const d of listDirs(root)) {
      if (d.startsWith('.') || d === '_build' || d === 'node_modules') continue
      if (has(path.join(root, d, 'main.mbt'))) RUN('./' + d, 'moon run --target native ./' + d)
    }
    if (has(path.join(root, 'main.mbt'))) RUN('.', 'moon run --target native .')
  } else if (kind === 'node') {
    let pkg = {}
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) } catch (_) {}
    const scripts = (pkg && pkg.scripts) || {}
    // start / dev / serve 这类优先排在前面
    const pref = ['start', 'dev', 'serve', 'develop']
    const names = Object.keys(scripts).sort((a, b) => (pref.indexOf(a) >= 0 ? -1 : 0) - (pref.indexOf(b) >= 0 ? -1 : 0))
    for (const n of names) {
      // 中文释义当标题（看不懂 dev 是什么的人也能选对）；不认识的脚本名保留原名
      add(scriptLabel(n), 'npm', ['run', n], root, 'npm run ' + n)
    }
  } else if (kind === 'python') {
    for (const f of ['main.py', 'app.py', 'manage.py', 'run.py', '__main__.py']) {
      if (isFile(path.join(root, f))) add('运行 ' + f, 'python', [f], root, 'python ' + f)
    }
  } else if (kind === 'rust') {
    add('运行（调试版）', 'cargo', ['run'], root, 'cargo run')
    add('运行（发行版，更快）', 'cargo', ['run', '--release'], root, 'cargo run --release')
  } else if (kind === 'go') {
    add('运行', 'go', ['run', '.'], root, 'go run .')
    add('构建并运行', 'go', ['build', '.'], root, 'go build .')
  }
  return { kind, runners: out }
}

// 运行指定入口：onData(chunk) 流式回传，onEnd(result) 结束时回调。
// 用回调而不是 Promise —— 进程是「先启动、很久后结束」，用 Promise 容易写成 resolve 两次。
function spawnRunner({ bin, args, cwd }, onData, onEnd) {
  let child
  try {
    // .cmd/.bat（npm 在 Windows 上就是 npm.cmd）不能直接 spawn —— 会抛 EINVAL。
    // 这是「IDE 里跑 npm 项目失败」的真正原因，交给 resolveSpawn 走 cmd.exe。
    const sp = resolveSpawn(bin, args)
    // stdin 置 ignore：spawn 默认给子进程一个 stdin 管道，
    // 服务类/CLI 类程序会等它 → 非交互场景下可能一直不退出。
    child = spawn(sp.bin, sp.args, { cwd: cwd || process.cwd(), shell: sp.shell, stdio: ['ignore', 'pipe', 'pipe'] })
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
    // 从运行输出里抓本地 URL 并自动用系统浏览器打开 ——
    // 服务类项目（Strapi / 各类 web 框架）启动后会打印「访问 http://localhost:PORT」，
    // 抓住它，用户点一次「运行」就能看到网站，而不是自己从日志里找地址。
    // 注意 URL 可能被切成两个 chunk，所以累积一小段再匹配。
    let buf = ''
    let opened = false
    const onChunk = (chunk) => {
      send('runner:data', { data: chunk })
      if (opened) return
      // 先剥离 ANSI 色码：Strapi 这类程序的输出带颜色转义，URL 后面常紧跟 \u001b[39m，
      // 不剥离就会把色码当成 URL 的一部分，打开必然失败（这是实测踩到的）。
      const clean = chunk.replace(/\u001b\[[0-9;]*m/g, '')
      buf = (buf + clean).slice(-2048)
      const m = buf.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s'"<>)]*/i)
      if (!m) return
      opened = true
      const url = m[0].replace(/[.,;:]+$/, '')
      send('runner:url', { url })
      try { require('electron').shell.openExternal(url) } catch (_) {}
    }
    current = spawnRunner(
      { bin, args, cwd },
      onChunk,
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
