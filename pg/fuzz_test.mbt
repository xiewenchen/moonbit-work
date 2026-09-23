///|
/// 模糊测试：PostgreSQL v3 协议解析器**不得 panic**。
///
/// 与 `http/fuzz_test.mbt` 同理：panic 无法 catch，能跑完即通过。

///|
fn pg_random_bytes(rnd : @random.Rand, n : Int) -> Bytes {
  let buf = Buffer()
  for i = 0; i < n; i = i + 1 {
    buf.write_byte(rnd.int(limit=256).to_byte())
  }
  buf.to_bytes()
}

///|
fn pg_swallow(f : () -> Unit raise) -> Unit {
  try f() catch {
    _ => ()
  } noraise {
    _ => ()
  }
}

///|
test "fuzz: pg parse_backend 随机字节不 panic" {
  let rnd = @random.Rand::new()
  for i = 0; i < 4000; i = i + 1 {
    let b = pg_random_bytes(rnd, rnd.int(limit=256))
    // 从合法位置解析
    pg_swallow(fn() raise { let _ = @pg.parse_backend(b, 0) })
    // 从任意（含负数/越界）位置解析
    let pos = rnd.int(limit=512) - 256
    pg_swallow(fn() raise { let _ = @pg.parse_backend(b, pos) })
  }
}

///|
test "fuzz: pg parse_backend 合法 tag + 随机 payload 不 panic" {
  let rnd = @random.Rand::new()
  // 各类后端消息 tag
  let tags : Array[Byte] = [
    b'R', b'S', b'K', b'Z', b'T', b'D', b'C', b'I', b'E', b'N', b'1', b'2', b'n',
    b'A', b'G', b'H', b'W', b'd', b'c', b's', b't', b'v',
  ]
  for i = 0; i < 4000; i = i + 1 {
    let tag = tags[rnd.int(limit=tags.length())]
    let payload = pg_random_bytes(rnd, rnd.int(limit=128))
    let buf = Buffer()
    buf.write_byte(tag)
    // length = 4 + payload 长度
    let len = payload.length() + 4
    buf.write_byte(((len >> 24) & 255).to_byte())
    buf.write_byte(((len >> 16) & 255).to_byte())
    buf.write_byte(((len >> 8) & 255).to_byte())
    buf.write_byte((len & 255).to_byte())
    buf.write_bytes(payload)
    let b = buf.to_bytes()
    pg_swallow(fn() raise { let _ = @pg.parse_backend(b, 0) })
  }
}

///|
test "fuzz: pg parse_backend 随机长度字段（含巨大/负数）不 panic" {
  let rnd = @random.Rand::new()
  for i = 0; i < 4000; i = i + 1 {
    let payload = pg_random_bytes(rnd, rnd.int(limit=64))
    let buf = Buffer()
    buf.write_byte(b'R')
    // 随机 4 字节长度（可能巨大、负数、0..）
    for j = 0; j < 4; j = j + 1 {
      buf.write_byte(rnd.int(limit=256).to_byte())
    }
    buf.write_bytes(payload)
    let b = buf.to_bytes()
    pg_swallow(fn() raise { let _ = @pg.parse_backend(b, 0) })
  }
}

///|
test "fuzz: pg decode_value 任意 oid/文本不 panic" {
  let rnd = @random.Rand::new()
  let oids : Array[Int] = [
    16, 20, 21, 23, 25, 26, 114, 700, 701, 1042, 1043, 1082, 1083, 1114, 1184, 1700,
    2950, 3802, 1009, 1007, 0, -1, 999999, 2147483647,
  ]
  for i = 0; i < 6000; i = i + 1 {
    let oid = oids[rnd.int(limit=oids.length())]
    // 随机文本（含畸形：空、巨大数字、错误数组、截断转义、未闭合引号）
    let s = @utf8.decode_lossy(pg_random_bytes(rnd, rnd.int(limit=32)))
    pg_swallow(fn() { let _ = @pg.decode_value(oid, Some(s)) })
    pg_swallow(fn() { let _ = @pg.decode_value(oid, None) })
  }
}

///|
test "fuzz: pg decode_value 畸形数组/时间戳样式输入不 panic" {
  let rnd = @random.Rand::new()
  let samples : Array[String] = [
    "{", "}", "{}", "{1,2,3}", "{a,b}", "{\"x\"}", "{\"a\\\",b\"}", "{\"unterminated",
    "{NULL,NULL}", "{{{{{{{{", "}}}}}}}}", "2020-01-01 00:00:00", "not-a-timestamp",
    "", "  ", "\\", "\"", "[1,2]", "1e999999", "-0", "99999999999999999999999999",
  ]
  for i = 0; i < 4000; i = i + 1 {
    let s = samples[rnd.int(limit=samples.length())]
    let oid = if rnd.int(limit=2) == 0 { 1009 } else { 1184 }
    pg_swallow(fn() { let _ = @pg.decode_value(oid, Some(s)) })
  }
}

///|
test "SCRAM: 恶意巨大的 iterations 不会挂死（被夹到上限）" {
  // 解析出巨大 iterations
  let (_, _, iters) = @pg.parse_server_first("r=abc,s=AAA,i=2147483647")
  assert_eq(iters > 0, true)
  // 用它算 SCRAM 必须在合理时间内返回（内部夹到 1e6 上限）
  let t0 = @env.now()
  let _ = @pg.scram_proof("pw", "AAA", iters, "auth")
  let elapsed = @env.now() - t0
  assert_eq(elapsed < 30000UL, true) // 30 秒内必定完成
}

///|
test "SCRAM: iterations 溢出文本不产生异常值" {
  // 溢出会被饱和到 Int 最大值（而非绕回成负数/小值）
  let (_, _, iters) = @pg.parse_server_first(
    "r=abc,s=AAA,i=99999999999999999999",
  )
  assert_eq(iters > 0, true)
}

///|
test "PG 数值解析：恶意指数不挂死" {
  // `1e2000000000` 曾可能造成 CPU 挂死（exp 驱动循环）
  let t0 = @env.now()
  let _ = @pg.decode_value(701, Some("1e2000000000"))
  let _ = @pg.decode_value(701, Some("1e-2000000000"))
  let _ = @pg.decode_value(701, Some("9.99e999999"))
  let elapsed = @env.now() - t0
  assert_eq(elapsed < 5000UL, true)
}
