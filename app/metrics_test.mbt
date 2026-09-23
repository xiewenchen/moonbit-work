///|
/// 指标端点测试。

///|
async test "metrics endpoint reports prometheus text" {
  let base = @app.Config::default()
  let config : @app.Config = { ..base, port: 18211, }
  let app = @app.App::new(config)
  app.use_metrics()
  app.get("/ping", fn(_req) { @http.Response::text(200, "pong") })
  let router = app.router()
  let addr = @socket.Addr::parse("127.0.0.1:18211") catch {
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
    let c = @httpclient.Client::connect("127.0.0.1", 18211)
    defer c.close()
    c.get("/ping") |> ignore
    c.get("/ping") |> ignore
    let m = c.get("/metrics")
    assert_eq(m.status, 200)
    let text = @utf8.decode(m.body)
    // 渲染发生在本次 /metrics 的中间件 after 之前，故此处计数为 2
    assert_eq(
      text.contains("http_requests_total{method=\"GET\",status=\"200\"} 2"),
      true,
    )
    assert_eq(text.contains("# TYPE http_requests_total counter"), true)
    assert_eq(text.contains("http_request_duration_ms_sum"), true)
  })
}
