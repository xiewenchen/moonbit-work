// MoonBit IDE —— Electron 主进程
//
// 职责：创建窗口 + 把「运行 moon 命令」的能力通过 IPC 暴露给前端。
// 兼容层/内核是纯 MoonBit（native），这里先直接调 moon CLI；
// 以后可以换成调用我们自己的 kernel 可执行文件。

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const fs = require('fs')
const { parseDiagnostics, parseOutline } = require('./lsp-parse')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fsops = require('./fsops')
const { registerBackendIpc } = require('./backend')
const { registerApiDebugIpc } = require('./api-debug')
const { registerProjectIpc } = require('./project-detect')
const { registerRelayIpc } = require('./relay-main')
const { registerRunnerIpc } = require('./runners')
const { registerAgentIpc } = require('./agent')
const { registerLspIpc } = require('./lsp-manager')

// ── 环境准备：必须在任何 spawn 之前 ─────────────────────────────────────
// 从桌面快捷方式启动时，进程 PATH 是 Windows 默认值，**不含** ~/.moon/bin
// （实测快捷方式 = `electron.exe .`，不带任何环境变量）。
// 那会让 spawn('moon') 直接 ENOENT —— 用户看到的现象就是「任何项目都运行不起来」。
// 开发时从 Git Bash 启动恰好带着 .moon/bin，所以这个坑在开发机上一直被掩盖。
const os = require('node:os')
const MOON_BIN_DIR = path.join(os.homedir(), '.moon', 'bin')
if (fs.existsSync(MOON_BIN_DIR)) {
  const parts = (process.env.PATH || '').split(path.delimiter)
  const norm = (s) => s.replace(/[\\/]+$/, '').toLowerCase()
  if (!parts.some((p) => norm(p) === norm(MOON_BIN_DIR))) {
    process.env.PATH = MOON_BIN_DIR + path.delimiter + (process.env.PATH || '')
  }
}

// 默认工作目录 = 本模块根；但**允许命令行指定**，
// 这样可以用这个 IDE 打开任意项目（例如桌面上那个 Strapi 后端）：
//   electron . <项目目录>
function resolveStartDir() {
  const args = process.argv
    .slice(1)
    .filter((a) => a !== '.' && !a.startsWith('--') && !a.endsWith('main.js') && a.trim() !== '')
  for (const a of args) {
    try {
      if (a && fs.existsSync(a) && fs.statSync(a).isDirectory()) return { dir: path.resolve(a), explicit: true }
    } catch (_) {
      /* ignore */
    }
  }
  // 没给目录：仍然给一个兜底目录（不少 IPC 需要个工作目录），
  // 但打上 explicit:false —— 前端据此**不自动打开它**，而是停在欢迎页。
  return { dir: path.join(__dirname, '..'), explicit: false }
}

const START = resolveStartDir()
const START_DIR = START.dir
const START_EXPLICIT = START.explicit
const DEFAULT_CWD = START.dir

// 提升为模块级：后端服务的日志/状态需要通过它推给渲染层
let mainWindow = null

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'MoonBit IDE',
    backgroundColor: '#181826', // Strapi neutral900（--s-n1000）—— 与页面底色一致，避免启动瞬间闪白/闪灰
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程沙箱 + 禁止加载远程内容（Electron 安全基线）
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  win.loadFile('index.html')
  mainWindow = win
  win.webContents.once('did-finish-load', () => {
    ensureDependencies()
  })
  win.on('closed', () => {
    mainWindow = null
  })
}

// 后端服务控制（一键启动 / 停止 / 状态 / 日志）—— 见 backend.js
registerBackendIpc({ ipcMain, getWindow: () => mainWindow, DEFAULT_CWD })

// 接口调试器（在 IDE 里直接调后端接口）—— 见 api-debug.js
registerApiDebugIpc({ ipcMain, DEFAULT_CWD })

// 项目类型识别（打开任意项目时说清哪些功能可用）—— 见 project-detect.js
registerProjectIpc({ ipcMain, DEFAULT_CWD })

