///|
/// 服务端类型化解码集成测试（需要本机 55432 的 PG）。

///|
async test "server side typed values" {
  let c = @client.Client::connect("127.0.0.1", 55432, "mbp", "", "mbptest")
  defer c.close()
  let r = c.query(
    "SELECT 123.456::numeric AS n, '2024-01-02'::date AS d, " +
    "'550e8400-e29b-41d4-a716-446655440000'::uuid AS u, " +
    "'{\"a\":1}'::json AS j, ARRAY[1,2,3] AS arr",
  )
  match r.value(0, 0) {
    @pg.Value::Numeric(s) => assert_eq(s, "123.456")
    _ => fail("expected Numeric")
  }
  match r.value(0, 1) {
    @pg.Value::Timestamp(s) => assert_eq(s, "2024-01-02")
    _ => fail("expected Timestamp/date")
  }
  match r.value(0, 2) {
    @pg.Value::Uuid(_) => ()
    _ => fail("expected Uuid")
  }
  match r.value(0, 3) {
    @pg.Value::Json(_) => ()
    _ => fail("expected Json")
  }
  match r.value(0, 4) {
    @pg.Value::ArrayValue(xs) => {
      assert_eq(xs.length(), 3)
      match xs[2] {
        @pg.Value::Int(n) => assert_eq(n, 3L)
        _ => fail("expected Int element")
      }
    }
    _ => fail("expected ArrayValue")
  }
}
