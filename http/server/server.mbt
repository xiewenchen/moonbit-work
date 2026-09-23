///|
/// 极简 HTTP 服务端 + 路由（纯 MoonBit，基于 `moonbitlang/async` 的 socket）。
///
/// 生产加固：读/空闲超时、请求体与请求头大小上限、优雅关闭（SIGINT/SIGTERM）。

///|
/// 请求处理器：异步函数，接收请求返回响应。
pub type Handler = async (@http.Request) -> @http.Response

///|
/// 中间件：接收请求与 `next`，可做前后置处理（日志、鉴权、限流…）。
pub type Middleware = async (@http.Request, async () -> @http.Response) -> @http.Response

///|
/// 服务端限制与超时（生产防护）。
pub(all) struct ServerLimits {
  /// 单个请求的处理超时（毫秒）
  read_timeout_ms : Int
  /// keep-alive 空闲超时（毫秒）
  idle_timeout_ms : Int
  /// 请求头最大字节数
  max_header_bytes : Int
  /// 请求体最大字节数
  max_body_bytes : Int
  /// 并发连接上限：超出后新连接会被直接关闭（防连接洪泛耗尽 fd/内存）
  max_connections : Int
} derive(Debug)

///|
/// 默认限额。
///
/// `max_connections` 的取值来自**实测标定**而非拍脑袋：
/// 单实例加压测试显示并发 32 时吞吐达峰（约 1225 req/s），
/// 再往上 QPS 反而下降而延迟线性上升 —— 允许过多连接排队只会伤害尾延迟。
/// 默认取峰值的 2 倍作为缓冲。
///
/// 进程内的服务端是单线程协作式，所以这个上限同时就是「同时可处理的请求数」。
pub fn ServerLimits::default() -> ServerLimits {
  {
    read_timeout_ms: 15000,
    idle_timeout_ms: 30000,
    max_header_bytes: 65536,
    max_body_bytes: 8388608,
    max_connections: 64,
  }
}

///|
/// 路由器：把 `(方法, 路径模式)` 映射到处理器，支持 `/users/:id` 形式的参数。
pub struct Router {
  middlewares : Array[Middleware]
  routes : Array[(@http.Method, String, Handler)]
}

///|
pub fn Router::new() -> Router {
  { middlewares: [], routes: [], }
}

///|
/// 追加一个中间件（按注册顺序执行）。
pub fn Router::add_middleware(self : Router, mw : Middleware) -> Unit {
  self.middlewares.push(mw)
}

///|
/// 注册一条路由。
pub fn Router::add(
  self : Router,
  verb : @http.Method,
  path : String,
  handler : Handler,
) -> Unit {
  self.routes.push((verb, path, handler))
}

///|
/// 注册 `GET` 路由。
pub fn Router::get(self : Router, path : String, handler : Handler) -> Unit {
  self.add(@http.Method::Get, path, handler)
}

///|
/// 注册 `POST` 路由。
pub fn Router::post(self : Router, path : String, handler : Handler) -> Unit {
  self.add(@http.Method::Post, path, handler)
}

///|
/// 取出 target 的路径部分（去掉 `?query`）。
fn path_of(target : String) -> String {
  match target.split_once("?") {
    Some((p, _)) => p.to_owned()
    None => target
  }
}

///|
/// 把路径按 `/` 切成非空段。
fn split_path(path : String) -> Array[String] {
  let out : Array[String] = []
  for seg in path.split("/") {
    let s = seg.to_owned()
    if s != "" {
      out.push(s)
    }
  }
  out
}

///|
/// 把路径段匹配到模式段；`:` 开头的段是参数。成功返回捕获的参数。
fn match_segments(
  pattern : Array[String],
  path : Array[String],
) -> Array[(String, String)]? {
  if pattern.length() != path.length() {
    return None
  }
  let params : Array[(String, String)] = []
  for i = 0; i < pattern.length(); i = i + 1 {
    let p = pattern[i]
    if p.get_char(0) == Some(':') {
      params.push((p[1:].to_owned(), path[i]))
    } else if p != path[i] {
      return None
    }
  }
  Some(params)
}