// 文件中转站（Office 文档的备份与版本回滚）—— 见 relay-main.js
registerRelayIpc({ ipcMain, getWindow: () => mainWindow })

// 可执行入口发现与运行（moonbit / node / python / rust / go）—— 见 runners.js
registerRunnerIpc({ ipcMain, getWindow: () => mainWindow })
registerAgentIpc({ getWindow: () => mainWindow })

// LSP 客户端（接官方 moon-lsp）—— 见 lsp-manager.js
registerLspIpc({ ipcMain, getWindow: () => mainWindow })

// 启动时确保后端依赖容器就绪。
// 目的：用户双击桌面快捷方式后不该再手动开终端起容器 —— 缺了就代为拉起。
const DEP_CONTAINERS = [
  {
    name: 'mbp-pg',
    title: 'PostgreSQL',
    run: ['run', '-d', '--name', 'mbp-pg', '-p', '55432:5432',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=mbp',
      '-e', 'POSTGRES_PASSWORD=mbp', '-e', 'POSTGRES_DB=mbptest',
      'postgres:16-alpine'],
  },
  {
    name: 'mbp-redis',
    title: 'Redis',
    run: ['run', '-d', '--name', 'mbp-redis', '-p', '6379:6379', 'redis:7-alpine'],
  },
]

function docker(args) {
  return new Promise((resolve) => {
    const c = spawn('docker', args, { shell: false })
    let out = ''
    c.stdout.on('data', (d) => (out += d.toString()))
    c.stderr.on('data', (d) => (out += d.toString()))
    c.on('error', () => resolve({ ok: false, out: 'docker 不可用' }))
    c.on('close', (code) => resolve({ ok: code === 0, out }))
  })
}

async function ensureDependencies() {
  const ps = await docker(['ps', '--format', '{{.Names}}'])
  if (!ps.ok) return // 没装 docker：交给用户自己判断
  const running = ps.out.split(/\s+/).filter(Boolean)
  const started = []
  for (const c of DEP_CONTAINERS) {
    if (running.includes(c.name)) continue
    // 已存在但未运行 → start；不存在 → run
    const all = await docker(['ps', '-a', '--format', '{{.Names}}'])
    const existed = all.out.split(/\s+/).filter(Boolean).includes(c.name)
    const r = existed ? await docker(['start', c.name]) : await docker(c.run)
    if (r.ok) started.push(c.title)
  }
  if (started.length > 0) {
    // 等容器里的服务真正就绪（PostgreSQL 首次初始化需要几秒）
    await new Promise((r) => setTimeout(r, 6000))
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend:log', {
        line: `[deps] 已自动拉起依赖容器：${started.join('、')}`,
      })
    }
  }
}

// 运行 `moon <args>`，收集 stdout/stderr。
// 长稳防护：命令超时（防永久挂住造成子进程泄漏）+ 输出上限（防内存暴涨）。
const COMMAND_TIMEOUT_MS = 120000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const ADMIN_PORT = 8081
ipcMain.handle('moon', async (_event, { args, cwd }) => {
  const workdir = cwd && cwd.length > 0 ? cwd : DEFAULT_CWD
  return await new Promise((resolve) => {
    // 防御：args 必须是非空字符串数组（IPC 参数来自 renderer）
    const argv = Array.isArray(args) ? args.filter((a) => typeof a === 'string') : []
    const child = spawn('moon', argv, { cwd: workdir })
    let stdout = ''
    let stderr = ''
    let done = false
    const cap = (s, d) => {
      const t = s + d.toString()
      return t.length > MAX_OUTPUT_BYTES ? t.slice(t.length - MAX_OUTPUT_BYTES) : t
    }
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      stderr = cap(stderr, `\n[timeout] 超时 ${COMMAND_TIMEOUT_MS}ms，已终止`)
      finish(-1)
    }, COMMAND_TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      stdout = cap(stdout, d)
    })
    child.stderr.on('data', (d) => {
      stderr = cap(stderr, d)
    })
    child.on('error', (err) => {
      stderr = cap(stderr, String(err))
      finish(-1)
    })
    child.on('close', (code) => {
      finish(code)
    })
  })
})

