///|
/// HTTP 客户端集成测试：用我们自己的服务端配合验证。

///|
async test "client talks to our server" {
  let router = @server.Router::new()
  router.get("/hello", fn(_req) { @http.Response::text(200, "world") })
  router.post("/echo", req => @http.Response::text(200, @utf8.decode(req.body)))
  let addr = @socket.Addr::parse("127.0.0.1:18110") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      // client 复用同一个 keep-alive 连接，所以只需 accept 一次
      for i = 0; i < 1; i = i + 1 {
        let (tcp, _) = server.accept()
        @server.serve_connection(router, tcp)
      }
    })
    @async.sleep(100)
    let c = @client.Client::connect("127.0.0.1", 18110)
    defer c.close()
    let hello = c.get("/hello")
    assert_eq(hello.status, 200)
    assert_eq(@utf8.decode(hello.body), "world")
    let echoed = c.post("/echo", "text/plain", "ping-pong")
    assert_eq(echoed.status, 200)
    assert_eq(@utf8.decode(echoed.body), "ping-pong")
  })
}
