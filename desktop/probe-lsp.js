// probe-lsp.js —— 验证 moon-lsp 到底能不能正常应答
//
// 为什么必须有这一步：moon-lsp.exe 一直在 ~/.moon/bin 里，但它「存在」不等于「能用」。
// 早前试过 hover / definition 返回 null、moon ide peek-def 报 "could not get package of loc"，
// 当时才绕道去解析 symbols.jsonl 做补全。现在要接 LSP，就得先用最小客户端问清楚。
//
// 只做只读探测：initialize → didOpen → definition / hover / references / documentSymbol
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')

const LSP = path.join(os.homedir(), '.moon', 'bin', 'moon-lsp.exe')
const root = path.resolve('..')
// 挑一个真实且一定有符号的文件（parse_hex_size 之类的函数）
const target = path.join(root, 'http', 'http.mbt')

console.log('LSP  :', LSP, fs.existsSync(LSP) ? '(存在)' : '(不存在!)')
console.log('root :', root)
console.log('file :', target, fs.existsSync(target) ? '(存在)' : '(不存在!)')

const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
const lines = text.split('\n')
// 找 "fn " 的定义行，作为 definition 的探测点
let probeLine = 0
let probeChar = 0
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/)
  if (m) { probeLine = i; probeChar = lines[i].indexOf(m[1]); break }
}
console.log(`探测点: 第 ${probeLine + 1} 行 列 ${probeChar}  →  ${(lines[probeLine] || '').trim().slice(0, 70)}`)

const proc = spawn(LSP, ['--stdio'], { cwd: root, shell: false })
let buf = Buffer.alloc(0)
const pending = new Map()
let nextId = 1

const send = (obj) => {
  const s = Buffer.from(JSON.stringify(obj), 'utf8')
  proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${s.length}\r\n\r\n`), s]))
}
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }) } }, 20000)
})
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

function onMsg(msg) {
  if (msg.id && pending.has(msg.id)) {
    const r = pending.get(msg.id)
    pending.delete(msg.id)
    r(msg)
  } else if (msg.method === 'window/logMessage' || msg.method === 'window/showMessage') {
    console.log('  [lsp ' + msg.params.type + '] ' + String(msg.params.message).slice(0, 160))
  }
}

proc.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  for (;;) {
    const i = buf.indexOf('\r\n\r\n')
    if (i < 0) break
    const m = buf.slice(0, i).toString('utf8').match(/Content-Length:\s*(\d+)/i)
    if (!m) { buf = buf.slice(i + 4); continue }
    const len = parseInt(m[1], 10)
    if (buf.length < i + 4 + len) break
    const body = buf.slice(i + 4, i + 4 + len).toString('utf8')
    buf = buf.slice(i + 4 + len)
    try { onMsg(JSON.parse(body)) } catch (_) {}
  }
})
proc.stderr.on('data', (d) => console.log('  [stderr] ' + d.toString().slice(0, 200)))

const uri = 'file:///' + target.replace(/\\/g, '/').replace(/^\//, '')

;(async () => {
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: 'file:///' + root.replace(/\\/g, '/').replace(/^\//, ''),
    capabilities: {
      textDocument: { definition: {}, hover: {}, references: {}, documentSymbol: {}, completion: {} },
    },
    workspaceFolders: [{ uri: 'file:///' + root.replace(/\\/g, '/').replace(/^\//, ''), name: path.basename(root) }],
  })
  if (init.__timeout) { console.log('\n① initialize → 超时无响应 ❌'); proc.kill(); process.exit(0) }
  const caps = init.result && init.result.capabilities
  console.log('\n① initialize →', caps ? '有 capabilities ✅' : '无 capabilities ❌')
  console.log('    声明支持:', caps ? Object.keys(caps).join(', ') : '(无)')
  if (init.error) console.log('    错误:', JSON.stringify(init.error))
  notify('initialized', {})
  notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'moonbit', version: 1, text },
  })

  const at = { line: probeLine, character: probeChar }
  const test = async (name, method, params) => {
    const r = await request(method, params)
    if (r.__timeout) return console.log(`② ${name} → 超时 ❌`)
    const res = r.result
    let verdict = 'null/空 ❌'
    let detail = ''
    if (Array.isArray(res) && res.length) { verdict = `${res.length} 条 ✅`; detail = JSON.stringify(res[0]).slice(0, 120) }
    else if (res && res.uri) { verdict = 'Location ✅'; detail = JSON.stringify(res).slice(0, 120) }
    else if (res && res.contents) { verdict = '有内容 ✅'; detail = JSON.stringify(res).slice(0, 120) }
    else if (res && res.length === 0) { verdict = '空数组 ❌' }
    else if (res) { verdict = '有返回'; detail = JSON.stringify(res).slice(0, 120) }
    if (r.error) { verdict = '报错 ❌'; detail = JSON.stringify(r.error).slice(0, 140) }
    console.log(`② ${name} → ${verdict}  ${detail}`)
  }

  await test('definition', 'textDocument/definition', { textDocument: { uri }, position: at })
  await test('hover', 'textDocument/hover', { textDocument: { uri }, position: at })
  await test('references', 'textDocument/references', { textDocument: { uri }, position: at, context: { includeDeclaration: true } })
  await test('documentSymbol', 'textDocument/documentSymbol', { textDocument: { uri } })

  await new Promise((r) => setTimeout(r, 1500))
  try { proc.kill() } catch (_) {}
  setTimeout(() => process.exit(0), 500)
})()
