///|
/// chunked 请求体集成测试。

///|
async fn raw_request(port : Int, payload : String) -> @http.Response {
  let client = @socket.Tcp::connect_to_host("127.0.0.1", port~)
  defer client.close()
  write_all_local(client, @utf8.encode(payload))
  let bytes = read_one_response(client)
  let (resp, _) = @http.Response::parse(bytes, 0)
  resp
}

///|
async test "chunked request body is decoded" {
  let router = @server.Router::new()
  router.post("/echo", fn(req) { @http.Response::text(200, req.text()) })
  let addr = @socket.Addr::parse("127.0.0.1:18132") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      let (tcp, _) = server.accept()
      @server.serve_connection(router, tcp)
    })
    @async.sleep(100)
    let payload = "POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"
    let resp = raw_request(18132, payload)
    assert_eq(resp.status, 200)
    assert_eq(@utf8.decode(resp.body), "hello world")
  })
}