///|
/// 处理一个请求：依次经过中间件，最后匹配路由（未命中返回 404）。
pub async fn Router::handle(
  self : Router,
  req : @http.Request,
) -> @http.Response {
  self.run_middleware(req, 0)
}

///|
/// 执行第 `i` 个中间件，`next` 指向后续链尾（最终 dispatch）。
async fn Router::run_middleware(
  self : Router,
  req : @http.Request,
  i : Int,
) -> @http.Response {
  if i >= self.middlewares.length() {
    self.dispatch(req)
  } else {
    let mw = self.middlewares[i]
    mw(req, async fn() { self.run_middleware(req, i + 1) })
  }
}

///|
/// 真正匹配路由并调用处理器。
async fn Router::dispatch(self : Router, req : @http.Request) -> @http.Response {
  // 路径段必须做 percent-decode：否则含中文/空格的路径参数（如文章 slug）
  // 会以「编码形式」进入 handler，与数据库里存的原始值对不上 ——
  // 实测中文 slug 会 100% 返回 404。
  //
  // 注意 `plus_as_space=false`：在**路径**中 `+` 是字面加号，
  // 只有 query string 里 `+` 才表示空格。
  let path_segs = split_path(path_of(req.target)).map(fn(s) {
    @http.percent_decode(s, plus_as_space=false)
  })
  for r in self.routes {
    let (verb, pattern, handler) = r
    if verb == req.verb {
      match match_segments(split_path(pattern), path_segs) {
        Some(params) => {
          req.params = params
          return try handler(req) catch {
            e => {
              // 可观测性：静默吞掉异常会让线上故障无从排查
              println("[app] handler error on \{req.target}: \{e}")
              @http.Response::json(500, "{\"error\":\"internal server error\"}")
            }
          } noraise {
            resp => resp
          }
        }
        None => ()
      }
    }
  }
  @http.Response::text(404, "Not Found")
}

// ---------------------------------------------------------------------------
// 连接处理
// ---------------------------------------------------------------------------

///|
/// 内部：请求处理失败，带 HTTP 状态码。
priv suberror RequestFailed {
  RequestFailed(Int, String)
}

///|
/// 内部：对端关闭连接。
priv suberror ConnClosed {
  ConnClosed
}

