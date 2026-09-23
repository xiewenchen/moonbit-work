///|
/// 类型化解码测试（纯逻辑）。

///|
test "decode bool" {
  match @pg.decode_value(16, Some("t")) {
    @pg.Value::Bool(b) => assert_eq(b, true)
    _ => fail("expected Bool")
  }
  match @pg.decode_value(16, Some("f")) {
    @pg.Value::Bool(b) => assert_eq(b, false)
    _ => fail("expected Bool")
  }
}

///|
test "decode integers" {
  match @pg.decode_value(23, Some("42")) {
    @pg.Value::Int(n) => assert_eq(n, 42L)
    _ => fail("expected Int")
  }
  match @pg.decode_value(20, Some("-7")) {
    @pg.Value::Int(n) => assert_eq(n, -7L)
    _ => fail("expected Int")
  }
}

///|
test "decode floats and numeric" {
  match @pg.decode_value(701, Some("3.5")) {
    @pg.Value::Float(f) => assert_eq(f, 3.5)
    _ => fail("expected Float")
  }
  // numeric 现在是精确十进制（不再走 Double）
  match @pg.decode_value(1700, Some("1.5e3")) {
    @pg.Value::Numeric(s) => assert_eq(s, "1.5e3")
    _ => fail("expected Numeric")
  }
}

///|
test "decode text and null" {
  match @pg.decode_value(25, Some("hi")) {
    @pg.Value::Str(s) => assert_eq(s, "hi")
    _ => fail("expected Str")
  }
  assert_eq(@pg.decode_value(25, None) is @pg.Value::Null, true)
}

///|
test "decode numeric keeps full precision" {
  match @pg.decode_value(1700, Some("1234567890123456789.123456789")) {
    @pg.Value::Numeric(s) => assert_eq(s, "1234567890123456789.123456789")
    _ => fail("expected Numeric")
  }
}

///|
test "decode timestamp / uuid / json" {
  match @pg.decode_value(1114, Some("2024-01-02 03:04:05")) {
    @pg.Value::Timestamp(s) => assert_eq(s, "2024-01-02 03:04:05")
    _ => fail("expected Timestamp")
  }
  match @pg.decode_value(2950, Some("550e8400-e29b-41d4-a716-446655440000")) {
    @pg.Value::Uuid(s) => assert_eq(s, "550e8400-e29b-41d4-a716-446655440000")
    _ => fail("expected Uuid")
  }
  match @pg.decode_value(114, Some("{\"a\":1}")) {
    @pg.Value::Json(s) => assert_eq(s, "{\"a\":1}")
    _ => fail("expected Json")
  }
}

///|
test "decode int array" {
  match @pg.decode_value(1007, Some("{1,2,3}")) {
    @pg.Value::ArrayValue(xs) => {
      assert_eq(xs.length(), 3)
      match xs[0] {
        @pg.Value::Int(n) => assert_eq(n, 1L)
        _ => fail("expected Int element")
      }
    }
    _ => fail("expected ArrayValue")
  }
}

///|
test "decode text array with quotes and comma" {
  match @pg.decode_value(1009, Some("{\"a\",\"b,c\"}")) {
    @pg.Value::ArrayValue(xs) => {
      assert_eq(xs.length(), 2)
      match xs[1] {
        @pg.Value::Str(s) => assert_eq(s, "b,c")
        _ => fail("expected quoted element")
      }
    }
    _ => fail("expected ArrayValue")
  }
}
