// 可执行入口发现与运行（主进程侧）
//
// 目的（用户要求）：「用 moonbit 跑起来任何项目」+「自动识别可执行入口，让用户选」
//   · 按项目类型扫描可用入口：MoonBit 的 cmd/*、Node 的 package.json scripts、
//     Python 的 main.py/app.py/manage.py、Rust 的 Cargo.toml、Go 的 go.mod
//   · 运行时不写死 moon —— Node 跑 npm、Python 跑 python、Rust 跑 cargo、Go 跑 go
//   · 输出统一以流的方式回传（与 moon:stream 一样的形式），前端复用同一套输出面板
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { resolveSpawn } = require('./spawn-util')
const { createUrlScanner } = require('./url-detect')

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
  // Java / JVM：Maven 或 Gradle（RuoYi 这类 Spring Boot 后台就是）
  if (has(path.join(root, 'pom.xml')) || has(path.join(root, 'build.gradle')) || has(path.join(root, 'build.gradle.kts'))) return 'java'
  // 静态站点：没有上面的标记、但有 index.html —— 也能“跑起来看到样子”
  if (has(path.join(root, 'index.html')) || has(path.join(root, 'index.htm'))) return 'static'
  return 'unknown'
}

// Java 项目常见的前置依赖：扫 application*.yml/properties 判断它需不需要MySQL / Redis
// （RuoYi 的数据库配置就在 application-druid.yml 里，不在 application.yml）
function javaNeeds(root) {
  const files = []
  const walk = (d, depth) => {
    if (depth > 4 || files.length > 40) return
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const e of es) {
      if (e.name === 'target' || e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (/^application.*\.(ya?ml|properties)$/i.test(e.name)) files.push(full)
    }
  }
  walk(root, 0)
  let txt = ''
  for (const f of files) { try { txt += fs.readFileSync(f, 'utf8') } catch (_) {} }
  const out = []
  if (/jdbc:mysql|druid|datasource/i.test(txt)) out.push('MySQL')
  if (/redis/i.test(txt)) out.push('Redis')
  return out
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
  } else if (kind === 'static') {
    // 纯静态站点（只有 index.html）：起一个本地静态服务器，浏览器里就能看到页面
    add('在浏览器里预览', 'python', ['-m', 'http.server', '8080'], root, 'python -m http.server 8080')
    add('在浏览器里预览（8188）', 'python', ['-m', 'http.server', '8188'], root, 'python -m http.server 8188')
  } else if (kind === 'java') {
    // Java / Spring Boot（RuoYi 这类后台）。
    // 注意：这类项目“能不能真的起来”取决于外部环境，所以把缺什么一并写进提示，
    // 否则用户点了只会看到一堆连接失败、不知道卡在哪。
    const gradle = has(path.join(root, 'build.gradle')) || has(path.join(root, 'build.gradle.kts'))
    const mvnw = has(path.join(root, 'mvnw.cmd')) ? 'mvnw.cmd' : (has(path.join(root, 'mvnw')) ? './mvnw' : '')
    const gradlew = has(path.join(root, 'gradlew.bat')) ? 'gradlew.bat' : (has(path.join(root, 'gradlew')) ? './gradlew' : '')
    const bin = gradle ? (gradlew || 'gradle') : (mvnw || 'mvn')
    const warned = []
    if (!mvnw && !gradlew) {
      const probe = gradle ? 'gradle' : 'mvn'
      let ok = false
      try {
        // 走 resolveSpawn（把命令拼成字符串 + shell），别用 shell+args 组合 ——
        // 那会触发 DEP0190（args 不转义的安全告警）。
        const sp = resolveSpawn(probe, ['-v'])
        const r = spawnSync(sp.bin, sp.args, { encoding: 'utf8', shell: sp.shell, timeout: 10000 })
        ok = r.status === 0
      } catch (_) {}
      if (!ok) warned.push('本机没装 ' + probe + '（连 mvnw/gradlew 包装器也没有）')
    }
    const need = javaNeeds(root)
    if (need.length) warned.push('需要先启动 ' + need.join(' + '))
    if (has(path.join(root, 'sql'))) warned.push('数据库要先建表（导入 sql/ 里的脚本）')
    const tail = warned.length ? '   ⚠ ' + warned.join('；') : ''
    if (gradle) {
      add('启动应用', bin, ['bootRun'], root, bin + ' bootRun' + tail)
      add('打包', bin, ['build'], root, bin + ' build' + tail)
    } else {
      add('启动应用', bin, ['spring-boot:run'], root, bin + ' spring-boot:run' + tail)
      add('打包（跳过测试）', bin, ['package', '-DskipTests'], root, bin + ' package -DskipTests' + tail)
    }
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

// 跑一个本地服务：spawn → 收集输出 → 抓 URL → 打开浏览器
//
// 抽成独立函数（不依赖 Electron）的理由：「Run → URL → Browser」这条链路是 IDE 的核心验收点，
// 但原实现内联在 `ipcMain.handle('runner:run')` 里 —— 离开 Electron 就没法测，
// 而本机 MoonBit native 工具链当前是坏的（moon build 全目标 exit 127），跑不了真服务。
// 抽出来之后，这条链路可以用**纯 Node** 在 Linux CI 上 E2E 验证（见 test-run-e2e.js）。
//
// 行为与原内联实现保持一致：同一时刻只跑一个进程；URL 命中一次后不再重复触发。
function createServiceRunner({ openUrl } = {}) {
  let current = null
  let scanner = null

  function stop() {
    if (!current) return { ok: false, error: '当前没有正在运行的进程' }
    try { current.kill() } catch (_) {}
    current = null
    return { ok: true }
  }

  function start({ bin, args, cwd, label } = {}, handlers = {}) {
    const H = handlers || {}
    if (current) { try { current.kill() } catch (_) {} current = null }
    scanner = createUrlScanner()   // 跨 chunk 累积 + 命中一次，见 url-detect.js
    if (H.onStart) H.onStart({ label: label || bin })

    const onChunk = (chunk) => {
      if (H.onData) H.onData(chunk)
      const hit = scanner.push(chunk)
      if (!hit) return
      if (H.onUrl) H.onUrl(hit.url)
      // 浏览器打不开**不该**把服务标成失败 —— 服务是好的，只是没能自动开页面。
      // 所以在这里捕获并**单独上报**（browser launch status ≠ server status，P1-21）。
      let browserError = null
      if (typeof openUrl === 'function') {
        try { openUrl(hit.url) } catch (e) { browserError = String((e && e.message) || e) }
      }
      if (H.onBrowserOpen) H.onBrowserOpen({ url: hit.url, ok: !browserError, error: browserError })
    }

    current = spawnRunner({ bin, args, cwd }, onChunk, (r) => {
      if (H.onEnd) H.onEnd(r)
      current = null
    })
    return { ok: !!current, pid: current ? current.pid : null }
  }

  return {
    start,
    stop,
    get running() { return !!current },
  }
}

function registerRunnerIpc({ ipcMain, getWindow }) {
  const send = (ch, payload) => {
    const w = getWindow && getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload)
  }
  // 服务启停 / 输出 / URL 检测都在 createServiceRunner 里（可脱离 Electron 测试）；
  // 只有「用系统浏览器打开」这一步交给 Electron。
  const runner = createServiceRunner({
    openUrl: (url) => require('electron').shell.openExternal(url),
  })

  ipcMain.handle('runner:list', (_e, root) => {
    try { return { ok: true, ...findRunners(root || process.cwd()) } } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('runner:run', (_e, spec) =>
    runner.start(spec, {
      onStart: (p) => send('runner:start', p),
      onData: (d) => send('runner:data', { data: d }),
      onUrl: (url) => send('runner:url', { url }),
      // 浏览器打开结果单独成一路事件（renderer 暂未消费，留给 P1-21 的界面提示）
      onBrowserOpen: (r) => send('runner:browser', r),
      onEnd: (r) => send('runner:end', r),
    }))

  ipcMain.handle('runner:stop', () => runner.stop())
}

module.exports = { registerRunnerIpc, createServiceRunner, findRunners, kindOf }
