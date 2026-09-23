///|
/// 路由参数与中间件集成测试（复用 server_test.mbt 里的辅助函数）。

///|
async fn send_req(port : Int, req : @http.Request) -> @http.Response {
  let client = @socket.Tcp::connect_to_host("127.0.0.1", port~)
  defer client.close()
  write_all_local(client, req.to_bytes())
  let bytes = read_one_response(client)
  let (resp, _) = @http.Response::parse(bytes, 0)
  resp
}

///|
async test "path parameters" {
  let router = @server.Router::new()
  router.get("/users/:id", fn(req) {
    let id = match req.param("id") {
      Some(s) => s
      None => "?"
    }
    @http.Response::text(200, "user " + id)
  })
  let addr = @socket.Addr::parse("127.0.0.1:18120") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      for i = 0; i < 3; i = i + 1 {
        let (tcp, _) = server.accept()
        @server.serve_connection(router, tcp)
      }
    })
    @async.sleep(100)
    let r = send_req(18120, @http.Request::new(@http.Method::Get, "/users/42"))
    assert_eq(r.status, 200)
    assert_eq(@utf8.decode(r.body), "user 42")
    let r2 = send_req(
      18120,
      @http.Request::new(@http.Method::Get, "/users/abc"),
    )
    assert_eq(@utf8.decode(r2.body), "user abc")
    // 段数不匹配 → 404
    let r3 = send_req(
      18120,
      @http.Request::new(@http.Method::Get, "/users/42/x"),
    )
    assert_eq(r3.status, 404)
  })
}

///|
async test "middleware short-circuits" {
  let router = @server.Router::new()
  router.add_middleware(async fn(req, next) {
    if req.target == "/admin" {
      match req.header("authorization") {
        Some(_) => next()
        None => @http.Response::text(401, "Unauthorized")
      }
    } else {
      next()
    }
  })
  router.get("/admin", fn(_req) { @http.Response::text(200, "secret") })
  let addr = @socket.Addr::parse("127.0.0.1:18121") catch {
    _ => fail("bad addr")
  }
  let server = @socket.TcpServer::TcpServer(addr)
  defer server.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      for i = 0; i < 2; i = i + 1 {
        let (tcp, _) = server.accept()
        @server.serve_connection(router, tcp)
      }
    })
    @async.sleep(100)
    let unauth = send_req(
      18121,
      @http.Request::new(@http.Method::Get, "/admin"),
    )
    assert_eq(unauth.status, 401)
    let authed = @http.Request::new(@http.Method::Get, "/admin")
    authed.headers.push(("Authorization", "Bearer token"))
    let ok = send_req(18121, authed)
    assert_eq(ok.status, 200)
    assert_eq(@utf8.decode(ok.body), "secret")
  })
}
