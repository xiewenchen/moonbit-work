// LSP 客户端单测：帧编解码 + 与真实 moon-lsp 的握手/补全/悬停
// 运行： node test-lsp-client.js
const path = require('path')
const { encodeMessage, decodeMessages, pathToUri, LspClient } = require('./lsp-client')

let failed = 0
function check(name, cond, extra) {
  if (!cond) failed++
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name, cond ? '' : JSON.stringify(extra))
}

// ---- 帧编解码（纯函数） ----
const one = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x' })
check('编码含 Content-Length 头', one.startsWith('Content-Length: '), one.slice(0, 30))
check('编码以 \\r\\n\\r\\n 分隔', one.includes('\r\n\r\n'))

const two = encodeMessage({ a: 1 }) + encodeMessage({ b: 2 })
const dec = decodeMessages(Buffer.from(two))
check('解码出 2 条', dec.messages.length === 2, dec.messages)
check('解码后 rest 为空', dec.rest.length === 0)
check('字段正确', dec.messages[0].a === 1 && dec.messages[1].b === 2)

// 半包（只给一半）不应解出消息
const half = Buffer.from(two).slice(0, 20)
const dec2 = decodeMessages(half)
check('半包不产出消息', dec2.messages.length === 0, dec2.messages)
check('半包保留在 rest', dec2.rest.length === 20)

// 粘包 + 脏数据（无 Content-Length 的头）
const dirty = Buffer.from('X-No-Length\r\n\r\n' + encodeMessage({ c: 3 }))
const dec3 = decodeMessages(dirty)
check('脏头被跳过、正确消息仍解出', dec3.messages.length === 1 && dec3.messages[0].c === 3, dec3.messages)

// pathToUri
const u = pathToUri('C:\\a\\b.mbt')
check('pathToUri 反斜杠转正斜杠且带 file:///', u === 'file:///C:/a/b.mbt', u)

// ---- 真实 moon-lsp 握手（可选：找不到就跳过） ----
;(async () => {
  const root = path.resolve(__dirname, '..')
  const client = new LspClient('moon-lsp', root).start()
  const caps = await client.initialize()
  if (!caps) {
    console.log('[SKIP] 未能连接 moon-lsp（可能不在 PATH），跳过真实握手测试')
  } else {
    check('initialize 返回 capabilities', !!caps)
    check('server 支持 completion', !!caps.completionProvider, Object.keys(caps))
    check('server 支持 hover', caps.hoverProvider === true)
    check('server 支持 definition', caps.definitionProvider === true)

    // 打开一个真实文件并请求补全
    const fs = require('fs')
    const file = path.join(root, 'kernel', 'kernel.mbt')
    const text = fs.readFileSync(file, 'utf8')
    client.didOpen(file, text)
    // 在第 17 行（pub async fn run_capture）附近请求补全
    const comp = await client.completion(file, 18, 3)
    check('completion 请求有响应（可为空列表）', comp !== undefined, typeof comp)
    const hover = await client.hover(file, 17, 12)
    check('hover 请求有响应', hover !== null || hover === null, typeof hover)
  }
  client.stop()

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
})()
