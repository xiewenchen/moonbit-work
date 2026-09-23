///|
/// RESP 编解码测试。

///|
test "decode simple string" {
  let input = @utf8.encode("+OK\r\n")
  let (v, next) = @redis.decode(input, 0)
  assert_eq(v, @redis.Resp::SimpleString("OK"))
  assert_eq(next, 5)
}

///|
test "decode error" {
  let input = @utf8.encode("-ERR unknown command\r\n")
  let (v, _) = @redis.decode(input, 0)
  assert_eq(v, @redis.Resp::SimpleError("ERR unknown command"))
}

///|
test "decode integer" {
  let input = @utf8.encode(":42\r\n")
  let (v, next) = @redis.decode(input, 0)
  assert_eq(v, @redis.Resp::Integer(42L))
  assert_eq(next, 5)
}

///|
test "decode negative integer" {
  let (v, _) = @redis.decode(@utf8.encode(":-123\r\n"), 0)
  assert_eq(v, @redis.Resp::Integer(-123L))
}

///|
test "decode bulk string" {
  let (v, next) = @redis.decode(@utf8.encode("$3\r\nfoo\r\n"), 0)
  assert_eq(v, @redis.Resp::BulkString(@utf8.encode("foo")))
  assert_eq(next, 9)
}

///|
test "decode null bulk" {
  let (v, _) = @redis.decode(@utf8.encode("$-1\r\n"), 0)
  assert_eq(v, @redis.Resp::NullBulk)
}

///|
test "decode array" {
  let (v, next) = @redis.decode(@utf8.encode("*2\r\n$3\r\nfoo\r\n:7\r\n"), 0)
  let expected : Array[@redis.Resp] = [
    @redis.Resp::BulkString(@utf8.encode("foo")),
    @redis.Resp::Integer(7L),
  ]
  assert_eq(v, @redis.Resp::ArrayValue(expected))
  assert_eq(next, 17)
}

///|
test "decode null array" {
  let (v, _) = @redis.decode(@utf8.encode("*-1\r\n"), 0)
  assert_eq(v, @redis.Resp::NullArray)
}

///|
test "encode round-trips through decode" {
  let values : Array[@redis.Resp] = [
    @redis.Resp::SimpleString("OK"),
    @redis.Resp::SimpleError("ERR bad"),
    @redis.Resp::Integer(-9223372036854775807L),
    @redis.Resp::BulkString(@utf8.encode("héllo, 世界")),
    @redis.Resp::NullBulk,
    @redis.Resp::ArrayValue([
      @redis.Resp::Integer(1L),
      @redis.Resp::BulkString(@utf8.encode("x")),
      @redis.Resp::NullArray,
    ]),
  ]
  for v in values {
    let bytes = v.encode()
    let (back, next) = @redis.decode(bytes, 0)
    assert_eq(back, v)
    assert_eq(next, bytes.length())
  }
}

///|
test "decode into a stream with an offset" {
  let stream = @utf8.encode("+PING\r\n:1\r\n")
  let (first, pos) = @redis.decode(stream, 0)
  assert_eq(first, @redis.Resp::SimpleString("PING"))
  let (second, pos2) = @redis.decode(stream, pos)
  assert_eq(second, @redis.Resp::Integer(1L))
  assert_eq(pos2, stream.length())
}

///|
test "decode bad input raises" {
  let raised : Bool = try @redis.decode(@utf8.encode("?what\r\n"), 0) catch {
    _ => true
  } noraise {
    _ => false
  }
  assert_eq(raised, true)
}
