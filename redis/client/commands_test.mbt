///|
/// 命令层集成测试：需要本机 6379 Redis（见 `client_test.mbt` 说明）。

///|
async test "string / counter / expire commands" {
  let c = @client.Client::connect("127.0.0.1", 6379)
  defer c.close()
  c.del(["mbp:test:counter"]) |> ignore
  assert_eq(c.exists("mbp:test:counter"), false)
  assert_eq(c.incr("mbp:test:counter"), 1L)
  assert_eq(c.incr_by("mbp:test:counter", 41L), 42L)
  assert_eq(c.exists("mbp:test:counter"), true)
  assert_eq(c.ttl("mbp:test:counter"), -1L)
  assert_eq(c.expire("mbp:test:counter", 100), true)
  assert_eq(c.ttl("mbp:test:counter") > 0L, true)
  assert_eq(c.del(["mbp:test:counter"]), 1L)
}

///|
async test "hash commands" {
  let c = @client.Client::connect("127.0.0.1", 6379)
  defer c.close()
  c.del(["mbp:test:hash"]) |> ignore
  assert_eq(c.hset("mbp:test:hash", "name", "moonbit"), 1L)
  assert_eq(c.hset("mbp:test:hash", "kind", "language"), 1L)
  assert_eq(c.hset("mbp:test:hash", "name", "moonbit"), 0L)
  assert_eq(c.hget("mbp:test:hash", "name"), Some("moonbit"))
  assert_eq(c.hget("mbp:test:hash", "missing"), None)
  assert_eq(c.hgetall("mbp:test:hash").length(), 2)
  assert_eq(c.del(["mbp:test:hash"]), 1L)
}

///|
async test "list commands" {
  let c = @client.Client::connect("127.0.0.1", 6379)
  defer c.close()
  c.del(["mbp:test:list"]) |> ignore
  assert_eq(c.lpush("mbp:test:list", ["a", "b", "c"]), 3L)
  assert_eq(c.lrange("mbp:test:list", 0, -1), ["c", "b", "a"])
  assert_eq(c.del(["mbp:test:list"]), 1L)
}
