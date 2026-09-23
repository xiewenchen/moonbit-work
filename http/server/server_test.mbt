///|
/// 逐步验证：async 基础 → socket → HTTP 服务端。

///|
async fn write_all_local(tcp : @socket.Tcp, data : Bytes) -> Unit {
  let n = data.length()
  let mut off = 0
  while off < n {
    let written = tcp.write_once(data, offset=off, len=n - off)
    if written <= 0 {
      fail("write returned \{written}")
    }
    off = off + written
  }
}

///|
async fn read_one_response(tcp : @socket.Tcp) -> Bytes {
  let buf = Buffer()
  while true {
    let data = buf.to_bytes()
    let done : Bool = try @http.Response::parse(data, 0) catch {
      @http.UnexpectedEof(_) => false
      @http.Malformed(m) => fail("malformed response: \{m}")
      @http.PayloadTooLarge(m) => fail("response too large: \{m}")
    } noraise {
      _ => true
    }
    if done {
      return data
    }
    match tcp.read_some() {
      Some(c) =>
        if c.length() > 0 {
          buf.write_bytes(c)
        } else {
          fail("connection closed before response")
        }
      None => fail("connection closed before response")
    }
  }
  fail("unreachable")
}

///|
async fn request_once(
  port : Int,
  verb : @http.Method,
  target : String,
) -> @http.Response {
  let client = @socket.Tcp::connect_to_host("127.0.0.1", port~)
  defer client.close()
  write_all_local(client, @http.Request::new(verb, target).to_bytes())
  let bytes = read_one_response(client)
  let (resp, _) = @http.Response::parse(bytes, 0)
  resp
}

///|
async test "task group sanity" {
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() { @async.sleep(50) })
    @async.sleep(150)
  })
}

///|
async test "socket echo sanity" {
  let addr = @socket.Addr::parse("127.0.0.1:18101") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      let (tcp, _) = server.accept()
      match tcp.read_some() {
        Some(c) =>
          if c.length() > 0 {
            tcp.write_once(c, offset=0, len=c.length()) |> ignore
          }
        None => ()
      }
      tcp.close()
    })
    @async.sleep(150)
    let client = @socket.Tcp::connect_to_host("127.0.0.1", port=18101)
    client.write_once(@utf8.encode("hi"), offset=0, len=2) |> ignore
    match client.read_some() {
      Some(b) => assert_eq(b.length(), 2)
      None => fail("no echo")
    }
    client.close()
  })
}

///|
async test "http multiple requests" {
  let router = @server.Router::new()
  router.get("/hello", fn(_req) { @http.Response::text(200, "world") })
  router.get("/ping", fn(_req) { @http.Response::text(200, "pong") })
  let addr = @socket.Addr::parse("127.0.0.1:18102") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    // 处理固定条数的连接（避免无限 accept 循环在取消时挂起）
    g.spawn_bg(async fn() {
      for i = 0; i < 4; i = i + 1 {
        let (tcp, _) = server.accept()
        @server.serve_connection(router, tcp)
      }
    })
    @async.sleep(100)
    let hello = request_once(18102, @http.Method::Get, "/hello")
    assert_eq(hello.status, 200)
    assert_eq(@utf8.decode(hello.body), "world")
    let ping = request_once(18102, @http.Method::Get, "/ping")
    assert_eq(@utf8.decode(ping.body), "pong")
    let missing = request_once(18102, @http.Method::Get, "/nope")
    assert_eq(missing.status, 404)
    // query string 不影响路径匹配
    let q = request_once(18102, @http.Method::Get, "/hello?x=1")
    assert_eq(@utf8.decode(q.body), "world")
  })
}
