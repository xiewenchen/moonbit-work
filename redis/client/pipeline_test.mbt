///|
/// 回归测试：Redis 客户端必须保留未消费的回复字节。
///
/// 服务端一次性写下两个 `+PONG`，客户端连续 `ping` 两次都应成功。
/// 修复前（`buf.reset()`）第二次会挂住。

///|
async fn[W : @io.Writer] rpkg_write(w : W, data : Bytes) -> Unit {
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
async test "redis client keeps unconsumed replies" {
  let addr = @socket.Addr::parse("127.0.0.1:18147") catch {
    _ => fail("bad addr")
  }
  let srv = @socket.TcpServer::TcpServer(addr)
  defer srv.close()
  @async.with_task_group(async fn(g) {
    g.spawn_bg(async fn() {
      let (tcp, _) = srv.accept()
      rpkg_write(tcp, @utf8.encode("+PONG\r\n+PONG\r\n"))
      @async.sleep(400)
      tcp.close()
    })
    @async.sleep(120)
    let c = @client.Client::connect("127.0.0.1", 18147)
    assert_eq(c.ping(), "PONG")
    // 第二个回复已在缓冲区里；修复前这里会挂住
    assert_eq(c.ping(), "PONG")
    c.close()
  })
}
