///|
/// RESP（REdis Serialization Protocol）编解码。
///
/// 这是「纯 MoonBit 自研协议」路线的第一个模块：不依赖任何 C 绑定，
/// 只用 core + 内存字节操作，因此可以在所有后端（含 wasm-gc）上测试。
///
/// 协议参考：https://redis.io/docs/latest/develop/reference/protocol-spec/
///
/// 目前实现 RESP2 的全部类型 + RESP3 的 null/数组语义（`$-1` / `*-1` 统一为 Null）。
///
/// ## 安全约定
///
/// 所有接受 `pos` 的解析函数入口**必须同时校验上下界**
/// （`pos < 0 || pos >= input.length()`）；字节读取一律走 `safe_byte` 兜底，
/// 以免漏校验时越界 panic（panic 会崩掉整个进程，无法在 MoonBit 里捕获）。

///|
/// 安全取字节：越界返回 `default`（绝不 panic）。
pub fn safe_byte(b : Bytes, i : Int, default : Byte) -> Byte {
  if i < 0 || i >= b.length() {
    default
  } else {
    b[i]
  }
}

///|
/// 一个 RESP 值。
pub(all) enum Resp {
  /// `+OK\r\n` 简单字符串
  SimpleString(String)
  /// `-ERR message\r\n` 错误
  SimpleError(String)
  /// `:42\r\n` 整数
  Integer(Int64)
  /// `$3\r\nfoo\r\n` 批量字符串（二进制安全）
  BulkString(Bytes)
  /// `$-1\r\n` 空批量字符串
  NullBulk
  /// `*2\r\n...` 数组
  ArrayValue(Array[Resp])
  /// `*-1\r\n` 空数组
  NullArray
} derive(Eq, Debug)

///|
/// 解码失败。
pub suberror DecodeError {
  /// 数据不完整，需读更多字节后重试
  UnexpectedEof(String)
  /// 数据格式非法
  Malformed(String)
}

///|
/// 把 RESP 值编码成 wire 字节。
pub fn Resp::encode(self : Resp) -> Bytes {
  let buf = Buffer()
  self.write_to(buf)
  buf.to_bytes()
}

///|
fn Resp::write_to(self : Resp, buf : Buffer) -> Unit {
  match self {
    SimpleString(s) => {
      buf.write_byte(b'+')
      buf.write_string_utf8(s)
      buf.write_string_utf8("\r\n")
    }
    SimpleError(s) => {
      buf.write_byte(b'-')
      buf.write_string_utf8(s)
      buf.write_string_utf8("\r\n")
    }
    Integer(n) => {
      buf.write_byte(b':')
      buf.write_string_utf8(n.to_string())
      buf.write_string_utf8("\r\n")
    }
    BulkString(bs) => {
      buf.write_byte(b'$')
      buf.write_string_utf8(bs.length().to_string())
      buf.write_string_utf8("\r\n")
      buf.write_bytes(bs)
      buf.write_string_utf8("\r\n")
    }
    NullBulk => buf.write_string_utf8("$-1\r\n")
    ArrayValue(items) => {
      buf.write_byte(b'*')
      buf.write_string_utf8(items.length().to_string())
      buf.write_string_utf8("\r\n")
      for item in items {
        item.write_to(buf)
      }
    }
    NullArray => buf.write_string_utf8("*-1\r\n")
  }
}

///|
/// 从 `input` 的 `pos` 处解码一个 RESP 值，返回 `(值, 下一位置)`。
const MAX_NESTING_DEPTH : Int = 64

///|
/// 从 `input` 的 `pos` 处解码一个 RESP 值，返回 `(值, 下一位置)`。
pub fn decode(input : Bytes, pos : Int) -> (Resp, Int) raise DecodeError {
  decode_at(input, pos, 0)
}

///|
/// 带嵌套深度的解码实现。
/// **深度上限**是必需的：数组可自嵌套，恶意报文（如 `*1\r\n` × 数十万）会导致**栈溢出**。
fn decode_at(
  input : Bytes,
  pos : Int,
  depth : Int,
) -> (Resp, Int) raise DecodeError {
  if depth > MAX_NESTING_DEPTH {
    raise Malformed("RESP nesting too deep (>\{MAX_NESTING_DEPTH})")
  }
  let n = input.length()
  if pos < 0 || pos >= n {
    raise UnexpectedEof("unexpected end of input at \{pos}")
  }
  let prefix = safe_byte(input, pos, 0)
  match prefix {
    b'+' => {
      let (view, next) = read_line(input, pos + 1)
      (SimpleString(@utf8.decode_lossy(view)), next)
    }
    b'-' => {
      let (view, next) = read_line(input, pos + 1)
      (SimpleError(@utf8.decode_lossy(view)), next)
    }
    b':' => {
      let (view, next) = read_line(input, pos + 1)
      (Integer(parse_int64(view)), next)
    }
    b'$' => {
      let (view, next) = read_line(input, pos + 1)
      let len = parse_int64(view)
      if len < 0L {
        (NullBulk, next)
      } else {
        // 用 Int64 比较，避免 `len.to_int()` 截断 / `next + l` 溢出为负而绕过检查
        let remaining = (n - next).to_int64()
        if len > remaining - 2L {
          raise UnexpectedEof("bulk string length \{len} out of range")
        }
        let l = len.to_int()
        let end = next + l
        let body = input.clamped_view(start=next, end~)
        (BulkString(body.to_owned()), end + 2)
      }
    }
    b'*' => {
      let (view, next) = read_line(input, pos + 1)
      let count = parse_int64(view)
      if count < 0L {
        (NullArray, next)
      } else {
        let items : Array[Resp] = []
        let mut p = next
        let mut i : Int64 = 0L
        while i < count {
          let (v, np) = decode_at(input, p, depth + 1)
          items.push(v)
          p = np
          i = i + 1L
        }
        (ArrayValue(items), p)
      }
    }
    other => raise Malformed("unknown RESP prefix: \{other.to_int()}")
  }
}

///|
/// 读取到下一个 `\r\n` 为止的一行（不含 CRLF），返回 `(内容视图, 下一位置)`。
fn read_line(input : Bytes, pos : Int) -> (BytesView, Int) raise DecodeError {
  let n = input.length()
  let mut i = pos
  while i + 1 < n {
    if safe_byte(input, i, 0) == b'\r' && safe_byte(input, i + 1, 0) == b'\n' {
      return (input.clamped_view(start=pos, end=i), i + 2)
    }
    i = i + 1
  }
  raise UnexpectedEof("CRLF not found after position \{pos}")
}

///|
/// 把一段 ASCII 字节解析为 `Int64`（支持前导 `-`）。
fn parse_int64(view : BytesView) -> Int64 raise DecodeError {
  let n = view.length()
  if n == 0 {
    raise Malformed("empty integer")
  }
  let mut neg = false
  let mut i = 0
  if view.at(0) == b'-' {
    neg = true
    i = 1
  }
  if i >= n {
    raise Malformed("invalid integer: only a sign")
  }
  let mut acc : Int64 = 0L
  while i < n {
    let c = view.at(i)
    if c < b'0' || c > b'9' {
      raise Malformed("invalid integer digit at \{i}")
    }
    acc = acc * 10L + (c.to_int() - 48).to_int64()
    i = i + 1
  }
  if neg {
    -acc
  } else {
    acc
  }
}