// ---------------------------------------------------------------------------
// 流式跑 moon（手册 3.1）
//
// 与上面的 runMoonCapture 的区别：**不等进程结束**，边跑边把 stdout/stderr
// 推给渲染层。这样 `moon build` / `moon test` 这类长任务能实时看到进度，
// 而不是"界面卡半天、完事刷一大坨" —— 后者会让人以为程序挂了。
//
// 约束：
//   • 同一时刻只允许一个流式任务，避免多个任务的输出交叉串台
//   • 超时设得很宽（10 分钟），因为 `moon run` 可能是长期运行的服务，不能随便杀
//   • IDE 退出时一并终止，避免留下孤儿进程
const MOON_STREAM_TIMEOUT_MS = 10 * 60 * 1000
let runningMoon = null

ipcMain.handle('moon:stream', async (event, { args, cwd, timeoutMs }) => {
  if (runningMoon) {
    return { ok: false, code: -2, error: '已有任务在运行，请先点「停止」' }
  }
  return new Promise((resolve) => {
    const child = spawn('moon', args, { cwd, shell: false })
    runningMoon = child
    let done = false
    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
    }
    const finish = (code, error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      runningMoon = null
      send('moon:stream-end', { code: code, error: error })
      resolve({ ok: code === 0, code: code, error: error })
    }
    const limit = timeoutMs || MOON_STREAM_TIMEOUT_MS
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      send('moon:stream-data', {
        stream: 'stderr',
        data: `\n[timeout] 超时 ${limit}ms，已终止\n`,
      })
      finish(-1)
    }, limit)
    child.stdout.on('data', (d) =>
      send('moon:stream-data', { stream: 'stdout', data: d.toString() }),
    )
    child.stderr.on('data', (d) =>
      send('moon:stream-data', { stream: 'stderr', data: d.toString() }),
    )
    child.on('error', (err) => finish(-1, String(err.message)))
    child.on('close', (code) => finish(code))
  })
})

// 用户点「停止」时终止当前流式任务（如 `moon run` 起的服务）
ipcMain.on('moon:stream-stop', () => {
  if (runningMoon) {
    try {
      runningMoon.kill()
    } catch (_) {
      /* ignore */
    }
    runningMoon = null
  }
})

ipcMain.handle('moon:format', async (_e, { cwd, file }) => {
  // moon fmt <file> 会格式化「包含该文件的那个包」——
  // 因此格式化后**必须重新读文件**，否则编辑器里的内容与磁盘不一致。
  return new Promise((resolve) => {
    const args = file ? ['fmt', file] : ['fmt']
    const c = spawn('moon', args, { cwd, shell: false })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d.toString()))
    c.stderr.on('data', (d) => (err += d.toString()))
    c.on('error', (e) => resolve({ ok: false, error: String(e.message) }))
    c.on('close', (code) => {
      // 语法错误时 fmt 会失败 —— 这不该阻塞保存，交由调用方决定怎么提示
      resolve({ ok: code === 0, code: code, stdout: out.slice(0, 2000), stderr: err.slice(0, 2000) })
    })
  })
})

ipcMain.handle('defaultCwd', () => DEFAULT_CWD)
// 启动信息：既给兜底目录，也告诉前端「这个目录是不是命令行明确指定的」。
// 前端据此决定开机是否自动打开项目 —— 没指定就停在欢迎页。
ipcMain.handle('startInfo', () => ({ dir: START_DIR, explicit: START_EXPLICIT }))

