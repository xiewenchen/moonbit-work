///|
/// 模糊测试：RESP 解析器**不得 panic**。

///|
fn rs_random_bytes(rnd : @random.Rand, n : Int) -> Bytes {
  let buf = Buffer()
  for i = 0; i < n; i = i + 1 {
    buf.write_byte(rnd.int(limit=256).to_byte())
  }
  buf.to_bytes()
}

///|
fn rs_swallow(f : () -> Unit raise) -> Unit {
  try f() catch {
    _ => ()
  } noraise {
    _ => ()
  }
}

///|
test "fuzz: redis decode 随机字节不 panic" {
  let rnd = @random.Rand::new()
  for i = 0; i < 5000; i = i + 1 {
    let b = rs_random_bytes(rnd, rnd.int(limit=256))
    rs_swallow(fn() raise { let _ = @redis.decode(b, 0) })
    let pos = rnd.int(limit=512) - 256
    rs_swallow(fn() raise { let _ = @redis.decode(b, pos) })
  }
}

///|
test "fuzz: redis decode 合法前缀 + 随机尾 不 panic" {
  let rnd = @random.Rand::new()
  let prefixes : Array[String] = [
    "+", "-", ":", "$", "*", "$-1\r\n", "*-1\r\n", "$99999999999999999999\r\n", "*99999999999999999999\r\n",
    "*3\r\n", "%2\r\n", "~2\r\n", ">2\r\n", "#t\r\n", ",\r\n", "(\r\n", "=\r\n",
    "_\r\n", "|1\r\n",
  ]
  for i = 0; i < 5000; i = i + 1 {
    let p = prefixes[rnd.int(limit=prefixes.length())]
    let tail = rs_random_bytes(rnd, rnd.int(limit=64))
    let buf = Buffer()
    buf.write_string_utf8(p)
    buf.write_bytes(tail)
    let b = buf.to_bytes()
    rs_swallow(fn() raise { let _ = @redis.decode(b, 0) })
  }
}

///|
test "fuzz: redis decode 深层嵌套数组不 panic" {
  let rnd = @random.Rand::new()
  for i = 0; i < 500; i = i + 1 {
    // 构造 *1 嵌套 N 层（可能很深）
    let depth = 1 + rnd.int(limit=200)
    let buf = Buffer()
    for j = 0; j < depth; j = j + 1 {
      buf.write_string_utf8("*1\r\n")
    }
    buf.write_string_utf8("+leaf\r\n")
    let b = buf.to_bytes()
    rs_swallow(fn() raise { let _ = @redis.decode(b, 0) })
  }
}

///|
test "fuzz: redis Resp::encode 往返不 panic" {
  let rnd = @random.Rand::new()
  for i = 0; i < 2000; i = i + 1 {
    let payload = rs_random_bytes(rnd, rnd.int(limit=64))
    let vals : Array[@redis.Resp] = [
      @redis.Resp::SimpleString(@utf8.decode_lossy(payload)),
      @redis.Resp::BulkString(payload),
      @redis.Resp::Integer(rnd.int(limit=1000000).to_int64()),
      @redis.Resp::ArrayValue([]),
    ]
    let v = vals[rnd.int(limit=vals.length())]
    let enc = v.encode()
    rs_swallow(fn() raise { let _ = @redis.decode(enc, 0) })
  }
}
