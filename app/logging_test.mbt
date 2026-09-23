///|
/// 结构化日志 / 请求 ID 测试。

///|
async test "logging middleware echoes request id" {
  let base = @app.Config::default()
  let config : @app.Config = { ..base, port: 18210, }
  let app = @app.App::new(config)
  app.use_logging()
  app.get("/x", fn(_req) { @http.Response::text(200, "ok") })
  let router = app.router()
  let addr = @socket.Addr::parse("127.0.0.1:18210") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  defer app.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      let (tcp, _) = server.accept()
      @server.serve_connection(router, tcp)
    })
    @async.sleep(100)
    let c = @httpclient.Client::connect("127.0.0.1", 18210)
    defer c.close()
    // 带 id：应原样回显
    let req = @http.Request::new(@http.Method::Get, "/x")
    req.headers.push(("X-Request-Id", "trace-abc"))
    let resp = c.send(req)
    assert_eq(resp.status, 200)
    assert_eq(resp.header("x-request-id"), Some("trace-abc"))
    // 不带 id：应生成一个
    let resp2 = c.get("/x")
    match resp2.header("x-request-id") {
      Some(v) => assert_eq(v.length() > 0, true)
      None => fail("expected a generated request id")
    }
  })
}
