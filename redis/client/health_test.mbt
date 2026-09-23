///|
/// Redis 连接健康检查 / 池重连测试（需要本机 6379 的 Redis）。

///|
async test "redis healthy connection reports true" {
  let c = @client.Client::connect("127.0.0.1", 6379)
  defer c.close()
  assert_eq(c.is_healthy(), true)
}

///|
async test "redis pool drops dead idle connection and reconnects" {
  let pool = @client.Pool::Pool("127.0.0.1", 6379, size=1)
  defer pool.close()
  let c = pool.acquire()
  c.close()
  pool.release(c)
  let c2 = pool.acquire()
  assert_eq(c2.ping(), "PONG")
  pool.release(c2)
}