///|
/// 把 `data` 全部写入 writer（处理部分写）。
async fn[W : @io.Writer] write_all(w : W, data : Bytes) -> Unit {
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

///|
/// 根据头部决定如何取 body：chunked（`Transfer-Encoding`）或 `Content-Length`。
fn take_body(
  data : Bytes,
  header_end : Int,
  req : @http.Request,
  limits : ServerLimits,
) -> (Bytes, Int)? raise {
  let chunked = match req.header("transfer-encoding") {
    Some(v) => v.to_lower().contains("chunked")
    None => false
  }
  if chunked {
    @http.decode_chunked(data, header_end, limits.max_body_bytes)
  } else {
    @http.body_for_length(data, header_end, req.headers, limits.max_body_bytes)
  }
}

///|
/// 读取一个请求（受大小上限约束，支持 chunked）；对端关闭时抛 `ConnClosed`。
async fn[IO : @io.Reader] read_request(
  io : IO,
  buf : Buffer,
  limits : ServerLimits,
) -> @http.Request {
  buf.reset()
  while true {
    let data = buf.to_bytes()
    let head : (@http.Request, Int)? = try
      @http.Request::parse_head(data, 0)
    catch {
      @http.UnexpectedEof(_) => None
      @http.Malformed(m) => raise RequestFailed(400, m)
      @http.PayloadTooLarge(m) => raise RequestFailed(413, m)
    } noraise {
      v => Some(v)
    }
    match head {
      None => {
        if data.length() > limits.max_header_bytes {
          raise RequestFailed(431, "request headers too large")
        }
        match io.read_some() {
          Some(chunk) =>
            if chunk.length() > 0 {
              buf.write_bytes(chunk)
            } else {
              raise ConnClosed
            }
          None => raise ConnClosed
        }
      }
      Some((req, header_end)) => {
        if header_end > limits.max_header_bytes {
          raise RequestFailed(431, "request headers too large")
        }
        let body : (Bytes, Int)? = try
          take_body(data, header_end, req, limits)
        catch {
          @http.PayloadTooLarge(m) => raise RequestFailed(413, m)
          @http.Malformed(m) => raise RequestFailed(400, m)
          @http.UnexpectedEof(_) => None
          _ => None
        } noraise {
          v => v
        }
        match body {
          Some((b, _)) => {
            req.body = b
            return req
          }
          None =>
            match io.read_some() {
              Some(chunk) =>
                if chunk.length() > 0 {
                  buf.write_bytes(chunk)
                } else {
                  raise ConnClosed
                }
              None => raise ConnClosed
            }
        }
      }
    }
  }
  raise ConnClosed
}

///|
/// 处理一条 TCP 连接（关闭由本函数负责）。
pub async fn serve_connection(
  router : Router,
  tcp : @socket.Tcp,
  remote_addr? : String = "",
  limits? : ServerLimits = ServerLimits::default(),
) -> Unit {
  defer tcp.close()
  serve_connection_with(router, tcp, remote_addr~, limits~)
}

///|
/// 在任意 Reader+Writer 上跑 keep-alive 循环（不负责 close；TLS 连接用这个）。
pub async fn[IO : @io.Reader + @io.Writer] serve_connection_with(
  router : Router,
  io : IO,
  remote_addr? : String = "",
  limits? : ServerLimits = ServerLimits::default(),
) -> Unit {
  let buf = Buffer()
  let mut keep_going = true
  // 单连接最多服务多少个请求（防单连接无限复用/长期占用槽位）
  let max_requests = 1000
  let mut served = 0
  while keep_going && served < max_requests {
    served = served + 1
    let got : @http.Request? = try
      @async.with_timeout_opt(limits.idle_timeout_ms, async fn() {
        read_request(io, buf, limits)
      })
    catch {
      RequestFailed(status, msg) => {
        write_all(io, @http.Response::text(status, msg).to_bytes())
        None
      }
      _ => None
    } noraise {
      r => r
    }
    match got {
      None => keep_going = false
      Some(r) => {
        // 真实远端地址（客户端无法伪造），供限流/审计使用
        r.remote_addr = remote_addr
        // 客户端要求关闭 → 响应后不再复用（HTTP 规范）
        let close_after = wants_close(r)
        let resp = try
          @async.with_timeout(limits.read_timeout_ms, async fn() {
            router.handle(r)
          })
        catch {
          _ => @http.Response::text(500, "Internal Server Error")
        } noraise {
          resp => resp
        }
        if close_after {
          resp.headers.push(("Connection", "close"))
        }
        // 写也加超时：防止慢客户端（只读很慢）长期占用连接槽位
        let _ = try
          @async.with_timeout(limits.read_timeout_ms, async fn() {
            write_all(io, resp.to_bytes())
          })
        catch {
          _ => ()
        } noraise {
          _ => ()
        }
        if close_after {
          keep_going = false
        }
      }
    }
  }
}

///|
/// 从 `ip:port` 取 IP 部分（去掉端口），作为限流/审计的稳定标识。
///
/// 不能直接用 `addr.to_string()`：它**带端口**，而每次连接的源端口都不同，
/// 会导致每个请求各算一个限流桶（限流形同虚设）。
///
/// IPv6 形式为 `[::1]:port`，按最后一个 `:` 切分仍得到稳定的 `[::1]`（可用作 key）。
fn addr_ip(addr : String) -> String {
  match addr.rev_find(":") {
    Some(i) => addr[:i].to_owned()
    None => addr
  }
}

///|
/// 请求是否要求关闭连接（`Connection: close`，或 HTTP/1.0 且未显式 keep-alive）。
fn wants_close(req : @http.Request) -> Bool {
  match req.header("connection") {
    Some(v) => v.to_lower().contains("close")
    None => req.version == "HTTP/1.0"
  }
}

///|
/// 通用 accept 循环：注册 SIGINT/SIGTERM，收到取消后停止接收并 drain。
///
/// ⚠️ 限制（实测）：Windows/IOCP + experimental async 下，`accept` **不响应任务取消**，
/// 所以信号触发的优雅关闭在 Windows 上可能不生效（进程需被强制结束）。
/// 生产建议：容器编排的 SIGTERM + 宽限期强杀；或在 Linux/macOS 上运行。
async fn serve_accept_loop(
  host : String,
  port : Int,
  scheme : String,
  handler : async (@socket.Tcp, String) -> Unit,
  limits : ServerLimits,
) -> Unit {
  let addr = @socket.Addr::parse("\{host}:\{port}") catch {
    _ => fail("invalid listen address: \{host}:\{port}")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  @signal.set_global_cancellation_signals([
    @signal.Signal::SIGINT,
    @signal.Signal::SIGTERM,
  ])
  // 并发连接上限：防止连接洪泛耗尽 fd / 内存（超出的连接会被直接关闭）
  let max_conns = limits.max_connections
  let slots = @semaphore.Semaphore(max_conns)
  println("[server] listening on \{scheme}://\{host}:\{port}")
  @async.with_task_group(async fn(g) {
    while !@async.is_being_cancelled() {
      // 带超时的 accept：定期回到循环检查取消（对能响应取消的运行时即优雅关闭）
      let conn = @async.with_timeout_opt(500, async fn() { server.accept() })
      match conn {
        Some((tcp, addr)) =>
          if slots.try_acquire() {
            g.spawn_bg(
              async fn() {
                defer slots.release()
                handler(tcp, addr_ip(addr.to_string()))
              },
              allow_failure=true,
            )
          } else {
            // 已达上限：拒绝新连接（快速失败，避免资源耗尽）
            tcp.close()
          }
        None => ()
      }
    }
    server.close()
    println("[server] shutdown: draining in-flight connections…")
  })
  println("[server] stopped")
}

///|
/// 在 `host:port` 上启动 HTTP 服务。
pub async fn serve(
  router : Router,
  host : String,
  port : Int,
  limits? : ServerLimits = ServerLimits::default(),
) -> Unit {
  serve_accept_loop(
    host,
    port,
    "http",
    async fn(tcp, addr) {
      serve_connection(router, tcp, remote_addr=addr, limits~)
    },
    limits,
  )
}

///|
/// Windows（schannel）：用 PKCS#12（`.pfx`）证书启动 HTTPS 服务。
///
/// 生成自签 pfx：
///   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
///   openssl pkcs12 -export -out cert.pfx -inkey key.pem -in cert.pem -passout pass:
///
/// ⚠️ 当前 async 的 schannel 后端把 `server_from_pair` 标为 internal，且 Windows 上
/// 不提供 PEM 版入口；因此 Windows 下 HTTPS 属于「能跑但非正式支持」。
#cfg(platform="windows")
pub async fn serve_tls_pfx(
  router : Router,
  host : String,
  port : Int,
  pfx_file : String,
  limits? : ServerLimits = ServerLimits::default(),
) -> Unit {
  let f = pfx_file
  serve_accept_loop(
    host,
    port,
    "https",
    async fn(tcp, addr) {
      // fd 泄漏防护：若 TLS 握手建立失败，或处理过程中抛错，都要关闭底层 socket
      let mut tls_ok = false
      defer (if !tls_ok { tcp.close() })
      let tls = @tls.Tls::server_from_pair(tcp, tcp, pfx_file=f)
      tls_ok = true
      defer tls.close()
      serve_connection_with(router, tls, remote_addr=addr, limits~)
    },
    limits,
  )
}

///|
/// 非 Windows（OpenSSL）：用 PEM 证书 + 私钥启动 HTTPS 服务。
#cfg(not(platform="windows"))
pub async fn serve_tls(
  router : Router,
  host : String,
  port : Int,
  cert_file : String,
  key_file : String,
  limits? : ServerLimits = ServerLimits::default(),
) -> Unit {
  serve_accept_loop(
    host,
    port,
    "https",
    async fn(tcp, addr) {
      let mut tls_ok = false
      defer (if !tls_ok { tcp.close() })
      let tls = @tls.Tls::server(
        tcp,
        private_key_file=key_file,
        private_key_type=@tls.X509FileType::PEM,
        certificate_file=cert_file,
        certificate_type=@tls.X509FileType::PEM,
      )
      tls_ok = true
      defer tls.close()
      serve_connection_with(router, tls, remote_addr=addr, limits~)
    },
    limits,
  )
}
