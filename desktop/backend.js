// 后端服务控制器 —— 让用户能在 IDE 里「亲手启动」这个后端。
//
// 职责：
//   • 检查依赖（PostgreSQL / Redis 容器）
//   • 定位或编译后端二进制
//   • 启动 / 停止服务进程，并把 stdout/stderr 实时推给渲染层
//   • 轮询 /health 给出「启动中 → 运行中」的真实状态
//
// 设计取舍：
//   • 用一个**独立端口**（默认 8110），避免与命令行起的集群（8101-8103）冲突
//   • 编译走 `moon build`（需要 moon 在 PATH）；已有二进制则直接复用
//   • 不在这里拉起容器：容器是外部依赖，缺了就明确告诉用户怎么起

const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { rootOfInput } = require('./project-context')

const DEFAULT_PORT = 8110
const PG_PORT = 55432
const PG_DB = 'conduitdb'

// 二进制候选路径（release 优先 —— 启动更快、日志更少）
const BIN_CANDIDATES = [
  '_build/native/release/build/conduit/cmd/main/main.exe',
  '_build/native/release/build/conduit/cmd/main/main',
  '_build/native/debug/build/conduit/cmd/main/main.exe',
  '_build/native/debug/build/conduit/cmd/main/main',
]

let proc = null
let starting = false
let lastLogs = []

function log(sink, line) {
  const text = String(line).replace(/\r?\n$/, '')
  if (!text) return
  lastLogs.push(text)
  if (lastLogs.length > 500) lastLogs.shift()
  if (sink) sink(text)
}

function findBinary(root) {
  for (const rel of BIN_CANDIDATES) {
    const p = path.join(root, rel)
    if (fs.existsSync(p)) return p
  }
  return null
}

function hasDocker() {
  return new Promise((resolve) => {
    // ⚠️ 必须带超时：docker CLI 挂住的话，上层（backendStatus / backend:health）会**无限挂住**。
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let c
    try { c = spawn('docker', ['ps', '--format', '{{.Names}}']) } catch (e) { return finish(null) }
    let out = ''
    const killer = setTimeout(() => {
      try { c.kill() } catch (e) {
        // 杀不掉也没别的办法：已经超时了，只能当作"查不到 docker"（返回 null）
        if (typeof console !== 'undefined' && console.warn) console.warn('结束 docker 探测失败：', e && e.message)
      }
      finish(null)
    }, 5000)
    c.stdout.on('data', (d) => (out += d.toString()))
    c.on('error', () => { clearTimeout(killer); finish(null) })
    c.on('close', () => { clearTimeout(killer); finish(out.split(/\s+/).filter(Boolean)) })
  })
}

function buildEnv(port, extra) {
  return {
    ...process.env,
    MBP_HOST: '127.0.0.1',
    MBP_PORT: String(port),
    MBP_PG_HOST: '127.0.0.1',
    MBP_PG_PORT: String(PG_PORT),
    MBP_PG_USER: 'mbp',
    MBP_PG_PASSWORD: 'mbp',
    MBP_PG_DB: PG_DB,
    MBP_REDIS_HOST: '127.0.0.1',
    MBP_REDIS_PORT: '6379',
    MBP_JWT_SECRET: 'desktop-ide-dev-secret-change-me',
    MBP_CORS_ORIGINS: 'https://app.example.com',
    MBP_BCRYPT_COST: '6',
    MBP_RATE_LIMIT: '1000',
    MBP_MAX_CONNECTIONS: '64',
    ...(extra || {}),
  }
}

// 轮询 /health，返回是否就绪（避免"启动了但还没监听"的假象）
function probeHealth(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d.toString()))
        res.on('end', () => resolve(res.statusCode === 200 ? body.trim() : null))
      },
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