// 文件系统能力
ipcMain.handle('fs:list', (_e, dir) => {
  try {
    return { ok: true, entries: fsops.listDir(dir) }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})
ipcMain.handle('fs:read', (_e, file) => {
  try {
    return { ok: true, ...fsops.readTextFile(file) }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})
ipcMain.handle('fs:write', (_e, { file, content }) => {
  try {
    return { ok: true, ...fsops.writeTextFile(file, content) }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})
ipcMain.handle('module', (_e, dir) => {
  try {
    return { ok: true, module: fsops.findModule(dir) }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})
// 选择目录
ipcMain.handle('pickDir', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
})

// 让用户选一个"新建项目的目标目录"：用保存对话框变通（Electron 没有内置输入框）
ipcMain.handle('pickProjectPath', async (_e, { parentDir, defaultName }) => {
  const res = await dialog.showSaveDialog({
    title: '新建 MoonBit 项目（输入项目文件夹名）',
    defaultPath: path.join(parentDir || DEFAULT_CWD, defaultName || 'my_project'),
    buttonLabel: '创建',
    properties: ['createDirectory'],
  })
  if (res.canceled || !res.filePath) return null
  return res.filePath
})

// 用 moon new 生成标准项目模板
ipcMain.handle('newProject', async (_e, { dir }) => {
  return new Promise((resolve) => {
    if (!dir) return resolve({ ok: false, error: '未指定目录' })
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
      return resolve({ ok: false, error: '目标目录已存在且非空：' + dir })
    }
    const c = spawn('moon', ['new', dir], { cwd: path.dirname(dir), shell: false })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d.toString()))
    c.stderr.on('data', (d) => (err += d.toString()))
    c.on('error', (e) => resolve({ ok: false, error: String(e.message) }))
    c.on('close', (code) =>
      resolve({ ok: code === 0, code, stdout: out.slice(0, 3000), stderr: err.slice(0, 3000), dir }),
    )
  })
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// --------------------------------------------------------------------------- 集成终端
//
// 首选 node-pty（真 PTY，最接近 VS Code：支持交互式程序与颜色）。
// 若原生模块不可用（Electron ABI 不匹配等），自动回退到 child_process（管道模式）。
let pty = null
try {
  pty = require('node-pty')
} catch (_) {
  pty = null
}
console.log('[term] backend =', pty ? 'node-pty' : 'child_process (fallback)')

const termSessions = new Map()
let nextTermId = 1

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/bash'
}

ipcMain.handle('term:create', (event, { cwd }) => {
  const id = String(nextTermId++)
  const workdir = cwd && cwd.length > 0 ? cwd : DEFAULT_CWD
  try {
    let session
    if (pty) {
      const p = pty.spawn(defaultShell(), [], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: workdir,
        env: process.env,
      })
      session = { kind: 'pty', proc: p }
      p.onData((d) => {
        if (!event.sender.isDestroyed()) event.sender.send('term:data', { id, data: d })
      })
      p.onExit(({ exitCode }) => {
        if (!event.sender.isDestroyed()) event.sender.send('term:exit', { id, code: exitCode })
        termSessions.delete(id)
      })
    } else {
      const p = spawn(defaultShell(), [], { cwd: workdir, env: process.env })
      session = { kind: 'child', proc: p }
      const fwd = (d) => {
        if (!event.sender.isDestroyed()) event.sender.send('term:data', { id, data: d.toString() })
      }
      p.stdout.on('data', fwd)
      p.stderr.on('data', fwd)
      p.on('exit', (code) => {
        if (!event.sender.isDestroyed()) event.sender.send('term:exit', { id, code })
        termSessions.delete(id)
      })
      p.on('error', (err) => {
        if (!event.sender.isDestroyed())
          event.sender.send('term:data', { id, data: '\r\n[error] ' + String(err) + '\r\n' })
      })
    }
    termSessions.set(id, session)
    return { id }
  } catch (e) {
    return { error: String(e) }
  }
})

ipcMain.on('term:input', (_e, { id, data }) => {
  const s = termSessions.get(String(id))
  if (!s || typeof data !== 'string') return
  if (s.kind === 'pty') {
    s.proc.write(data)
  } else {
    try {
      s.proc.stdin.write(data)
    } catch (_) {
      /* ignore */
    }
  }
})

ipcMain.on('term:resize', (_e, { id, cols, rows }) => {
  const s = termSessions.get(String(id))
  if (!s || s.kind !== 'pty') return
  try {
    s.proc.resize(Math.max(2, cols | 0), Math.max(1, rows | 0))
  } catch (_) {
    /* ignore */
  }
})

ipcMain.on('term:kill', (_e, { id }) => {
  const key = String(id)
  const s = termSessions.get(key)
  if (!s) return
  try {
    s.proc.kill()
  } catch (_) {
    /* ignore */
  }
  termSessions.delete(key)
})

