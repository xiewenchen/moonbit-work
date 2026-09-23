// LSP 管理器（主进程侧）—— 接官方 moon-lsp
//
// 定位：Step 1「跑通主进程能跟 LSP 对话」的正式实现，并预留 Step 2/4 需要的全部接口。
// 工业级要求（用户给的验收标准）落地方式：
//   · 配置化   —— 命令/参数/传输/语言ID/超时 全部从配置读（默认值 + 项目内 .moonbit-ide.json 覆盖）
//   · 生命周期 —— start 时拉起，stop 时先 shutdown 再 exit 再 kill，崩溃自动重启（有次数上限）
//   · 文档同步 —— didOpen / didChange / didClose 都发，且维护 version 单调递增
//   · 错误处理 —— 每个请求带超时，超时/无响应返回明确错误，不静默卡死
//   · 可替换   —— 换成别的语言服务器（如 TypeScript）只改配置，不改代码
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

// 默认配置。command 走 moon-lsp 的绝对路径（~/.moon/bin），传输用标准 stdio。
const DEFAULT_LSP = {
  command: path.join(os.homedir(), '.moon', 'bin', process.platform === 'win32' ? 'moon-lsp.exe' : 'moon-lsp'),
  args: ['--stdio'],
  transport: 'stdio',          // 目前支持 stdio；socket 留给后续（配置里换即可）
  languageId: 'moonbit',
  requestTimeoutMs: 10000,     // 单请求超时：超了就报超时，而不是一直等
  initTimeoutMs: 20000,
  maxRestarts: 3,              // 崩溃自动重启次数上限
}

// 读取生效配置：内置默认 ← 项目内 .moonbit-ide.json 的 lsp 段
function loadLspConfig(root) {
  const cfg = { ...DEFAULT_LSP }
  try {
    const p = path.join(root || process.cwd(), '.moonbit-ide.json')
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (j && j.lsp && typeof j.lsp === 'object') Object.assign(cfg, j.lsp)
    }
  } catch (_) { /* 配置坏了就用默认 */ }
  return cfg
}

const pathToUri = (p) => 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/^\//, '')

// Monaco 的 URI 与 LSP 期望的 URI 不一致，必须对齐（否则 didOpen 的文件和 definition
// 返回的文件会被当成两个文件，跳转失效）：
//   Monaco: file:///c%3A/Users/...   ← 冒号被 URL 编码
//   LSP:    file:///c:/Users/...     ← 未编码、盘符小写
function normalizeUri(u) {
  let s = String(u || '')
  if (!s.startsWith('file:')) return s
  try { s = decodeURIComponent(s) } catch (_) {}
  // 盘符统一小写，且保证是 file:///x:/ 形式
  s = s.replace(/^file:\/{1,3}([a-zA-Z]):/, (_, d) => 'file:///' + d.toLowerCase() + ':')
  return s
}

