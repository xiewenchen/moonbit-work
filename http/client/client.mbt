///|
/// 未消费缓冲的上限：防止对端持续发送导致内存无界增长（连接不可信端点时的内存 DoS）。
const MAX_PENDING_BYTES : Int = 8388608

///|
/// 极简 HTTP/1.1 客户端（纯 MoonBit，基于 `moonbitlang/async` 的 socket）。
///
/// 报文解析复用 `mbp/platform/http`，仅 native 后端。

///|
/// 一个 HTTP 连接（支持 keep-alive 复用）。
pub struct Client {
  tcp : @socket.Tcp
  host : String
  /// 已从 socket 读入但尚未消费的字节。
  /// keep-alive 复用必须保留（一次 read 可能含多个响应）。
  mut pending : Bytes
}

///|
/// 连接到 `host:port`。
pub async fn Client::connect(host : String, port : Int) -> Client {
  let tcp = @socket.Tcp::connect_to_host(host, port~)
  { tcp, host, pending: @utf8.encode(""), }
}

///|
pub fn Client::close(self : Client) -> Unit {
  self.tcp.close()
}

///|
/// 发送请求并读取响应；自动补 `Host` 与 `Connection: keep-alive`。
pub async fn Client::send(self : Client, req : @http.Request) -> @http.Response {
  match req.header("host") {
    None => req.headers.push(("Host", self.host))
    Some(_) => ()
  }
  // 只在缺失时补，避免同一 request 重复 send 导致 header 累加
  match req.header("connection") {
    None => req.headers.push(("Connection", "keep-alive"))
    Some(_) => ()
  }
  write_all(self.tcp, req.to_bytes())
  self.read_response()
}

///|
/// 便捷 `GET`。
pub async fn Client::get(self : Client, path : String) -> @http.Response {
  self.send(@http.Request::new(@http.Method::Get, path))
}

///|
/// 便捷 `POST`（字符串体）。
pub async fn Client::post(
  self : Client,
  path : String,
  content_type : String,
  body : String,
) -> @http.Response {
  let req = @http.Request::new(@http.Method::Post, path)
  req.headers.push(("Content-Type", content_type))
  req.body = @utf8.encode(body)
  self.send(req)
}

///|
async fn Client::read_response(self : Client) -> @http.Response {
  while true {
    let outcome : (@http.Response, Int)? = try
      @http.Response::parse(self.pending, 0)
    catch {
      @http.UnexpectedEof(_) => None
      @http.Malformed(m) => fail("malformed response: \{m}")
      @http.PayloadTooLarge(m) => fail("response too large: \{m}")
    } noraise {
      pair => Some(pair)
    }
    match outcome {
      Some((r, consumed)) => {
        // 关键：保留未消费字节，它们可能已经是下一个响应（TCP 粘包）
        self.pending = self.pending.clamped_view(start=consumed).to_owned()
        return r
      }
      None =>
        match self.tcp.read_some() {
          Some(c) =>
            if c.length() > 0 {
              if self.pending.length() + c.length() > MAX_PENDING_BYTES {
                fail(
                  "response header/buffer exceeds \{MAX_PENDING_BYTES} bytes",
                )
              }
              let joined = Buffer()
              joined.write_bytes(self.pending)
              joined.write_bytes(c)
              self.pending = joined.to_bytes()
            } else {
              fail("connection closed before response")
            }
          None => fail("connection closed before response")
        }
    }
  }
  fail("unreachable: read_response loop exited")
}

///|
async fn write_all(w : &@io.Writer, data : Bytes) -> Unit {
  let n = data.length()
  let mut off = 0
  while off < n {
    let written = w.write_once(data, offset=off, len=n - off)
    if written <= 0 {
      fail("socket write returned \{written}")
    }
    off = off + written
  }
}
