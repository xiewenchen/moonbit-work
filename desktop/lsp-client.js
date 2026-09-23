// 轻量 LSP 客户端：与 `moon-lsp` 通过 stdio 上的 LSP 帧（JSON-RPC + Content-Length）通信。
//
// 编解码是纯函数（可单测）；LspClient 负责进程与请求/响应配对。
const { spawn } = require('child_process')

// ---- 帧编解码（纯函数，单测友好） ----

function encodeMessage(obj) {
  const s = JSON.stringify(obj)
  return 'Content-Length: ' + Buffer.byteLength(s, 'utf8') + '\r\n\r\n' + s
}

// 从累积缓冲里尽可能取出完整消息： { messages: Array, rest: Buffer }
function decodeMessages(buf) {
  const messages = []
  let b = buf
  for (;;) {
    const sep = b.indexOf('\r\n\r\n')
    if (sep < 0) break
    const header = b.slice(0, sep).toString('utf8')
    const m = header.match(/Content-Length:\s*(\d+)/i)
    if (!m) {
      // 头部不含长度：丢弃这段，避免死循环
      b = b.slice(sep + 4)
      continue
    }
    const len = parseInt(m[1], 10)
    if (b.length < sep + 4 + len) break
    const body = b.slice(sep + 4, sep + 4 + len).toString('utf8')
    b = b.slice(sep + 4 + len)
    try {
      messages.push(JSON.parse(body))
    } catch (_) {
      /* 跳过非法 JSON */
    }
  }
  return { messages, rest: b }
}

// 本地路径 → file:// URI（Windows 下形如 file:///C:/a/b）
function pathToUri(p) {
  let s = String(p).replace(/\\/g, '/')
  if (!s.startsWith('/')) s = '/' + s
  return 'file://' + s
}

// ---- 客户端 ----

class LspClient {
  constructor(bin, rootPath, opts = {}) {
    this.bin = bin
    this.rootPath = rootPath
    this.timeoutMs = opts.timeoutMs || 15000
    this.proc = null
    this.buf = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map() // id -> { resolve, reject, timer }
    this.opened = new Set() // 已 didOpen 的文件 uri
    this.ready = false
    this.serverCaps = null
    this.onError = opts.onError || (() => {})
  }

  start() {
    this.proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.on('error', (e) => {
      this.onError('无法启动 LSP: ' + e.message)
    })
    this.proc.stderr.on('data', (d) => {
      // moon-lsp 的日志不影响协议
      void d
    })
    this.proc.stdout.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d])
      const { messages, rest } = decodeMessages(this.buf)
      this.buf = rest
      for (const msg of messages) this._onMessage(msg)
    })
    return this
  }

  _onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.resolve(null)
      else p.resolve(msg.result)
      return
    }
    // 服务器主动请求（如 workspace/configuration）→ 简单回空
    if (msg.method && msg.id !== undefined) {
      this._send({ jsonrpc: '2.0', id: msg.id, result: null })
    }
  }

  _send(obj) {
    if (!this.proc) return
    try {
      this.proc.stdin.write(encodeMessage(obj))
    } catch (_) {
      /* ignore */
    }
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, this.timeoutMs)
      this.pending.set(id, { resolve, timer })
      this._send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params })
  }

  async initialize() {
    const rootUri = pathToUri(this.rootPath)
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
          documentSymbol: {},
        },
      },
    })
    this.serverCaps = result ? result.capabilities : null
    this.notify('initialized', {})
    this.ready = true
    return this.serverCaps
  }

  didOpen(file, text, languageId = 'moonbit') {
    const uri = pathToUri(file)
    if (this.opened.has(uri)) {
      this.didChange(file, text)
      return
    }
    this.opened.add(uri)
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    })
  }

  didChange(file, text) {
    const uri = pathToUri(file)
    if (!this.opened.has(uri)) {
      this.didOpen(file, text)
      return
    }
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: Date.now() % 100000 },
      contentChanges: [{ text }],
    })
  }

  didClose(file) {
    const uri = pathToUri(file)
    if (!this.opened.has(uri)) return
    this.opened.delete(uri)
    this.notify('textDocument/didClose', { textDocument: { uri } })
  }

  completion(file, line, character) {
    return this.request('textDocument/completion', {
      textDocument: { uri: pathToUri(file) },
      position: { line: line - 1, character: character - 1 },
    })
  }

  hover(file, line, character) {
    return this.request('textDocument/hover', {
      textDocument: { uri: pathToUri(file) },
      position: { line: line - 1, character: character - 1 },
    })
  }

  definition(file, line, character) {
    return this.request('textDocument/definition', {
      textDocument: { uri: pathToUri(file) },
      position: { line: line - 1, character: character - 1 },
    })
  }

  documentSymbol(file) {
    return this.request('textDocument/documentSymbol', {
      textDocument: { uri: pathToUri(file) },
    })
  }

  stop() {
    try {
      this.notify('shutdown', null)
      this.notify('exit', null)
    } catch (_) {
      /* ignore */
    }
    for (const [, p] of this.pending) clearTimeout(p.timer)
    this.pending.clear()
    if (this.proc) {
      try {
        this.proc.kill()
      } catch (_) {
        /* ignore */
      }
      this.proc = null
    }
  }
}

module.exports = { encodeMessage, decodeMessages, pathToUri, LspClient }