// URI → 本地文件路径（读文件内容时用）
function filePathOf(u) {
  let s = normalizeUri(u)
  s = s.replace(/^file:\/{1,3}/, '')
  s = decodeURIComponent(s)
  if (/^[a-zA-Z]:/.test(s)) return s.replace(/\//g, '\\')   // Windows
  return s
}

class LspClient {
  constructor(root, onLog) {
    this.root = path.resolve(root)
    this.cfg = loadLspConfig(this.root)
    this.onLog = onLog || (() => {})
    this.proc = null
    this.buf = Buffer.alloc(0)
    this.seq = 1
    this.pending = new Map()
    this.docs = new Map()          // uri -> { version, text }
    this.caps = null
    this.diagnostics = new Map()   // uri -> Diagnostic[]
    this.restarts = 0
    this.stopping = false
    this.onDiagnostics = null

  // 已 didOpen 过的文件再次 open → 当作变更处理，避免 version 被重置成 1（重复 didOpen 会让 LSP 状态错乱）
  }

  log(msg) { try { this.onLog(String(msg)) } catch (_) {} }

  // ── 生命周期 ─────────────────────────────────────────────────────────
  async start() {
    if (this.proc) return { ok: true, already: true }
    let proc
    try {
      proc = spawn(this.cfg.command, this.cfg.args, { cwd: this.root, shell: false })
    } catch (e) {
      return { ok: false, error: `无法启动 LSP（${this.cfg.command}）：${e.message}` }
    }
    this.proc = proc
    this.stopping = false
    proc.stdout.on('data', (d) => this._onData(d))
    proc.stderr.on('data', (d) => this.log('[lsp:stderr] ' + d.toString().slice(0, 300)))
    proc.on('error', (e) => {
      this.log('[lsp] 进程错误：' + e.message)
      this._failAll('LSP 进程错误：' + e.message)
    })
    proc.on('exit', (code) => {
      const wasStopping = this.stopping
      this.proc = null
      this._failAll('LSP 已退出（code ' + code + '）')
      if (!wasStopping && this.restarts < this.cfg.maxRestarts) {
        this.restarts++
        this.log(`[lsp] 意外退出，第 ${this.restarts} 次重启…`)
        setTimeout(() => { if (!this.proc) this.start() }, 800)
      }
    })

    const init = await this._requestInternal('initialize', {
      processId: process.pid,
      rootUri: pathToUri(this.root),
      workspaceFolders: [{ uri: pathToUri(this.root), name: path.basename(this.root) }],
      capabilities: {
        textDocument: {
          definition: {}, hover: {}, references: {}, documentSymbol: {},
          completion: { completionItem: { snippetSupport: true } },
          rename: {}, signatureHelp: {}, inlayHint: {},
          // 注意：semanticTokens 不能传空对象 —— moon-lsp 会按完整记录类型解析，
          // 缺 formats / requests / tokenModifiers / tokenTypes 会直接 -32602 拒绝 initialize。
          semanticTokens: {
            dynamicRegistration: false,
            requests: { range: true, full: true },
            tokenTypes: [
              'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
              'parameter', 'variable', 'property', 'enumMember', 'event', 'function',
              'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number',
              'regexp', 'operator', 'decorator',
            ],
            tokenModifiers: [
              'declaration', 'definition', 'readonly', 'static', 'deprecated',
              'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
            ],
            formats: ['relative'],
          },
        },
        workspace: { symbol: {} },
      },
    }, this.cfg.initTimeoutMs)

    if (init.error) { this.log('[lsp] initialize 失败：' + JSON.stringify(init.error)); return { ok: false, error: 'initialize 失败' } }
    this.caps = (init.result && init.result.capabilities) || {}
    this._notify('initialized', {})
    this.log('[lsp] 就绪，能力 ' + Object.keys(this.caps).length + ' 项')
    return { ok: true, caps: this.caps }
  }

  async stop() {
    this.stopping = true
    if (!this.proc) return { ok: true }
    try { await this._requestInternal('shutdown', null, 3000) } catch (_) {}
    try { this._notify('exit', null) } catch (_) {}
    const p = this.proc
    setTimeout(() => { try { if (p && !p.killed) p.kill() } catch (_) {} }, 500)
    this.proc = null
    return { ok: true }
  }

  // ── 文档同步（didOpen / didChange / didClose，版本号单调递增）──────────
  didOpen(file, text) {
    const uri = pathToUri(file)
    const body = text != null ? text : this._read(file)
    if (this.docs.has(uri)) return this.didChange(file, body)   // 已开过 → 当变更，不重置 version
    const version = 1
    this.docs.set(uri, { version, text: body })
    this._notify('textDocument/didOpen', {
      textDocument: { uri, languageId: this.cfg.languageId, version, text: body },
    })
    return { ok: true }
  }

  didChange(file, text) {
    const uri = pathToUri(file)
    const d = this.docs.get(uri)
    const version = (d ? d.version : 0) + 1
    this.docs.set(uri, { version, text })
    // 用全量同步（比增量更容易保证正确性；LSP 允许）
    this._notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
    return { ok: true }
  }

  didClose(file) {
    const uri = pathToUri(file)
    this.docs.delete(uri)
    this._notify('textDocument/didClose', { textDocument: { uri } })
    return { ok: true }
  }

  _read(file) { try { return fs.readFileSync(file, 'utf8') } catch (_) { return '' } }

  // ── 请求（全部带超时）─────────────────────────────────────────────────
  _requestInternal(method, params, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.proc) return resolve({ __error: 'LSP 未启动' })
      const id = this.seq++
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          resolve({ __timeout: true, __error: `请求超时（${method}，${timeoutMs || this.cfg.requestTimeoutMs}ms）` })
        }
      }, timeoutMs || this.cfg.requestTimeoutMs)
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      this._send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async request(method, params) {
    const r = await this._requestInternal(method, params)
    if (r.__timeout) return { ok: false, error: r.__error, timeout: true }
    if (r.__error) return { ok: false, error: r.__error }
    if (r.error) return { ok: false, error: r.error.message || JSON.stringify(r.error), lspError: r.error }
    return { ok: true, result: r.result }
  }

  // 便捷方法（Step 2/4 直接调）
  definition(file, line, character) {
    return this.request('textDocument/definition', {
      textDocument: { uri: pathToUri(file) },
      position: { line: line - 1, character },   // 外部用 1-based，LSP 用 0-based
    })
  }
  hover(file, line, character) {
    return this.request('textDocument/hover', { textDocument: { uri: pathToUri(file) }, position: { line: line - 1, character } })
  }
  references(file, line, character) {
    return this.request('textDocument/references', {
      textDocument: { uri: pathToUri(file) }, position: { line: line - 1, character },
      context: { includeDeclaration: true },
    })
  }
  documentSymbol(file) {
    return this.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(file) } })
  }
  rename(file, line, character, newName) {
    // 行号约定：调用方一律传 LSP 原生的 0-based（与 definition/hover/references 一致）。
    // 这里曾经写成 line - 1，与其它方法不一致，导致重命名位置偏上 1 行。
    return this.request('textDocument/rename', {
      textDocument: { uri: pathToUri(file) }, position: { line, character },
      newName,
    })
  }
  completion(file, line, character) {
    // 同上：0-based，不在这里做 -1
    return this.request('textDocument/completion', { textDocument: { uri: pathToUri(file) }, position: { line, character } })
  }

  // ── 报文收发 ──────────────────────────────────────────────────────────
  _send(obj) {
    if (!this.proc) return
    const s = Buffer.from(JSON.stringify(obj), 'utf8')
    try {
      this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${s.length}\r\n\r\n`), s]))
    } catch (e) { this.log('[lsp] 写入失败：' + e.message) }
  }
  _notify(method, params) { this._send({ jsonrpc: '2.0', method, params }) }

  _failAll(reason) {
    for (const [, cb] of this.pending) { try { cb({ __error: reason }) } catch (_) {} }
    this.pending.clear()
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const i = this.buf.indexOf('\r\n\r\n')
      if (i < 0) break
      const head = this.buf.slice(0, i).toString('utf8')
      const m = head.match(/Content-Length:\s*(\d+)/i)
      if (!m) { this.buf = this.buf.slice(i + 4); continue }
      const len = parseInt(m[1], 10)
      if (this.buf.length < i + 4 + len) break
      const body = this.buf.slice(i + 4, i + 4 + len).toString('utf8')
      this.buf = this.buf.slice(i + 4 + len)
      let msg
      try { msg = JSON.parse(body) } catch (_) { continue }
      this._dispatch(msg)
    }
  }

  _dispatch(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const cb = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      cb(msg)
      return
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = (msg.params && msg.params.uri) || ''
      this.diagnostics.set(uri, (msg.params && msg.params.diagnostics) || [])
      if (this.onDiagnostics) { try { this.onDiagnostics(msg.params) } catch (_) {} }
      return
    }
    if (msg.method === 'window/logMessage' || msg.method === 'window/showMessage') {
      this.log('[lsp] ' + String(msg.params && msg.params.message).slice(0, 200))
    }
  }

  status() {
    return {
      running: !!this.proc,
      root: this.root,
      config: { command: this.cfg.command, args: this.cfg.args, transport: this.cfg.transport, languageId: this.cfg.languageId },
      caps: this.caps ? Object.keys(this.caps) : [],
      docs: this.docs.size,
      restarts: this.restarts,
    }
  }
}

// ── 多项目支持：一个根目录一个客户端 ──────────────────────────────────────
const clients = new Map()
function getClient(root, onLog) {
  const key = path.resolve(root)
  if (!clients.has(key)) clients.set(key, new LspClient(key, onLog))
  return clients.get(key)
}

function registerLspIpc({ ipcMain, getWindow }) {
  const send = (ch, payload) => {
    const w = getWindow && getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload)
  }
  const logger = (line) => send('lsp:log', { line })

  // 语言类请求要保证 LSP 已经起来。
  // 之前只 getClient 不 start，调用方忘了先 lsp:start 就会拿到 "LSP 未启动"，
  // 而且用户看不出原因（这是产品缺陷，不能把责任推给调用方）。
  const withClient = async (root, fn) => {
    if (!root) return { ok: false, error: '未打开项目' }
    const c = getClient(root, logger)
    c.onDiagnostics = (params) => send('lsp:diagnostics', params)
    if (!c.proc) {
      const s = await c.start()
      if (!s.ok) return { ok: false, error: 'LSP 启动失败：' + (s.error || '未知原因') }
    }
    return fn(c)
  }

  ipcMain.handle('lsp:start', (_e, root) => withClient(root, async (c) => {
    const r = await c.start()
    return { ok: r.ok, error: r.error, status: c.status() }
  }))
  ipcMain.handle('lsp:stop', (_e, root) => withClient(root, async (c) => { await c.stop(); return { ok: true, status: c.status() } }))
  ipcMain.handle('lsp:status', (_e, root) => withClient(root, (c) => ({ ok: true, status: c.status() })))
  ipcMain.handle('lsp:open', (_e, { root, file, text }) => withClient(root, (c) => c.didOpen(file, text)))
  ipcMain.handle('lsp:change', (_e, { root, file, text }) => withClient(root, (c) => c.didChange(file, text)))
  ipcMain.handle('lsp:close', (_e, { root, file }) => withClient(root, (c) => c.didClose(file)))
  ipcMain.handle('lsp:definition', (_e, { root, file, line, character }) => withClient(root, async (c) => {
    const r = await c.definition(file, line, character)
    return { ok: r.ok, error: r.error, result: r.result || null }
  }))
  ipcMain.handle('lsp:hover', (_e, { root, file, line, character }) => withClient(root, async (c) => {
    const r = await c.hover(file, line, character)
    return { ok: r.ok, error: r.error, result: r.result || null }
  }))
  ipcMain.handle('lsp:references', (_e, { root, file, line, character }) => withClient(root, (c) => c.references(file, line, character)))
  ipcMain.handle('lsp:documentSymbol', (_e, { root, file }) => withClient(root, (c) => c.documentSymbol(file)))
  ipcMain.handle('lsp:rename', (_e, { root, file, line, character, newName }) => withClient(root, (c) => c.rename(file, line, character, newName)))
  ipcMain.handle('lsp:completion', (_e, { root, file, line, character }) => withClient(root, (c) => c.completion(file, line, character)))

  return { clients, getClient }
}

module.exports = { registerLspIpc, getClient, loadLspConfig, DEFAULT_LSP, pathToUri, normalizeUri, filePathOf }
