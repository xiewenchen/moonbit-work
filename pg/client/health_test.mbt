///|
/// 连接健康检查 / 查询超时 / 池内重连测试（需要本机 55432 的 PG）。

///|
async fn live() -> @client.Client {
  @client.Client::connect("127.0.0.1", 55432, "mbp", "", "mbptest")
}

///|
async test "healthy connection reports true" {
  let c = live()
  defer c.close()
  assert_eq(c.is_healthy(), true)
}

///|
async test "query timeout raises" {
  let c = live()
  defer c.close()
  let timed_out : Bool = try c.query_timeout("SELECT pg_sleep(2)", 300) catch {
    _ => true
  } noraise {
    _ => false
  }
  assert_eq(timed_out, true)
}

///|
async test "pool drops dead idle connection and reconnects" {
  let pool = @client.Pool::Pool(
    "127.0.0.1",
    55432,
    "mbp",
    "",
    "mbptest",
    size=1,
  )
  defer pool.close()
  let c = pool.acquire()
  // 模拟连接失效：关掉底层 socket 再归还
  c.close()
  pool.release(c)
  // 再借：健康检查应发现失效并重连
  let c2 = pool.acquire()
  let r = c2.query("SELECT 1 AS one")
  assert_eq(r.text(0, 0), Some("1"))
  pool.release(c2)
}
