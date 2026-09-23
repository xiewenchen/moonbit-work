///|
/// TLS 握手集成测试（Windows schannel 用 `.pfx`）。
///
/// 证书由 testdata 提供（自签，仅测试用）：
///   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
///   openssl pkcs12 -export -out localhost.pfx -inkey key.pem -in cert.pem -passout pass:

///|
async fn[W : @io.Writer] tls_write(w : W, data : Bytes) -> Unit {
  let n = data.length()
  let mut off = 0
  while off < n {
    let written = w.write_once(data, offset=off, len=n - off)
    if written <= 0 {
      fail("tls write returned \{written}")
    }
    off = off + written
  }
}

///|
async fn[R : @io.Reader] tls_read_response(r : R) -> @http.Response {
  let buf = Buffer()
  while true {
    let data = buf.to_bytes()
    let done : Bool = try @http.Response::parse(data, 0) catch {
      @http.UnexpectedEof(_) => false
      @http.Malformed(m) => fail("malformed: \{m}")
      @http.PayloadTooLarge(m) => fail("too large: \{m}")
    } noraise {
      _ => true
    }
    if done {
      let (resp, _) = @http.Response::parse(data, 0)
      return resp
    }
    match r.read_some() {
      Some(c) =>
        if c.length() > 0 {
          buf.write_bytes(c)
        } else {
          fail("closed before response")
        }
      None => fail("closed before response")
    }
  }
  fail("unreachable")
}

///|
async test "tls handshake and request" {
  let router = @server.Router::new()
  router.get("/secure", fn(_req) { @http.Response::text(200, "secret") })
  let addr = @socket.Addr::parse("127.0.0.1:18133") catch {
    _ => fail("bad addr")
  }
  let srv = @socket.TcpServer::TcpServer(addr)
  defer srv.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      let (tcp, _) = srv.accept()
      let tls = @tls.Tls::server_from_pair(
        tcp,
        tcp,
        pfx_file="http/server/testdata/localhost.pfx",
      )
      @server.serve_connection_with(router, tls)
      tls.close()
    })
    @async.sleep(200)
    let raw = @socket.Tcp::connect_to_host("127.0.0.1", port=18133)
    let tls = @tls.Tls::client_from_pair(
      raw,
      raw,
      trust=@tls.TrustedRoot::NoVerification,
    )
    tls_write(
      tls,
      @utf8.encode(
        "GET /secure HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      ),
    )
    let resp = tls_read_response(tls)
    tls.close()
    assert_eq(resp.status, 200)
    assert_eq(@utf8.decode(resp.body), "secret")
  })
}