// 退出时清理所有终端会话（防子进程泄漏）
app.on('before-quit', () => {
  for (const [, s] of termSessions) {
    try {
      s.proc.kill()
    } catch (_) {
      /* ignore */
    }
  }
  termSessions.clear()
  // 流式 moon 任务也要收掉（例如 `moon run` 起的服务），避免留孤儿进程
  if (runningMoon) {
    try {
      runningMoon.kill()
    } catch (_) {
      /* ignore */
    }
    runningMoon = null
  }
})

// node-pty 的 Windows 实现会在 `term.kill()` 时 fork 出一个独立子进程
// （conpty_console_list_agent.js）去枚举 console 进程树；而此刻 shell 进程刚被 kill，
// 子进程里的 AttachConsole(shellPid) 便失败并打印 "AttachConsole failed"。
//
// 关键事实：**它发生在子进程里**，不是主进程 —— 所以主进程的 uncaughtException
// 其实抓不到它（曾经我误以为是主进程的错）。它不影响功能，只是刷屏让人以为崩了。
// 这里保留一个针对性的兜底：主进程内若出现同类错误就忽略，其它异常照常打印，
// 不做无差别吞异常。子进程那一条只能靠 node-pty 自身修（已记录在 README）。
process.on('uncaughtException', (err) => {
  const msg = String((err && err.message) || err)
  if (/AttachConsole failed/.test(msg)) return
  console.error('[main] 未捕获异常:', err)
})

// --------------------------------------------------------------------------- LSP 能力（基于 moon check / moon ide）
//
// 不引入完整 LSP 客户端（stdio/websocket 桥接成本高），而是复用 `moon` 自带的
// 语义化命令：诊断用 `moon check`、大纲用 `moon ide outline`。

// 跑一条 moon 命令并收集输出（供上面各能力复用）
function runMoonCapture(args, workdir, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn('moon', args, { cwd: workdir })
    let stdout = ''
    let stderr = ''
    let done = false
    const cap = (s, d) => {
      const t = s + d.toString()
      return t.length > MAX_OUTPUT_BYTES ? t.slice(t.length - MAX_OUTPUT_BYTES) : t
    }
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      finish(-1)
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout = cap(stdout, d)
    })
    child.stderr.on('data', (d) => {
      stderr = cap(stderr, d)
    })
    child.on('error', (err) => {
      stderr = cap(stderr, String(err))
      finish(-1)
    })
    child.on('close', (code) => finish(code))
  })
}

ipcMain.handle('diag:check', async (_e, { cwd }) => {
  const workdir = cwd && cwd.length > 0 ? cwd : DEFAULT_CWD
  const res = await runMoonCapture(['check', '--target', 'native'], workdir, 180000)
  return {
    exitCode: res.code,
    diagnostics: parseDiagnostics(res.stdout + '\n' + res.stderr),
  }
})

ipcMain.handle('outline:get', async (_e, { cwd, file }) => {
  const workdir = cwd && cwd.length > 0 ? cwd : DEFAULT_CWD
  if (!file || typeof file !== 'string') return { symbols: [] }
  const res = await runMoonCapture(['ide', 'outline', file], workdir, 120000)
  return { exitCode: res.code, symbols: parseOutline(res.stdout + '\n' + res.stderr) }
})

// --------------------------------------------------------------------------- 跨文件搜索
const { searchInDir } = require('./search')

ipcMain.handle('search:files', (_e, { cwd, query, caseInsensitive }) => {
  const root = cwd && cwd.length > 0 ? cwd : DEFAULT_CWD
  if (typeof query !== 'string' || query.length === 0) {
    return { results: [], scanned: 0, truncated: false }
  }
  try {
    return searchInDir(root, query, { caseInsensitive: !!caseInsensitive })
  } catch (err) {
    return { results: [], scanned: 0, truncated: false, error: String(err) }
  }
})

// --------------------------------------------------------------------------- 后端面板（转发到本地管理接口）
const http = require('http')

