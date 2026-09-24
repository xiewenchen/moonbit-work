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
const { resolveSpawn, killTree } = require('./spawn-util')
const { createUrlScanner } = require('./url-detect')
const { rootOfInput } = require('./project-context')   // P2-08 起取根统一到这里（本文件只做 re-export）
const {
  RUN_STATE,
  createRunStateMachine,
  createProcessHandle,
  createStreamEvent,
  createRunResult,
} = require('./run-state')

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
  child.stdout.on('data', (d) => onData(d.toString('utf8'), 'stdout'))
  child.stderr.on('data', (d) => onData(d.toString('utf8'), 'stderr'))
  child.on('error', (e) => onEnd({ ok: false, error: '无法执行 ' + bin + '：' + e.message }))
  child.on('close', (code, signal) => onEnd({ ok: true, code, signal }))
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
/**
 * 启动阶段默认超时（ms）—— **inactivity 语义**：从「最后一次输出」算起。
 * 这样「编译很久但一直在吐日志」的项目不会被误杀（hello 首次 native 编译就是这种），
 * 而「进程起来了但一直不监听、也不输出」的情况仍能被检出（P1-25）。
 */
const DEFAULT_START_TIMEOUT = 60000

/**
 * 停止宽限期（ms）：stop() 发出后若进程仍未退出，就强杀（SIGKILL）。
 * 没有这个兑底，不理会 SIGTERM（或被 keep-alive 连接拖住）的服务会**留下僵尸**。
 */
const DEFAULT_STOP_GRACE_MS = 3000

function createServiceRunner({ openUrl, startTimeout = DEFAULT_START_TIMEOUT, stopGraceMs = DEFAULT_STOP_GRACE_MS } = {}) {
  let current = null          // 底层 child 进程
  let handle = null           // ProcessHandle（P1-16）
  let scanner = null          // URL 扫描器（见 url-detect.js）
  let runSeq = 0              // 第几次运行 —— 用来丢弃上一轮的迟到事件
  let finished = false        // error 与 close 可能都触发，保证只上报一次
  let lastUrl = null
  let stdoutText = ''
  let stderrText = ''
  let startedAt = null
  let lastResult = null
  let activeHandlers = null    // 本轮回调集合 —— 供状态变化主动上报（P1-19）
  let startTimer = null        // P1-25：STARTING 阶段的超时定时器
  let startError = null        // 启动阶段的失败原因（超时等）
  const machine = createRunStateMachine()   // P1-14 / P1-15

  const MAX_CAPTURE = 64 * 1024   // stdout / stderr 各留 64 KiB 给 RunResult，避免无界增长
  const ACTIVE_STATES = [RUN_STATE.BUILDING, RUN_STATE.STARTING, RUN_STATE.RUNNING]

  const capture = (stream, text) => {
    if (stream === 'stderr') stderrText = (stderrText + text).slice(-MAX_CAPTURE)
    else stdoutText = (stdoutText + text).slice(-MAX_CAPTURE)
  }
  const emitState = () => { const H = activeHandlers; if (H && H.onState) H.onState(machine.state) }

  function clearStartTimer() {
    if (startTimer) { clearTimeout(startTimer); startTimer = null }
  }

  /**
   * P1-25：STARTING 阶段**静默**超过 startTimeout → FAILED，并主动清掉进程（不留孤儿）。
   * 每次收到输出都会重新计时（inactivity）。
   */
  function armStartTimer() {
    clearStartTimer()
    if (!(startTimeout > 0)) return
    startTimer = setTimeout(() => {
      startTimer = null
      if (machine.state !== RUN_STATE.STARTING) return
      startError = `启动超时（连续 ${startTimeout}ms 无输出且未检测到服务监听）`
      machine.to(RUN_STATE.FAILED)
      emitState()
      if (current) { try { current.kill() } catch (_) {} }
    }, startTimeout)
  }

  function stop() {
    if (!current || !handle) return { ok: false, error: '当前没有正在运行的进程' }
    clearStartTimer()            // 用户主动停：不再需要启动超时
    const r = handle.stop()
    if (machine.state === RUN_STATE.RUNNING || machine.state === RUN_STATE.STARTING) {
      machine.to(RUN_STATE.STOPPING)
      emitState()
    }
    // 兑底强杀：宽限期内没退出就直接 SIGKILL（否则不理会 SIGTERM 的服务会留下僵尸）
    if (stopGraceMs > 0 && current) {
      const target = current
      const t = setTimeout(() => {
        if (current === target) killTree(target, 'SIGKILL')
      }, stopGraceMs)
      if (typeof t.unref === 'function') t.unref()
    }
    return r
  }

  /** 子进程结束（error / close）—— 只处理属于「本轮」的那一次 */
  function finish(r, H, myRun) {
    if (myRun !== runSeq) return   // 上一轮进程的迟到事件，丢弃（别污染新一轮的状态）
    if (finished) return
    finished = true
    clearStartTimer()

    const exitCode = r && typeof r.code === 'number' ? r.code : null
    if (handle) handle.recordExit(exitCode, r && r.signal ? r.signal : null)

    const s = machine.state
    if (s === RUN_STATE.STOPPING) {
      machine.to(RUN_STATE.STOPPED)                 // 用户主动停的
    } else if (s === RUN_STATE.STARTING || s === RUN_STATE.RUNNING) {
      const clean = exitCode === 0 && !(r && r.ok === false)
      machine.to(clean ? RUN_STATE.STOPPED : RUN_STATE.FAILED)
    } else if (s === RUN_STATE.BUILDING) {
      machine.to(RUN_STATE.FAILED)                  // BUILDING 只能去 STARTING / FAILED
    }

    const srvError = startError || (r && r.ok === false && r.error ? String(r.error) : null)
    lastResult = createRunResult({
      status: machine.state,
      exitCode,
      url: lastUrl,
      stdout: stdoutText,
      stderr: stderrText,
      startedAt,
      endedAt: Date.now(),
      error: srvError,
    })
    current = null
    if (H && H.onEnd) {
      // 保留原有 code/error 字段（renderer 在用），另附 RunResult 全量字段
      H.onEnd(Object.assign({}, r, lastResult, { code: exitCode, state: machine.state }))
    }
    emitState()
  }

  function start({ bin, args, cwd, label } = {}, handlers = {}) {
    const H = handlers || {}
    activeHandlers = H
    if (current) { try { current.kill() } catch (_) {} current = null }
    handle = null
    finished = false
    startError = null
    clearStartTimer()
    lastUrl = null
    stdoutText = ''
    stderrText = ''
    scanner = createUrlScanner()          // 跨 chunk 累积 + 命中一次
    machine.reset()                       // 允许从 STOPPED / FAILED 重新进入 Run 流程
    machine.to(RUN_STATE.BUILDING)
    startedAt = Date.now()
    emitState()
    if (H.onStart) H.onStart({ label: label || bin, state: machine.state })

    const onChunk = (chunk, stream) => {
      const text = String(chunk == null ? '' : chunk)
      const ev = createStreamEvent(stream, text)          // P1-17：stdout / stderr 统一事件
      if (H.onData) H.onData(text)                        // 兼容旧签名
      if (H.onStreamEvent && ev.ok) H.onStreamEvent(ev.event)
      capture(stream, text)
      if (machine.state === RUN_STATE.STARTING) armStartTimer()   // 有输出 = 进程还活着，重新计时

      const hit = scanner.push(text)
      if (!hit) return
      lastUrl = hit.url
      // 清单要求的顺序：spawn → collect output → detect URL → **update state** → open browser
      if (machine.state === RUN_STATE.STARTING) {
        machine.to(RUN_STATE.RUNNING)
        clearStartTimer()                // 已经监听上了，撤销启动超时
        emitState()
      }
      if (H.onUrl) H.onUrl(hit.url)
      // 浏览器打不开**不该**把服务标成失败 —— 服务是好的，只是没能自动开页面。
      // 所以在这里捕获并**单独上报**（browser launch status ≠ server status，P1-21）。
      let browserError = null
      if (typeof openUrl === 'function') {
        try { openUrl(hit.url) } catch (e) { browserError = String((e && e.message) || e) }
      }
      if (H.onBrowserOpen) H.onBrowserOpen({ url: hit.url, ok: !browserError, error: browserError })
    }

    handle = createProcessHandle({
      pid: null,
      command: [bin].concat(args || []).join(' '),
      cwd: cwd || process.cwd(),
      kill: () => { if (current) killTree(current, 'SIGTERM') },
    })
    const myRun = ++runSeq
    current = spawnRunner({ bin, args, cwd }, onChunk, (r) => finish(r, H, myRun))
    if (!current) {
      machine.to(RUN_STATE.FAILED)
      emitState()
      return { ok: false, error: '启动失败', pid: null }
    }
    handle.pid = current.pid
    machine.to(RUN_STATE.STARTING)
    emitState()
    armStartTimer()                      // P1-25：等它监听，超时即 FAILED
    return { ok: true, pid: current.pid }
  }

  return {
    start,
    stop,
    get running() { return ACTIVE_STATES.includes(machine.state) },
    get state() { return machine.state },
    get result() { return lastResult },
    get handle() { return handle },
  }
}

