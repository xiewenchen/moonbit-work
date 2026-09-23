///|
/// 连接池集成测试：需要本机 6379 Redis。

///|
async test "pool acquires, reuses and releases" {
  let pool = @client.Pool::Pool("127.0.0.1", 6379, size=2)
  defer pool.close()
  assert_eq(pool.idle_count(), 0)
  let c1 = pool.acquire()
  assert_eq(c1.ping(), "PONG")
  assert_eq(pool.idle_count(), 0)
  pool.release(c1)
  assert_eq(pool.idle_count(), 1)
  // 再借一次应当拿到刚才归还的连接（复用）
  let c2 = pool.acquire()
  assert_eq(pool.idle_count(), 0)
  assert_eq(c2.ping(), "PONG")
  pool.release(c2)
}

///|
async test "pool run helper" {
  let pool = @client.Pool::Pool("127.0.0.1", 6379, size=1)
  defer pool.close()
  pool.run(async fn(c) { c.set("mbp:test:pool", "ok") })
  pool.run(async fn(c) {
    assert_eq(c.get("mbp:test:pool"), Some("ok"))
    c.del(["mbp:test:pool"]) |> ignore
  })
}