function registerBackendIpc({ ipcMain, getWindow, DEFAULT_CWD }) {
  const send = (channel, payload) => {
    const w = getWindow && getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  // ---- 状态查询 ----
  ipcMain.handle('backend:status', async (_e, { cwd, port } = {}) => {
    const root = rootOfInput(cwd) || DEFAULT_CWD
    const p = port || DEFAULT_PORT
    const alive = proc !== null && proc.exitCode === null
    let healthy = false
    if (alive) healthy = (await probeHealth(p)) !== null
    return {
      running: alive,
      healthy,
      starting,
      port: p,
      pid: alive ? proc.pid : null,
      binary: findBinary(root),
      logs: lastLogs.slice(-200),
    }
  })

  // ---- 依赖检查 ----
  ipcMain.handle('backend:deps', async () => {
    const names = await hasDocker()
    if (names === null) {
      return { docker: false, pg: false, redis: false }
    }
    return {
      docker: true,
      pg: names.includes('mbp-pg'),
      redis: names.includes('mbp-redis'),
    }
  })

  // ---- P14-06 一键健康检查（顺手把 PG/Redis 依赖状态一起带回 —— P14-09/10）----
  // 编排提到模块级 buildHealthReport()，与 Agent 的 backendStatus 工具**共用同一份**
  // （review 指出：两处各写一遍会导致同名字段语义不一致，例如 latencyMs 是否包含 docker 探测）。
  ipcMain.handle('backend:health', async (_e, input = {}) => buildHealthReport({
    root: rootOfInput(input.cwd) || DEFAULT_CWD,
    port: input.port || DEFAULT_PORT,
    path: input.path,
  }))

  // ---- 编译（可选步骤，让用户能自己在 IDE 里构建）----
  ipcMain.handle('backend:build', async (_e, input) => {
    return new Promise((resolve) => {
      log((l) => send('backend:log', { line: l }), '$ moon build --target native --release')
      const c = spawn('moon', ['build', '--target', 'native', '--release'], {
        cwd: rootOfInput(input) || DEFAULT_CWD,
        shell: false,
      })
      c.stdout.on('data', (d) => log((l) => send('backend:log', { line: l }), d))
      c.stderr.on('data', (d) => log((l) => send('backend:log', { line: l }), d))
      c.on('error', (e) => {
        log((l) => send('backend:log', { line: l }), `[build] 无法执行 moon：${e.message}`)
        resolve({ ok: false, error: e.message })
      })
      c.on('close', (code) => resolve({ ok: code === 0, code }))
    })
  })

  // ---- 启动 ----
  ipcMain.handle('backend:start', async (_e, { cwd, port, build } = {}) => {
    const root = rootOfInput(cwd) || DEFAULT_CWD
    const p = port || DEFAULT_PORT
    const sink = (l) => send('backend:log', { line: l })

    if (proc && proc.exitCode === null) {
      return { ok: false, error: '后端已在运行' }
    }

    // 依赖检查：容器没起就直接返回可读的原因，而不是让服务连不上库
    const deps = await (async () => {
      const names = await hasDocker()
      if (names === null) return { pg: true, redis: true } // 无 docker：假设用户自带
      return { pg: names.includes('mbp-pg'), redis: names.includes('mbp-redis') }
    })()
    if (!deps.pg || !deps.redis) {
      const missing = [!deps.pg && 'mbp-pg（PostgreSQL）', !deps.redis && 'mbp-redis（Redis）']
        .filter(Boolean)
        .join('、')
      log(sink, `[deps] 缺少容器：${missing}`)
      log(sink, '[deps] 请先运行：docker run -d --name mbp-pg -p 55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=mbp -e POSTGRES_PASSWORD=mbp -e POSTGRES_DB=mbptest postgres:16-alpine')
      log(sink, '[deps]            docker run -d --name mbp-redis -p 6379:6379 redis:7-alpine')
      return { ok: false, error: `缺少依赖容器：${missing}` }
    }

    let bin = findBinary(root)
    if (!bin || build) {
      log(sink, '[build] 未找到二进制或用户要求重新构建，开始编译…')
      const r = await new Promise((resolve) => {
        const c = spawn('moon', ['build', '--target', 'native', '--release'], {
          cwd: root,
          shell: false,
        })
        c.stdout.on('data', (d) => log(sink, d))
        c.stderr.on('data', (d) => log(sink, d))
        c.on('error', (e) => {
          log(sink, `[build] 无法执行 moon：${e.message}`)
          resolve(false)
        })
        c.on('close', (code) => resolve(code === 0))
      })
      if (!r) {
        log(sink, '[build] 编译失败（若二进制正被占用，请先停止已运行的后端）')
        return { ok: false, error: '编译失败' }
      }
      bin = findBinary(root)
    }
    if (!bin) return { ok: false, error: '找不到可执行文件，请先编译' }

    log(sink, `[start] 二进制：${path.relative(root, bin)}`)
    log(sink, `[start] 监听 127.0.0.1:${p}  ·  数据库 ${PG_DB}@${PG_PORT}`)

    starting = true
    proc = spawn(bin, [], {
      cwd: root, // 迁移目录是相对路径，必须是模块根
      env: buildEnv(p),
      shell: false,
    })
    proc.stdout.on('data', (d) => log(sink, d))
    proc.stderr.on('data', (d) => log(sink, d))
    proc.on('error', (e) => {
      log(sink, `[start] 启动失败：${e.message}`)
      starting = false
      proc = null
    })
    proc.on('close', (code) => {
      log(sink, `[exit] 进程退出，code=${code}`)
      starting = false
      proc = null
      send('backend:state', { running: false })
    })

    // 轮询健康检查，把「启动中」变成「运行中」
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (!proc || proc.exitCode !== null) {
        starting = false
        return { ok: false, error: '进程已退出，请看日志' }
      }
      const body = await probeHealth(p)
      if (body !== null) {
        starting = false
        log(sink, `[ready] /health → ${body}`)
        send('backend:state', { running: true, healthy: true, port: p })
        return { ok: true, port: p, pid: proc.pid, health: body }
      }
    }
    starting = false
    return { ok: false, error: '启动超时（20s 内 /health 未就绪）' }
  })

  // ---- 停止 ----
  ipcMain.handle('backend:stop', async () => {
    if (!proc || proc.exitCode !== null) {
      proc = null
      return { ok: true, already: true }
    }
    const p = proc
    proc = null
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/PID', String(p.pid), '/T'])
      } else {
        p.kill('SIGTERM')
      }
    } catch (_) {
      /* ignore */
    }
    return { ok: true }
  })

  // 进程随 IDE 退出而结束，避免留下孤儿进程
  ipcMain.on('backend:kill-on-exit', () => {
    if (proc && proc.exitCode === null) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/F', '/PID', String(proc.pid), '/T'])
        } else {
          proc.kill('SIGKILL')
        }
      } catch (_) {
        /* ignore */
      }
    }
  })
}

