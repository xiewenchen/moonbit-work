///|
/// IDE 后端服务的入口（编译到 JS，跑在 Node 上）。
///
/// 对应手册 0.4：**用 MoonBit 写后端**，通过 FFI 调 Node 起服务，
/// 收到 JSON-RPC 请求后交给 MoonBit 侧的分发逻辑（`@backend.handle_line`）处理。
///
/// 运行方式：
///   moon build ide-backend/cmd/main --target js
///   node _build/js/debug/build/ide-backend/cmd/main/main.js            # 自检
///   node _build/js/debug/build/ide-backend/cmd/main/main.js --serve 8088   # 起 RPC 服务
///
/// 这里是"最小可行验证"：先证明 **MoonBit 写后端 + FFI 调 Node + RPC 分发** 这条链路成立。

///|
/// 起一个 HTTP 版 JSON-RPC 服务。
///
/// 之所以先做 HTTP 而不是 WebSocket：WebSocket 需要 Node 的 `ws` 包（要 npm install），
/// 而 HTTP 用 Node 内置模块即可 —— 先把"MoonBit 后端 + FFI + RPC"这条链路验证通。
/// `handler` 是 MoonBit 侧的函数，被 FFI 反向回调 ——
/// 这正是"逻辑留在 MoonBit、只有碰系统的动作下到 Node"的形态。
extern "js" fn serve_http(
  port : Int,
  handler : (String) -> String,
) -> Unit = "(port, handler) => { const http = require('http'); const srv = http.createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => { let out; try { out = handler(body) } catch (e) { out = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e && e.message || e) } }) } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out) }) }); srv.listen(port, () => { process.stdout.write('[ide-backend] JSON-RPC listening on http://127.0.0.1:' + port + '\\n') }) }"

///|
/// 读命令行参数（Node 侧）。
extern "js" fn argv_js() -> String = "() => JSON.stringify(process.argv.slice(2))"

///|
/// 简单的十进制解析（只用于端口号）。
fn parse_port(s : String) -> Int? {
  if s == "" {
    return None
  }
  let mut n = 0
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some(c) =>
        if c >= '0' && c <= '9' {
          n = n * 10 + (c.to_int() - '0'.to_int())
        } else {
          return None
        }
      None => return None
    }
  }
  Some(n)
}

///|
/// 把 `["--serve","8088"]` 这种 JSON 数组切成字符串数组（够用即可）。
fn split_args(s : String) -> Array[String] {
  let out : Array[String] = []
  let buf = Buffer()
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some('"') => ()
      Some(',') => {
        out.push(@utf8.decode_lossy(buf.to_bytes()))
        buf.reset()
      }
      Some('[') => ()
      Some(']') => ()
      Some(c) => buf.write_string_utf8(c.to_string())
      None => ()
    }
  }
  let last = @utf8.decode_lossy(buf.to_bytes())
  if last != "" {
    out.push(last)
  }
  out
}

///|
fn main {
  let args = split_args(argv_js())
  // 找 --serve 与紧随其后的端口
  let mut serve = false
  let mut port = 8088
  let mut i = 0
  while i < args.length() {
    if args[i] == "--serve" {
      serve = true
      if i + 1 < args.length() {
        match parse_port(args[i + 1]) {
          Some(v) => port = v
          None => ()
        }
      }
    }
    i = i + 1
  }
  if serve {
    serve_http(port, @backend.handle_line)
  } else {
    @backend.println_js(@backend.self_check())
  }
}
