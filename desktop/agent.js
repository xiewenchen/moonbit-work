// AI Agent 面板的后端：把 opencode 当作**可编程服务**来接，而不是开个终端跑 TUI。
//
// 依据（来自官方文档核实）：
//   · `opencode run "prompt" --format json` 输出 JSON 事件流 → 适合子进程逐行解析
//   · 模型配置在 ~/.config/opencode/opencode.json，支持 OpenAI 兼容的
//     provider.<id>.options.{baseURL, apiKey}
//   · Electron 侧没有官方内嵌方案，正确姿势就是「子进程 + 流式解析 + 自绘 UI」
//
// 这样做的理由：串行 TUI 没法在面板里用；一次 run 一个 prompt 的模型最简单，
// 也最不容易受 opencode 内部状态影响。
const { ipcMain, shell } = require('electron')
const { spawn, spawnSync } = require('child_process')
const { resolveSpawn } = require('./spawn-util')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CFG_DIR = path.join(os.homedir(), '.config', 'opencode')
const CFG_FILE = path.join(CFG_DIR, 'opencode.json')

// 找到 opencode 可执行文件。
// npm 全局安装后 Windows 上是 opencode.cmd，且**不一定在当前进程的 PATH 里**
// （桌面快捷方式启动时 PATH 是系统默认值）—— 所以除了 which 还要主动翻常见位置。
// 内置的 opencode 放在哪里：
//   · 打包后 —— process.resourcesPath/opencode（electron-builder 的 extraResources）
//   · 开发期 —— desktop/vendor/opencode
function bundledDirs() {
  const out = []
  try { if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'opencode')) } catch (_) {}
  out.push(path.join(__dirname, 'vendor', 'opencode'))
  return out
}

function findOpencode() {
  const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode']
  // ① 先找**内置**的 —— 参赛作品要开箱即用，不能指望评委自己装 opencode
  for (const d of bundledDirs()) {
    for (const n of names) {
      const p = path.join(d, n)
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p } catch (_) {}
    }
  }
  // ② 再找用户系统里装的（有就用，作为兜底）
  const dirs = []
  const push = (d) => { if (d && !dirs.includes(d)) dirs.push(d) }
  push(process.env.APPDATA && path.join(process.env.APPDATA, 'npm'))
  push(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'opencode'))
  push(path.join(os.homedir(), '.opencode', 'bin'))
  push(path.join(os.homedir(), '.local', 'bin'))
  push('/usr/local/bin')
  for (const d of (process.env.PATH || '').split(path.delimiter)) push(d)
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n)
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p } catch (_) {}
    }
  }
  return null
}

// 读用户模型配置（明文 read，写回时保留原结构）
function readConfig() {
  try {
    const raw = fs.readFileSync(CFG_FILE, 'utf8').replace(/^\s*\/\/.*$/gm, '')
    return { ok: true, path: CFG_FILE, config: JSON.parse(raw) }
  } catch (e) {
    return { ok: true, path: CFG_FILE, config: null, exists: false }
  }
}

