///|
/// 回归测试：客户端必须保留「未消费的字节」。
///
/// 背景：`read_response` 曾经用 `buf.reset()`，会丢掉一次 read 里多出来的
/// 下一个响应（TCP 粘包时高发）。这里让服务端**一次性写出两个完整响应**，
/// 客户端连续取两次，验证第二个响应确实来自缓冲区而不是丢失。
///
/// 修复前：第二次 `get` 会一直等不到数据（挂起/超时）。

///|
async fn[W : @io.Writer] pkg_write(w : W, data : Bytes) -> Unit {
  let n = data.length()
  let mut off = 0
  while off < n {
    let written = w.write_once(data, offset=off, len=n - off)
    if written <= 0 {
      fail("write returned \{written}")
    }
    off = off + written
  }
}

///|
async test "http client keeps unconsumed bytes (pipelined responses)" {
  let addr = @socket.Addr::parse("127.0.0.1:18145") catch {
    _ => fail("bad addr")
  }
  let srv = @socket.TcpServer::TcpServer(addr)
  defer srv.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      let (tcp, _) = srv.accept()
      // 一次 write 里塞两个完整响应（模拟粘包）
      let payload = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nA1" +
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nB2"
      pkg_write(tcp, @utf8.encode(payload))
      @async.sleep(500)
      tcp.close()
    })
    @async.sleep(150)
    let c = @client.Client::connect("127.0.0.1", 18145)
    let r1 = c.get("/a")
    assert_eq(@utf8.decode(r1.body), "A1")
    // 第二个响应已在缓冲区里；修复前这里会挂住
    let r2 = c.get("/b")
    assert_eq(@utf8.decode(r2.body), "B2")
    c.close()
  })
}

///|
/// 同一 request 重复 send 不应把 header 越加越多。
async test "http client does not duplicate connection header" {
  let req = @http.Request::new(@http.Method::Get, "/x")
  let addr = @socket.Addr::parse("127.0.0.1:18146") catch {
    _ => fail("bad addr")
  }
  let srv = @socket.TcpServer::TcpServer(addr)
  defer srv.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      let (tcp, _) = srv.accept()
      for i = 0; i < 3; i = i + 1 {
        pkg_write(
          tcp,
          @utf8.encode("HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nX"),
        )
      }
      @async.sleep(300)
      tcp.close()
    })
    @async.sleep(150)
    let c = @client.Client::connect("127.0.0.1", 18146)
    for i = 0; i < 3; i = i + 1 {
      let r = c.send(req)
      assert_eq(r.status, 200)
    }
    // 计数 `Connection` / `Host` 头是否重复
    let mut conn_count = 0
    let mut host_count = 0
    for kv in req.headers {
      let (k, _) = kv
      if k.to_lower() == "connection" {
        conn_count = conn_count + 1
      }
      if k.to_lower() == "host" {
        host_count = host_count + 1
      }
    }
    assert_eq(conn_count, 1)
    assert_eq(host_count, 1)
    c.close()
  })
}
