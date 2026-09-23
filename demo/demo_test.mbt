///|
/// demo 服务的端到端测试：需要本机 55432 的 PG 与 6379 的 Redis
/// （见 pg/client/client_test.mbt 与 redis/client/client_test.mbt 的起服务命令）。

///|
async test "demo service end to end" {
  let backends : @demo.Backends = { pg_port: 55432, redis_port: 6379, }
  @demo.ensure_schema(backends)
  let router = @demo.build_router(backends)
  let addr = @socket.Addr::parse("127.0.0.1:18200") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    // httpclient 复用同一条 keep-alive 连接，所以只需 accept 一次
    g.spawn_bg(async fn() {
      let (tcp, _) = server.accept()
      @server.serve_connection(router, tcp)
    })
    @async.sleep(100)
    let c = @httpclient.Client::connect("127.0.0.1", 18200)
    defer c.close()
    let h = c.get("/health")
    assert_eq(h.status, 200)
    assert_eq(@utf8.decode(h.body), "ok")
    let v = c.get("/visits")
    assert_eq(v.status, 200)
    assert_eq(@utf8.decode(v.body).contains("visits:"), true)
    let created = c.post("/users", "text/plain", "alice")
    assert_eq(created.status, 201)
    let id = @utf8.decode(created.body)
    let u = c.get("/users/" + id)
    assert_eq(u.status, 200)
    assert_eq(@utf8.decode(u.body), "alice")
    let missing = c.get("/users/999999")
    assert_eq(missing.status, 404)
  })
}