// 只允许访问管理服务的 /api/ 前缀（白名单，防止被用作任意 SSRF）
function adminPathAllowed(p) {
  return typeof p === 'string' && p.startsWith('/api/') && !p.includes('..')
}

ipcMain.handle('admin:get', async (_e, { path: p }) => {
  if (!adminPathAllowed(p)) return { status: 400, body: 'invalid path' }
  const port = ADMIN_PORT
  return await new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    const req = http.get(
      { host: '127.0.0.1', port, path: p, timeout: 5000 },
      (res) => {
        let body = ''
        res.on('data', (d) => {
          if (body.length < 2 * 1024 * 1024) body += d
        })
        res.on('end', () => done({ status: res.statusCode, body }))
      },
    )
    req.on('timeout', () => {
      req.destroy()
      done({ status: 0, body: 'timeout' })
    })
    req.on('error', (e) => done({ status: 0, body: String(e) }))
  })
})

// --------------------------------------------------------------------------- 符号索引（补全 / 跳转定义）
const {
  loadSymbols,
  symbolsPath,
  symbolFsPath,
  extractHover,
} = require('./symbols')

// 内存缓存：避免每次按键都读文件
let symbolsCache = { root: null, at: 0, list: [] }

ipcMain.handle('symbols:load', async (_e, { cwd, force }) => {
  const root = cwd && cwd.length > 0 ? cwd : DEFAULT_CWD
  const fresh =
    symbolsCache.root === root && Date.now() - symbolsCache.at < 30000 && !force
  if (!fresh) {
    if (force || !fs.existsSync(symbolsPath(root))) {
      // 索引不存在（或强制刷新）→ 生成一次。
      // ⚠️ 必须带 `--target native`：gen-symbols 默认走 wasm，
      //    会**跳过 supported_targets = "native" 的包**（kernel/app/db/admin）。
      await runMoonCapture(['ide', 'gen-symbols', '--target', 'native'], root, 180000)
    }
    const list = loadSymbols(root)
    // 预处理：把相对路径转成绝对路径，渲染端直接用
    symbolsCache = {
      root,
      at: Date.now(),
      list: list.map((s) => ({
        name: s.name,
        kind: s.kind,
        package: s.package,
        fsPath: symbolFsPath(root, s),
        line: s.line,
        col: s.col,
        // hover 需要：声明范围与文档范围
        startLine: s.startLine,
        endLine: s.endLine,
        docStartLine: s.docStartLine,
        docEndLine: s.docEndLine,
      })),
    }
  }
  return { count: symbolsCache.list.length, symbols: symbolsCache.list.slice(0, 4000) }
})

// hover：按符号名找到定义所在文件，提取「文档注释 + 签名」。
// 说明：`moon-lsp` 的 hover 与 `moon ide hover` 在本机都不可用，
//      因此用符号索引 + 源码片段做降级实现。
ipcMain.handle('symbols:hover', async (_e, { cwd, word }) => {
  const root = cwd && cwd.length > 0 ? cwd : DEFAULT_CWD
  if (!word || typeof word !== 'string') return null
  try {
    // 复用/填充符号缓存
    if (symbolsCache.root !== root) {
      const list = loadSymbols(root).map((s) => ({
        name: s.name,
        kind: s.kind,
        package: s.package,
        fsPath: symbolFsPath(root, s),
        line: s.line,
        col: s.col,
        startLine: s.startLine,
        endLine: s.endLine,
        docStartLine: s.docStartLine,
        docEndLine: s.docEndLine,
      }))
      symbolsCache = { root, at: Date.now(), list }
    }
    const sym = symbolsCache.list.find((s) => s.name === word)
    if (!sym) return null
    const text = fs.readFileSync(sym.fsPath, 'utf8')
    const lines = text.split(/\r?\n/)
    const snippet = extractHover(sym, lines)
    if (!snippet) return null
    return {
      name: sym.name,
      package: sym.package,
      markdown: '```moonbit\n' + snippet + '\n```\n\n' + (sym.package ? '`' + sym.package + '`' : ''),
    }
  } catch (_) {
    return null
  }
})
