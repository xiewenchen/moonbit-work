///|
/// 类型化取值集成测试（需要本机 55432 的 PG，见 client_test.mbt）。

///|
async test "typed value decoding from server" {
  let c = @client.Client::connect("127.0.0.1", 55432, "mbp", "", "mbptest")
  defer c.close()
  let r = c.query(
    "SELECT 42::int4 AS i, 3.5::float8 AS f, true AS b, 'hi'::text AS t, NULL::int AS n",
  )
  assert_eq(r.types[0], 23) // int4
  assert_eq(r.types[1], 701) // float8
  assert_eq(r.types[2], 16) // bool
  assert_eq(r.types[3], 25) // text
  assert_eq(r.int(0, 0), Some(42L))
  assert_eq(r.float(0, 1), Some(3.5))
  assert_eq(r.bool(0, 2), Some(true))
  assert_eq(r.text(0, 3), Some("hi"))
  assert_eq(r.text(0, 4), None)
  match r.value(0, 4) {
    @pg.Value::Null => ()
    _ => fail("expected NULL")
  }
}
