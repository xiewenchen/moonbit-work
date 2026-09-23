///|
/// 网络层加固的集成测试：请求体超限 → 413；请求头超限 → 431。

///|
async fn raw_send(port : Int, payload : String) -> Int {
  let client = @socket.Tcp::connect_to_host("127.0.0.1", port~)
  defer client.close()
  write_all_local(client, @utf8.encode(payload))
  let bytes = read_one_response(client)
  let (resp, _) = @http.Response::parse(bytes, 0)
  resp.status
}

///|
async test "oversized body is rejected with 413" {
  let router = @server.Router::new()
  router.post("/echo", fn(_req) { @http.Response::text(200, "ok") })
  let limits : @server.ServerLimits = {
    read_timeout_ms: 5000,
    idle_timeout_ms: 5000,
    max_header_bytes: 8192,
    max_body_bytes: 32,
    max_connections: 64,
  }
  let addr = @socket.Addr::parse("127.0.0.1:18130") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      let (tcp, _) = server.accept()
      @server.serve_connection(router, tcp, limits~)
    })
    @async.sleep(100)
    // Content-Length 超过上限（32）→ 应在读 body 前就被拒绝
    let big = "POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 999\r\n\r\n" +
      "a".repeat(40)
    let status = raw_send(18130, big)
    assert_eq(status, 413)
  })
}

///|
async test "oversized headers are rejected with 431" {
  let router = @server.Router::new()
  router.get("/x", fn(_req) { @http.Response::text(200, "ok") })
  let limits : @server.ServerLimits = {
    read_timeout_ms: 5000,
    idle_timeout_ms: 5000,
    max_header_bytes: 128,
    max_body_bytes: 1024,
    max_connections: 64,
  }
  let addr = @socket.Addr::parse("127.0.0.1:18131") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      let (tcp, _) = server.accept()
      @server.serve_connection(router, tcp, limits~)
    })
    @async.sleep(100)
    // 迟迟不给结束的空行 + 超大 header → 431
    let huge = "GET /x HTTP/1.1\r\n" + "X-Pad: " + "b".repeat(400) + "\r\n\r\n"
    let status = raw_send(18131, huge)
    assert_eq(status, 431)
  })
}
