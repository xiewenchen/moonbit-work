///|
/// 配置校验与就绪探针测试。

///|
test "config validate" {
  let base = @app.Config::default()
  assert_eq(@app.Config::validate(base) is Ok(_), true)
  let bad_port : @app.Config = { ..base, port: 0, }
  assert_eq(@app.Config::validate(bad_port) is Err(_), true)
  let bad_user : @app.Config = { ..base, pg_user: "", }
  assert_eq(@app.Config::validate(bad_user) is Err(_), true)
}

///|
async test "readiness probe reports ready when deps are up" {
  let base = @app.Config::default()
  let config : @app.Config = { ..base, port: 18215, }
  let app = @app.App::new(config)
  app.use_readiness()
  let router = app.router()
  let addr = @socket.Addr::parse("127.0.0.1:18215") catch {
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
    let c = @httpclient.Client::connect("127.0.0.1", 18215)
    defer c.close()
    // 依赖（PG 55432 / Redis 6379）在跑 → 200
    let r = c.get("/ready")
    assert_eq(r.status, 200)
    assert_eq(@utf8.decode(r.body), "ready")
  })
}

///|
async test "readiness probe reports 503 when a dependency is down" {
  let base = @app.Config::default()
  // 指向一个没有服务的端口，模拟依赖不可用
  let config : @app.Config = { ..base, port: 18216, redis_port: 6399, }
  let app = @app.App::new(config)
  app.use_readiness()
  let router = app.router()
  let addr = @socket.Addr::parse("127.0.0.1:18216") catch {
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
    let c = @httpclient.Client::connect("127.0.0.1", 18216)
    defer c.close()
    assert_eq(c.get("/ready").status, 503)
  })
}
