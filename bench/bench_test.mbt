///|
/// 压测工具测试：起一个本地服务，并发打它，检查统计正确。

///|
async test "bench against local server" {
  let router = @server.Router::new()
  router.get("/ping", fn(_req) { @http.Response::text(200, "pong") })
  let addr = @socket.Addr::parse("127.0.0.1:18220") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    // 处理若干条连接（bench 的每个并发用一条连接）
    g.spawn_bg(async fn() {
      for i = 0; i < 5; i = i + 1 {
        let (tcp, _) = server.accept()
        g.spawn_bg(async fn() { @server.serve_connection(router, tcp) })
      }
    })
    @async.sleep(100)
    let r = @bench.run_bench("127.0.0.1", 18220, "/ping", 100, 5)
    assert_eq(r.total, 100)
    assert_eq(r.ok, 100)
    assert_eq(r.fail, 0)
    assert_eq(r.max_ms >= r.p50_ms, true)
  })
}
