///|
/// 预置 Demo 项目（手册 6.2）
///
/// 一个**编译到 JS 的 MoonBit HTTP 服务**：请求进来后由 MoonBit 组装 JSON 响应，
/// 只有"监听端口 / 收发 HTTP"这类动作通过 FFI 下到 Node。
///
/// 跑起来：
///   moon run ide-backend/demo --target js            # 默认 8099
///   curl http://127.0.0.1:8099/api/hello
///   curl http://127.0.0.1:8099/api/sum?a=3&b=4
///
/// 这也是"演示诊断"的载体：文件末尾有一段**注释掉的语法错误**，
/// 把它取消注释，IDE 的诊断面板就会出现报错并可点击跳转。

///|
/// 起 HTTP 服务：`handler(method, path, query)` 返回响应体，逻辑留在 MoonBit。
extern "js" fn serve(
  port : Int,
  handler : (String, String, String) -> String,
) -> Unit = "(port, handler) => { const http = require('http'); const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://127.0.0.1'); let status = 200; let body = ''; try { const r = JSON.parse(handler(req.method, u.pathname, u.search)); status = typeof r.status === 'number' ? r.status : 200; body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body) } catch (e) { status = 500; body = JSON.stringify({ error: String(e && e.message || e) }) } res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body) }); srv.listen(port, () => { process.stdout.write('demo listening on http://127.0.0.1:' + port + '\\n') }) }"

///|
/// JSON 字符串转义。
fn esc(s : String) -> String {
  let buf = Buffer()
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some('"') => buf.write_string_utf8("\\\"")
      Some('\\') => buf.write_string_utf8("\\\\")
      Some('\n') => buf.write_string_utf8("\\n")
      Some(c) =>
        if c.to_int() < 32 {
          buf.write_string_utf8(" ")
        } else {
          buf.write_string_utf8(c.to_string())
        }
      None => ()
    }
  }
  @utf8.decode_lossy(buf.to_bytes())
}

///|
/// 从 query（形如 `?a=3&b=4`）里取一个参数值。
fn query_get(query : String, key : String) -> String? {
  let q = if query.has_prefix("?") { query[1:].to_owned() } else { query }
  for part in q.split("&") {
    match part.split_once("=") {
      Some((k, v)) =>
        if k == key {
          return Some(v.to_owned())
        }
      None => ()
    }
  }
  None
}

///|
/// 解析非负整数（简单版）。
fn parse_int(s : String) -> Int? {
  if s == "" {
    return None
  }
  let mut n = 0
  let mut neg = false
  let mut i = 0
  if s.get_char(0) is Some('-') {
    neg = true
    i = 1
  }
  while i < s.length() {
    match s.get_char(i) {
      Some(c) =>
        if c >= '0' && c <= '9' {
          n = n * 10 + (c.to_int() - '0'.to_int())
        } else {
          return None
        }
      None => return None
    }
    i = i + 1
  }
  if neg {
    Some(-n)
  } else {
    Some(n)
  }
}

///|
/// 组装 `{status, body}`（body 是已拼好的 JSON 文本，直接嵌入）。
/// 状态码必须由这里决定 —— 早先只有 body、状态码在 FFI 里写死 200，
/// 结果 404 分支回了 200。
fn ok(body : String) -> String {
  "{\"status\":200,\"body\":" + body + "}"
}

///|
/// 带非 200 状态码的响应。
fn fail(status : Int, body : String) -> String {
  "{\"status\":" + status.to_string() + ",\"body\":" + body + "}"
}

///|
/// 路由 + 响应组装（纯 MoonBit 逻辑）。
fn handle(meth : String, path : String, query : String) -> String {
  if path == "/api/hello" {
    ok(
      "{\"message\":\"hello from MoonBit\",\"method\":\"" +
      esc(meth) +
      "\",\"ok\":true}",
    )
  } else if path == "/api/sum" {
    let a = match query_get(query, "a") {
      Some(v) =>
        match parse_int(v) {
          Some(n) => n
          None => 0
        }
      None => 0
    }
    let b = match query_get(query, "b") {
      Some(v) =>
        match parse_int(v) {
          Some(n) => n
          None => 0
        }
      None => 0
    }
    ok("{\"a\":" + a.to_string() + ",\"b\":" + b.to_string() + ",\"sum\":" + (a + b).to_string() + "}")
  } else if path == "/api/echo" {
    // 把 query 原样回显，便于演示"请求确实到了后端"
    ok("{\"path\":\"" + esc(path) + "\",\"query\":\"" + esc(query) + "\"}")
  } else {
    // 真正回 404（而不是只在 body 里写 not found）
    fail(404, "{\"error\":\"not found\",\"path\":\"" + esc(path) + "\"}")
  }
}

///|
fn main {
  serve(8099, handle)
}

// ---------------------------------------------------------------------------
// 演示用：下面这行**故意是语法错误**（少了一个右花括号）。
// 取消注释后，IDE 的诊断面板会出现报错、可点击跳到这一行 ——
// 手册 6.2 要求预置项目里留一处这样的错误用于演示。
//
// pub fn broken_demo() -> Int {
//   let x = 1 + 2
//   x
//
