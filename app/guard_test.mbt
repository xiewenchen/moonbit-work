///|
/// 限流、输入校验与统一错误处理测试。

///|
test "validation helpers" {
  assert_eq(@app.require_non_empty(Some("x"), "name") is Ok(_), true)
  assert_eq(@app.require_non_empty(Some("   "), "name") is Ok(_), false)
  assert_eq(@app.require_non_empty(None, "name") is Err(_), true)
  assert_eq(@app.require_max_len("abc", 5, "name") is Ok(_), true)
  assert_eq(@app.require_max_len("abcdef", 5, "name") is Err(_), true)
}

///|
async test "rate limit returns 429 after burst" {
  let base = @app.Config::default()
  let config : @app.Config = { ..base, port: 18213, }
  let app = @app.App::new(config)
  // 速率为 0（不补充），容量 2 → 前两个通过，第三个 429
  app.use_rate_limit(0.0, 2.0)
  app.get("/x", fn(_req) { @http.Response::text(200, "ok") })
  let router = app.router()
  let addr = @socket.Addr::parse("127.0.0.1:18213") catch {
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
    let c = @httpclient.Client::connect("127.0.0.1", 18213)
    defer c.close()
    assert_eq(c.get("/x").status, 200)
    assert_eq(c.get("/x").status, 200)
    let limited = c.get("/x")
    assert_eq(limited.status, 429)
    assert_eq(limited.header("retry-after"), Some("1"))
  })
}

///|
async test "handler error becomes json 500" {
  let base = @app.Config::default()
  let config : @app.Config = { ..base, port: 18214, }
  let app = @app.App::new(config)
  app.get("/boom", _req => fail("boom"))
  app.get("/fine", fn(_req) { @http.Response::text(200, "ok") })
  let router = app.router()
  let addr = @socket.Addr::parse("127.0.0.1:18214") catch {
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
    let c = @httpclient.Client::connect("127.0.0.1", 18214)
    defer c.close()
    let boom = c.get("/boom")
    assert_eq(boom.status, 500)
    assert_eq(@utf8.decode(boom.body).contains("internal server error"), true)
    // 连接仍可用（错误被隔离）
    assert_eq(c.get("/fine").status, 200)
  })
}
