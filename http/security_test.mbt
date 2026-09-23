///|
/// 安全回归测试：整数溢出与畸形输入**不得 panic**（panic 会崩掉整个进程）。
///
/// 背景：`parse_decimal` / `parse_hex_size` 曾因 32 位溢出把巨值绕回成小值，
/// 溢出的负数还会让解析位置回退 → `input[负数]` panic → **整个服务进程退出**
/// （远程 DoS）。这些用例锁住修复。

///|
/// 解析请求，返回错误构造器名或 "ok"。
fn parse_outcome(raw : String) -> String {
  let bytes = @utf8.encode(raw)
  let r : String = try {
    let (_req, _) = @http.Request::parse(bytes, 0)
    "ok"
  } catch {
    @http.Malformed(_) => "Malformed"
    @http.UnexpectedEof(_) => "UnexpectedEof"
    @http.PayloadTooLarge(_) => "PayloadTooLarge"
  } noraise {
    v => v
  }
  r
}

///|
test "content-length 溢出（2^32+4）被拒而非绕回" {
  // 若绕回会变成 4，从而「接受」并只读 4 字节（可走私）
  assert_eq(
    parse_outcome(
      "POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 4294967300\r\n\r\nAAAA",
    ),
    "Malformed",
  )
}

///|
test "content-length 溢出（2^32+100）被拒" {
  assert_eq(
    parse_outcome(
      "POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 4294967396\r\n\r\nAAAA",
    ),
    "Malformed",
  )
}

///|
test "超大 content-length 被拒" {
  assert_eq(
    parse_outcome(
      "POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 99999999999999\r\n\r\nAAAA",
    ),
    "Malformed",
  )
}

///|
test "负数 content-length 被拒" {
  assert_eq(
    parse_outcome("POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: -1\r\n\r\n"),
    "Malformed",
  )
}

///|
test "边界值 content-length（2147483639）不 panic" {
  // 合法大数但超过 8MiB 上限 → PayloadTooLarge，绝不能 panic
  let o = parse_outcome(
    "POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 2147483639\r\n\r\n",
  )
  assert_eq(o == "PayloadTooLarge" || o == "Malformed", true)
}

///|
/// chunked 解码结果。
fn chunk_outcome(raw : String) -> String {
  let bytes = @utf8.encode(raw)
  let r : String = try {
    let _ = @http.decode_chunked(bytes, 0, 8388608)
    "ok"
  } catch {
    @http.Malformed(_) => "Malformed"
    @http.PayloadTooLarge(_) => "PayloadTooLarge"
    @http.UnexpectedEof(_) => "UnexpectedEof"
  } noraise {
    v => v
  }
  r
}

///|
test "超大 chunk 声明被拒（不得 panic）" {
  // FFFFFF00 会绕回成负数 → 曾导致解析位置回退 → panic 崩进程
  let o = chunk_outcome("FFFFFF00\r\n")
  assert_eq(o == "Malformed" || o == "PayloadTooLarge", true)
}

///|
test "chunk size 溢出（16 个 F）被拒" {
  let o = chunk_outcome("FFFFFFFFFFFFFFFF\r\n")
  assert_eq(o == "Malformed" || o == "PayloadTooLarge", true)
}

///|
test "畸形 chunk size（非 hex）被拒" {
  assert_eq(chunk_outcome("zz\r\n"), "Malformed")
}

///|
test "空 chunk size 被拒" {
  assert_eq(chunk_outcome("\r\n"), "Malformed")
}

///|
test "正常 chunked 仍能解码" {
  assert_eq(chunk_outcome("4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"), "ok")
}

///|
test "decode_chunked 传入负数位置不 panic" {
  // 防御：位置非法应安全返回（不越界访问）
  let bytes = @utf8.encode("4\r\nWiki\r\n0\r\n\r\n")
  let r : String = try {
    let _ = @http.decode_chunked(bytes, -5, 8388608)
    "ok"
  } catch {
    _ => "err"
  } noraise {
    v => v
  }
  assert_eq(r == "ok" || r == "err", true)
}
