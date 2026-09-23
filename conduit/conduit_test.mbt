///|
/// 直接调用 handler 的集成测试：不经 HTTP，能直接看到异常。
#skip("需要本地 PostgreSQL + conduitdb（本地起服务后跑 --include-skipped）")
async test "conduit: 注册 → 登录 → 当前用户 链路" {
  let base = @app.Config::default()
  let cfg : @app.Config = {
    ..base,
    pg_host: "127.0.0.1",
    pg_port: 55432,
    pg_user: "mbp",
    pg_password: "mbp",
    pg_db: "conduitdb",
    redis_host: "127.0.0.1",
    redis_port: 6379,
  }
  let a = @app.App::new(cfg)
  a.with_db(async fn(c) { @db.migrate(c, "conduit/migrations") |> ignore })
  let auth : AuthConfig = {
    secret: "test-secret",
    ttl_sec: 3600UL,
    bcrypt_cost: 4,
  }
  let stamp = @env.now().to_string()
  let email = "t" + stamp + "@example.com"
  let uname = "t" + stamp
  // 注册
  let body = "{\"user\":{\"username\":\"" +
    uname +
    "\",\"email\":\"" +
    email +
    "\",\"password\":\"password123\"}}"
  let raw = "POST /api/users HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: " +
    body.length().to_string() +
    "\r\n\r\n" +
    body
  let (req, _) = @http.Request::parse(@utf8.encode(raw), 0)
  let resp = handle_register(a, auth, req)
  inspect(resp.status, content="201")
  // 登录
  let login_body = "{\"user\":{\"email\":\"" +
    email +
    "\",\"password\":\"password123\"}}"
  let login_raw = "POST /api/users/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: " +
    login_body.length().to_string() +
    "\r\n\r\n" +
    login_body
  let (lreq, _) = @http.Request::parse(@utf8.encode(login_raw), 0)
  let lresp = handle_login(a, auth, lreq)
  println("登录响应: \{lresp.status} \{lresp.body |> @utf8.decode_lossy}")
  inspect(lresp.status, content="200")
}
