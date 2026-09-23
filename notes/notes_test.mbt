///|
/// notes 服务的端到端测试（需要本机 55432 的 PG 与 6379 的 Redis）。

///|
async test "notes api end to end" {
  let base = @app.Config::default()
  let config : @app.Config = { ..base, port: 18201, }
  let app = @notes.build_app(config)
  @notes.ensure_schema(app)
  let router = app.router()
  let addr = @socket.Addr::parse("127.0.0.1:18201") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  defer app.close()
  @async.with_task_group(async fn(g) {
    // httpclient 复用同一条连接
    g.spawn_bg(async fn() {
      let (tcp, _) = server.accept()
      @server.serve_connection(router, tcp)
    })
    @async.sleep(100)
    let c = @httpclient.Client::connect("127.0.0.1", 18201)
    defer c.close()
    // 建一条笔记
    let created = c.post(
      "/notes", "application/json", "{\"title\":\"hello\",\"body\":\"world\"}",
    )
    assert_eq(created.status, 201)
    let created_body = @utf8.decode(created.body)
    assert_eq(created_body.contains("\"id\""), true)
    // 列表
    let list = c.get("/notes")
    assert_eq(list.status, 200)
    assert_eq(@utf8.decode(list.body).contains("hello"), true)
    // 缺 title → 400
    let bad = c.post("/notes", "application/json", "{\"body\":\"x\"}")
    assert_eq(bad.status, 400)
    // 统计（Redis）
    let stats = c.get("/stats")
    assert_eq(stats.status, 200)
    assert_eq(@utf8.decode(stats.body).contains("requests"), true)
    // 健康检查
    let h = c.get("/health")
    assert_eq(@utf8.decode(h.body), "ok")
  })
}