/**
 * P14-06 的健康报告（**唯一实现**）：backend:health IPC 与 Agent 的 backendStatus 工具共用。
 *
 * 关键语义（review 指出两处曾不一致）：
 *   · `latencyMs` 只计 `probeHealth`，**不含** `docker ps` 的耗时；
 *   · `deps.known=false` 表示"查不到 docker"，而不是"没有容器"；
 *   · 端口/路径做校验，避免变成"对 127.0.0.1 任意端口发 GET"的通用探测原语。
 */
async function buildHealthReport({ root, port, path: p } = {}) {
  const portN = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
  let rel = String(p || '/health')
  if (!rel.startsWith('/')) rel = '/' + rel
  if (!/^\/[A-Za-z0-9_\-./]{0,120}$/.test(rel)) rel = '/health'      // 去掉乱七八糟的路径
  const url = 'http://127.0.0.1:' + portN + rel

  const t0 = Date.now()
  let v = null
  try { v = await probeHealth(portN) } catch (e) { v = null }
  const latencyMs = Date.now() - t0                                // ★ 只看探测本身

  let names = null
  try { names = await hasDocker() } catch (e) { names = null }
  const deps = names === null
    ? { docker: false, pg: false, redis: false, known: false }
    : { docker: true, pg: names.includes('mbp-pg'), redis: names.includes('mbp-redis'), known: true }

  return {
    ok: !!v,
    url,
    port: portN,
    rootDir: root || null,
    latencyMs,
    body: v ? String(v).slice(0, 300) : null,
    error: v ? null : ('连不上 ' + url),
    deps,
  }
}

module.exports = { registerBackendIpc, DEFAULT_PORT, probeHealth, hasDocker, buildHealthReport }
