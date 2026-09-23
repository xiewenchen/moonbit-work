///|
/// 模糊测试（fuzz）：用随机与畸形输入轰击解析器，**断言不 panic**。
///
/// MoonBit 的 panic 无法 catch，一旦发生会让整个测试崩掉 —— 所以「能跑完」
/// 本身就是通过条件。这是崩溃类风险的兜底防线。

///|
/// 生成 `n` 个随机字节。
fn random_bytes(rnd : @random.Rand, n : Int) -> Bytes {
  let buf = Buffer()
  for i = 0; i < n; i = i + 1 {
    buf.write_byte(rnd.int(limit=256).to_byte())
  }
  buf.to_bytes()
}

///|
/// 把解析调用包成「吞掉所有 raise」——panic 仍会崩，正是我们要检测的。
fn swallow(f : () -> Unit raise) -> Unit {
  try f() catch {
    _ => ()
  } noraise {
    _ => ()
  }
}

///|
test "fuzz: Request::parse / Response::parse 随机字节不 panic" {
  let rnd = @random.Rand::new()
  for i = 0; i < 3000; i = i + 1 {
    let n = rnd.int(limit=512)
    let b = random_bytes(rnd, n)
    swallow(fn() raise { let _ = @http.Request::parse(b, 0) })
    swallow(fn() raise { let _ = @http.Response::parse(b, 0) })
    // 也从随机位置开始解析（含负数/越界位置）
    let pos = rnd.int(limit=1024) - 256
    swallow(fn() raise { let _ = @http.Request::parse(b, pos) })
    swallow(fn() raise { let _ = @http.Response::parse(b, pos) })
    swallow(fn() raise { let _ = @http.decode_chunked(b, pos, 4096) })
  }
}

///|
test "fuzz: 合法头部 + 随机 body/chunk 不 panic" {
  let rnd = @random.Rand::new()
  let prefixes : Array[String] = [
    "POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: ", "POST /x HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n",
    "GET /x HTTP/1.1\r\n", "HTTP/1.1 200 OK\r\nContent-Length: ", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
  ]
  for i = 0; i < 3000; i = i + 1 {
    let prefix = prefixes[rnd.int(limit=prefixes.length())]
    // 拼一个随机数字（可能是巨大值）
    let num = rnd.int(limit=1000000000).to_string()
    let tail = random_bytes(rnd, rnd.int(limit=64))
    let buf = Buffer()
    buf.write_string_utf8(prefix)
    buf.write_string_utf8(num)
    buf.write_string_utf8("\r\n\r\n")
    buf.write_bytes(tail)
    let b = buf.to_bytes()
    swallow(fn() raise { let _ = @http.Request::parse(b, 0) })
    swallow(fn() raise { let _ = @http.Response::parse(b, 0) })
    swallow(fn() raise { let _ = @http.decode_chunked(b, 0, 8192) })
  }
}

///|
test "fuzz: percent_decode 与 query 解析不 panic" {
  let rnd = @random.Rand::new()
  for i = 0; i < 3000; i = i + 1 {
    let b = random_bytes(rnd, rnd.int(limit=64))
    let s = @utf8.decode_lossy(b)
    swallow(fn() { let _ = @http.percent_decode(s) })
    // 造一个带 query 的请求
    let req_line = "GET /p?a=" + s + "&b=" + s + " HTTP/1.1\r\nHost: h\r\n\r\n"
    swallow(fn() raise {
      let (req, _) = @http.Request::parse(@utf8.encode(req_line), 0)
      let _ = req.query_params()
      let _ = req.query("a")
      let _ = req.path()
    })
  }
}