function writeConfig(json) {
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true })
    fs.writeFileSync(CFG_FILE, JSON.stringify(json, null, 2), 'utf8')
    return { ok: true, path: CFG_FILE }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function registerAgentIpc({ getWindow }) {
  const send = (ch, payload) => {
    const w = getWindow && getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload)
  }
  let current = null

  ipcMain.handle('agent:status', () => {
    const bin = findOpencode()
    const cfg = readConfig()
    const providers = cfg.config && cfg.config.provider ? Object.keys(cfg.config.provider) : []
    const model = cfg.config && cfg.config.model ? cfg.config.model : null
    return {
      ok: true,
      installed: !!bin,
      bin: bin || '',
      version: (() => {
        if (!bin) return ''
        const sp = resolveSpawn(bin, ['--version'])
        try {
          const r = spawnSync(sp.bin, sp.args, { encoding: 'utf8', shell: sp.shell })
          return String(r.stdout || r.stderr || '').trim().split('\n')[0]
        } catch (_) { return '' }
      })(),
      configPath: CFG_FILE,
      configExists: !!cfg.config,
      providers,
      model,
    }
  })

  // 一次对话：spawn `opencode run <prompt> --format json`，逐行解析事件并推给前端。
  // 只保留一个并发（同一时刻一个任务），和 runner 的做法一致，避免输出串台。
  ipcMain.handle('agent:run', (_e, { prompt, cwd, model }) => {
    const bin = findOpencode()
    if (!bin) return { ok: false, error: '未找到 opencode 可执行文件（npm i -g opencode-ai 安装后重启 IDE）' }
    if (current) { try { current.kill() } catch (_) {} current = null }
    // --format json 是**必须**的：不加它 opencode 输出的是人类可读文本，
    // 下面的 JSON 事件解析会全部落空 → 界面上只有空气泡（实测踩过）。
    const args = ['run', String(prompt || ''), '--format', 'json']
    if (model) args.push('--model', model)
    send('agent:start', { prompt: String(prompt || ''), bin })
    let child
    try {
      // .cmd/.bat（npm 全局装 CLI 在 Windows 上就是这种）不能直接 spawn，
      // 会抛 EINVAL —— 交给 resolveSpawn 走 cmd.exe。
      const sp = resolveSpawn(bin, args)
      // stdin 置 ignore：spawn 默认给子进程一个 stdin 管道，
      // opencode 这类 CLI 会等它 → 非交互场景下一直不退出（实测 90 秒仍挂着）。
      child = spawn(sp.bin, sp.args, { cwd: cwd || process.cwd(), shell: sp.shell, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      send('agent:end', { ok: false, error: '启动失败：' + e.message })
      return { ok: false, error: e.message }
    }
    current = child
    const onData = (buf) => {
      // opencode --format json 的事件格式（实测样本）：
      //   {"type":"step_start",...}
      //   {"type":"text","part":{"type":"text","text":"Hi!"}}          ← 要显示的正文
      //   {"type":"step_finish","part":{"tokens":{...},"cost":0}}      ← 用量统计
      // 所以不能原样透传 JSON，否则界面上全是花括号 —— 要按 type 提取。
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        let ev = null
        try { ev = JSON.parse(line) } catch (_) {}
        if (!ev || typeof ev !== 'object') {
          send('agent:data', { type: 'raw', text: line })
          continue
        }
        const part = ev.part || {}
        if (ev.type === 'text' && typeof part.text === 'string') {
          send('agent:data', { type: 'text', text: part.text })
        } else if (ev.type === 'tool' || part.type === 'tool') {
          // 工具调用也显示出来 —— agent 干了什么应该让用户看见
          const name = part.tool || (part.state && part.state.name) || 'tool'
          send('agent:data', { type: 'tool', text: String(name) })
        } else if (ev.type === 'step_finish' && part.tokens) {
          send('agent:data', { type: 'meta', tokens: part.tokens, cost: part.cost })
        } else if (ev.type === 'error' || ev.error) {
          send('agent:data', { type: 'error', text: typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error || ev) })
        }
        // step_start 之类的过程事件不发，避免刷屏
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => send('agent:end', { ok: false, error: '无法执行 opencode：' + e.message }))
    child.on('close', (code) => { send('agent:end', { ok: code === 0, code }); current = null })
    return { ok: true, pid: child.pid }
  })

  ipcMain.handle('agent:stop', () => {
    if (!current) return { ok: false, error: '没有正在运行的 agent 任务' }
    try { current.kill(); current = null; return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('agent:config:get', () => readConfig())
  ipcMain.handle('agent:config:set', (_e, json) => writeConfig(json))
  // 打开配置目录，方便用户自己编辑（很多 provider 配置项我们不该替他猜）
  ipcMain.handle('agent:open-config', () => {
    try { fs.mkdirSync(CFG_DIR, { recursive: true }) } catch (_) {}
    shell.openPath(CFG_FILE).catch(() => shell.openPath(CFG_DIR))
    return { ok: true, path: CFG_FILE }
  })
}

module.exports = { registerAgentIpc, findOpencode, CFG_FILE }