/**
 * 运行事件 → IPC 事件的统一映射。
 * 提取出来是因为命令表（P3 的 project.run）与 runner:run IPC 必须用**同一套** handlers ——
 * 否则走命令启动的进程不会把输出/URL 推给界面（输出流会直接断掉）。
 */
function makeRunnerHandlers(send) {
  return {
    onStart: (p) => send('runner:start', p),
    onData: (d) => send('runner:data', { data: d }),
    onUrl: (url) => send('runner:url', { url }),
    // 浏览器打开结果单独成一路事件（renderer 暂未消费，留给 P1-21 的界面提示）
    onBrowserOpen: (r) => send('runner:browser', r),
    onEnd: (r) => send('runner:end', r),
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

  ipcMain.handle('runner:list', (_e, input) => {
    // 接受字符串（旧调用）或 ProjectContext（新，P2-08：Runner 不再自己找根）；都没有才兜底到 cwd
    try { return { ok: true, ...findRunners(rootOfInput(input) || process.cwd()) } } catch (e) { return { ok: false, error: e.message } }
  })

  const handlers = makeRunnerHandlers(send)
  ipcMain.handle('runner:run', (_e, spec) => runner.start(spec, handlers))

  ipcMain.handle('runner:stop', () => runner.stop())

  // 把实例交出去（P3）：命令表必须复用**同一个** runner ——
  // 同一时刻只能有一个运行实例，若命令表另建一个，「停止」就会停错进程。
  return runner
}

module.exports = { registerRunnerIpc, createServiceRunner, makeRunnerHandlers, DEFAULT_START_TIMEOUT, DEFAULT_STOP_GRACE_MS, rootOfInput, findRunners, kindOf }
