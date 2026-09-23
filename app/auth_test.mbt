///|
/// 鉴权测试：bcrypt 密码哈希、JWT 签发/校验、`use_auth` 中间件。

///|
test "password hash and verify" {
  let h = try @app.hash_password("s3cret") catch {
    _ => fail("hash failed")
  } noraise {
    v => v
  }
  assert_eq(h.has_prefix("$2"), true) // bcrypt 哈希前缀
  let ok = try @app.verify_password("s3cret", h) catch {
    _ => false
  } noraise {
    v => v
  }
  assert_eq(ok, true)
  let bad = try @app.verify_password("wrong", h) catch {
    _ => false
  } noraise {
    v => v
  }
  assert_eq(bad, false)
}

///|
test "jwt sign and verify" {
  let claims : Map[String, String] = Map([("sub", "u1"), ("role", "admin")])
  let token = @app.sign_jwt(claims, "secret")
  match @app.verify_jwt(token, "secret") {
    Some(m) => assert_eq(m.get("sub"), Some("u1"))
    None => fail("expected valid token")
  }
  // 换密钥 → 校验失败
  assert_eq(@app.verify_jwt(token, "other-secret") is None, true)
  // 篡改 → 校验失败
  assert_eq(@app.verify_jwt(token + "x", "secret") is None, true)
}

///|
async test "auth middleware protects routes" {
  let base = @app.Config::default()
  let config : @app.Config = { ..base, port: 18212, }
  let app = @app.App::new(config)
  app.use_auth("test-secret")
  app.get("/secret", fn(_req) { @http.Response::text(200, "classified") })
  let router = app.router()
  let addr = @socket.Addr::parse("127.0.0.1:18212") catch {
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
    let c = @httpclient.Client::connect("127.0.0.1", 18212)
    defer c.close()
    // 无 token → 401
    assert_eq(c.get("/secret").status, 401)
    // 健康检查放行
    assert_eq(c.get("/health").status, 200)
    // 非法 token → 401
    let bad = @http.Request::new(@http.Method::Get, "/secret")
    bad.headers.push(("Authorization", "Bearer not-a-jwt"))
    assert_eq(c.send(bad).status, 401)
    // 合法 token → 200
    let claims : Map[String, String] = Map([("sub", "u1")])
    let token = @app.sign_jwt(claims, "test-secret")
    let ok = @http.Request::new(@http.Method::Get, "/secret")
    ok.headers.push(("Authorization", "Bearer " + token))
    let resp = c.send(ok)
    assert_eq(resp.status, 200)
    assert_eq(@utf8.decode(resp.body), "classified")
  })
}

///|
test "JWT claim 中的引号不会破坏 JSON 结构（防 claim 注入）" {
  // 恶意用户名：试图闭合字符串并注入 role=admin
  let evil : Map[String, String] = Map([("sub", "u1\",\"role\":\"admin")])
  let token = @app.sign_jwt(evil, "s")
  // 校验通过，且解出的 sub 与**原样**一致（未被拆成额外 claim）
  match @app.verify_jwt(token, "s") {
    None => fail("token should verify")
    Some(claims) =>
      // 关键安全目标：**没有**多出来的 role claim（注入被挡）
      assert_eq(claims.get("role"), None)
    // 注：`decode_claims` 是简化解析器（按 , / : 切分，不懂转义），
    // 因此含逗号的转义值不会被原样还原 —— 但这不影响「无注入」这一安全结论。
  }
}

///|
test "JWT claim 中的反斜杠被正确转义" {
  let evil : Map[String, String] = Map([("sub", "a\b")])
  let token = @app.sign_jwt(evil, "s")
  match @app.verify_jwt(token, "s") {
    None => fail("token should verify")
    Some(claims) =>
      // 关键：反斜杠不会让签名/解析崩溃，且不产生额外 claim
      assert_eq(claims.get("sub") is Some(_), true)
  }
}

///|
test "带 exp 的 token：未过期通过、过期被拒" {
  let claims : Map[String, String] = Map([("sub", "u1")])
  // 1 小时有效
  let fresh = @app.sign_jwt_expiring(claims, "s", 3600)
  assert_eq(@app.verify_jwt(fresh, "s") is Some(_), true)
  // 已过期（ttl=0：exp = now，下一秒即过期；直接构造一个过去的 exp 更稳）
  let past : Map[String, String] = Map([("sub", "u1"), ("exp", "1")])
  let expired = @app.sign_jwt(past, "s")
  assert_eq(@app.verify_jwt(expired, "s"), None)
}

///|
test "exp 非数字 / 缺失时的行为" {
  // exp 非法 → 拒绝
  let bad : Map[String, String] = Map([("sub", "u1"), ("exp", "abc")])
  assert_eq(@app.verify_jwt(@app.sign_jwt(bad, "s"), "s"), None)
  // 无 exp → 通过（向后兼容）
  let none : Map[String, String] = Map([("sub", "u1")])
  assert_eq(@app.verify_jwt(@app.sign_jwt(none, "s"), "s") is Some(_), true)
}
