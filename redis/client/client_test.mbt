///|
/// 集成测试：需要一个跑在本机 6379 的 Redis。
///
/// 起服务：`docker run -d --name mbp-redis -p 6379:6379 redis:7-alpine`
/// 跑测试：`moon test --target native`

///|
async test "ping returns PONG" {
  let c = @client.Client::connect("127.0.0.1", 6379)
  defer c.close()
  assert_eq(c.ping(), "PONG")
}

///|
async test "set / get / del round trip" {
  let c = @client.Client::connect("127.0.0.1", 6379)
  defer c.close()
  c.set("mbp:test:greeting", "hello 世界")
  assert_eq(c.get("mbp:test:greeting"), Some("hello 世界"))
  assert_eq(c.del(["mbp:test:greeting"]), 1L)
  assert_eq(c.get("mbp:test:greeting"), None)
}

///|
async test "get missing key is None" {
  let c = @client.Client::connect("127.0.0.1", 6379)
  defer c.close()
  assert_eq(c.get("mbp:test:definitely-missing"), None)
}
