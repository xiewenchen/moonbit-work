///|
/// PostgreSQL v3 线协议：前端消息构造 + 后端消息解析（纯逻辑层）。
///
/// 参考 https://www.postgresql.org/docs/current/protocol-message-formats.html
/// 与 RESP/HTTP 一样，这一层不碰 socket，可在所有后端（含 wasm-gc）测试。

///|
pub suberror DecodeError {
  UnexpectedEof(String)
  Malformed(String)
}

///|
/// 协议版本 3.0 = 0x00030000。
const PROTOCOL_V3 : Int = 196608

// ---------------------------------------------------------------------------
// 读写辅助
// ---------------------------------------------------------------------------

///|
/// 安全取字节：越界返回 `default`（**绝不 panic**）。
///
/// 安全约定：所有接受 `pos`/`index` 的解析函数入口都要**同时**校验上下界
/// （`pos < 0 || pos >= b.length()`）；而字节读取一律走本函数作为兜底 ——
/// 只查上界（如 `pos + 2 > len`）在负 `pos` 下会失效并越界 panic。
pub fn safe_byte(b : Bytes, i : Int, default : Byte) -> Byte {
  if i < 0 || i >= b.length() {
    default
  } else {
    b[i]
  }
}

///|
/// 安全取字节：越界返回 `None`。
pub fn safe_get(b : Bytes, i : Int) -> Byte? {
  if i < 0 || i >= b.length() {
    None
  } else {
    Some(b[i])
  }
}

///|
fn put_cstring(buf : Buffer, s : String) -> Unit {
  buf.write_string_utf8(s)
  buf.write_byte((0).to_byte())
}

///|
fn put_i16(buf : Buffer, n : Int) -> Unit {
  buf.write_uint16_be(n.to_uint16())
}

///|
fn put_i32(buf : Buffer, n : Int) -> Unit {
  buf.write_int_be(n)
}

///|
fn read_u16_be(b : Bytes, pos : Int) -> Int raise DecodeError {
  if pos < 0 || pos + 2 > b.length() {
    raise UnexpectedEof("u16 at \{pos}")
  }
  (safe_byte(b, pos, 0).to_int() << 8) | safe_byte(b, pos + 1, 0).to_int()
}

///|
fn read_i32_be(b : Bytes, pos : Int) -> Int raise DecodeError {
  if pos < 0 || pos + 4 > b.length() {
    raise UnexpectedEof("i32 at \{pos}")
  }
  (safe_byte(b, pos, 0).to_int() << 24) |
  (safe_byte(b, pos + 1, 0).to_int() << 16) |
  (safe_byte(b, pos + 2, 0).to_int() << 8) |
  safe_byte(b, pos + 3, 0).to_int()
}

///|
fn read_cstring(b : Bytes, pos : Int) -> (String, Int) raise DecodeError {
  if pos < 0 {
    raise UnexpectedEof("invalid pos \{pos} for cstring")
  }
  let n = b.length()
  let mut i = pos
  while i < n {
    if safe_byte(b, i, 1) == (0).to_byte() {
      return (@utf8.decode_lossy(b.clamped_view(start=pos, end=i)), i + 1)
    }
    i = i + 1
  }
  raise UnexpectedEof("unterminated cstring at \{pos}")
}

///|
/// 读一串以空串结尾的 cstring（用于 SASL 机制列表）。
fn read_cstring_list(b : Bytes, pos : Int) -> Array[String] raise DecodeError {
  let out : Array[String] = []
  let mut p = pos
  while true {
    let (s, next) = read_cstring(b, p)
    p = next
    if s == "" {
      return out
    }
    out.push(s)
  }
  out
}

// ---------------------------------------------------------------------------
// 前端消息
// ---------------------------------------------------------------------------

///|
/// 一条前端消息：`<tag><int32 length><payload>`（length 含自身，不含 tag）。
pub(all) struct FrontendMessage {
  tag : Byte
  payload : Bytes
}

///|
pub fn FrontendMessage::to_bytes(self : FrontendMessage) -> Bytes {
  let buf = Buffer()
  buf.write_byte(self.tag)
  put_i32(buf, self.payload.length() + 4)
  buf.write_bytes(self.payload)
  buf.to_bytes()
}

///|
fn tagged(tag : Char, payload : Bytes) -> FrontendMessage {
  { tag: tag.to_int().to_byte(), payload, }
}

///|
/// `SSLRequest`：建立连接后先发它协商是否使用 TLS（响应单字节 `S`/`N`）。
pub fn ssl_request() -> Bytes {
  let buf = Buffer()
  put_i32(buf, 8)
  put_i32(buf, 80877103)
  buf.to_bytes()
}

///|
/// `StartupMessage`：无 tag，`<int32 length><int32 version><k\0v\0...>\0`。
pub fn startup_message(user : String, database : String) -> Bytes {
  let body = Buffer()
  put_i32(body, PROTOCOL_V3)
  put_cstring(body, "user")
  put_cstring(body, user)
  put_cstring(body, "database")
  put_cstring(body, database)
  body.write_byte((0).to_byte())
  let body_bytes = body.to_bytes()
  let out = Buffer()
  put_i32(out, body_bytes.length() + 4)
  out.write_bytes(body_bytes)
  out.to_bytes()
}

///|
/// 简单查询 `Q`。
pub fn simple_query(sql : String) -> FrontendMessage {
  let p = Buffer()
  put_cstring(p, sql)
  tagged('Q', p.to_bytes())
}

///|
/// 密码消息 `p`。
pub fn password_message(password : String) -> FrontendMessage {
  let p = Buffer()
  put_cstring(p, password)
  tagged('p', p.to_bytes())
}

///|
/// `Sync` `S`。
pub fn sync_message() -> FrontendMessage {
  tagged('S', @utf8.encode(""))
}

///|
/// `SASLInitialResponse`（`p`）：机制名 + 初始响应。
pub fn sasl_initial_response(
  mechanism : String,
  data : Bytes,
) -> FrontendMessage {
  let p = Buffer()
  put_cstring(p, mechanism)
  put_i32(p, data.length())
  p.write_bytes(data)
  tagged('p', p.to_bytes())
}

///|
/// `SASLResponse`（`p`）：后续 SASL 响应。
pub fn sasl_response(data : Bytes) -> FrontendMessage {
  tagged('p', data)
}

///|
/// `Terminate` `X`。
pub fn terminate_message() -> FrontendMessage {
  tagged('X', @utf8.encode(""))
}

///|
/// `Parse` `P`：准备一条（可带参数的）语句。
pub fn parse_message(
  name : String,
  sql : String,
  param_type_oids : Array[Int],
) -> FrontendMessage {
  let p = Buffer()
  put_cstring(p, name)
  put_cstring(p, sql)
  put_i16(p, param_type_oids.length())
  for oid in param_type_oids {
    put_i32(p, oid)
  }
  tagged('P', p.to_bytes())
}

///|
/// `Bind` `B`：把参数绑定到门户（参数与结果都用文本格式）。
pub fn bind_message(
  portal : String,
  statement : String,
  params : Array[Bytes?],
) -> FrontendMessage {
  let p = Buffer()
  put_cstring(p, portal)
  put_cstring(p, statement)
  put_i16(p, 0) // 参数格式码数量 = 0（全文本）
  put_i16(p, params.length())
  for param in params {
    match param {
      Some(v) => {
        put_i32(p, v.length())
        p.write_bytes(v)
      }
      None => put_i32(p, -1)
    }
  }
  put_i16(p, 0) // 结果格式码数量 = 0（全文本）
  tagged('B', p.to_bytes())
}

///|
/// `Describe` `D`：请求门户的结果描述。
pub fn describe_portal_message(portal : String) -> FrontendMessage {
  let p = Buffer()
  p.write_byte('P'.to_int().to_byte())
  put_cstring(p, portal)
  tagged('D', p.to_bytes())
}

///|
/// `Execute` `E`。
pub fn execute_message(portal : String, max_rows : Int) -> FrontendMessage {
  let p = Buffer()
  put_cstring(p, portal)
  put_i32(p, max_rows)
  tagged('E', p.to_bytes())
}

// ---------------------------------------------------------------------------
// 后端消息
// ---------------------------------------------------------------------------

///|
/// 认证请求。
pub(all) enum AuthRequest {
  Ok
  CleartextPassword
  MD5Password(Bytes)
  SASL(Array[String])
  SASLContinue(String)
  SASLFinal(String)
  Other(Int)
} derive(Eq, Debug)

///|
/// 结果集中的一列描述。
pub(all) struct Field {
  name : String
  type_oid : Int
  type_size : Int
  format : Int
} derive(Eq, Debug)

///|
/// 服务器错误/通知（只保留常用字段）。
pub(all) struct PgError {
  severity : String
  code : String
  message : String
  detail : String
  hint : String
} derive(Eq, Debug)

///|
/// 一条后端消息。
pub(all) enum BackendMessage {
  Authentication(AuthRequest)
  ParameterStatus(String, String)
  BackendKeyData(Int, Int)
  ReadyForQuery(Byte)
  RowDescription(Array[Field])
  DataRow(Array[Bytes?])
  CommandComplete(String)
  EmptyQueryResponse
  ErrorResponse(PgError)
  NoticeResponse(PgError)
  ParseComplete
  BindComplete
  NoData
  ParameterDescription(Array[Int])
  Unknown(Byte, Bytes)
} derive(Eq, Debug)

///|
fn parse_authentication(b : Bytes) -> BackendMessage raise DecodeError {
  let code = read_i32_be(b, 0)
  match code {
    0 => Authentication(Ok)
    3 => Authentication(CleartextPassword)
    5 => {
      if b.length() < 8 {
        raise UnexpectedEof("md5 salt")
      }
      Authentication(MD5Password(b.clamped_view(start=4, end=8).to_owned()))
    }
    10 => {
      let mechs = read_cstring_list(b, 4)
      Authentication(SASL(mechs))
    }
    11 =>
      Authentication(SASLContinue(@utf8.decode_lossy(b.clamped_view(start=4))))
    12 => Authentication(SASLFinal(@utf8.decode_lossy(b.clamped_view(start=4))))
    other => Authentication(Other(other))
  }
}

///|
fn parse_row_description(b : Bytes) -> BackendMessage raise DecodeError {
  let count = read_u16_be(b, 0)
  let mut pos = 2
  let fields : Array[Field] = []
  for i = 0; i < count; i = i + 1 {
    let (name, p1) = read_cstring(b, pos)
    let type_oid = read_i32_be(b, p1 + 6)
    let type_size = read_u16_be(b, p1 + 10)
    let format = read_u16_be(b, p1 + 16)
    fields.push({ name, type_oid, type_size, format, })
    pos = p1 + 18
  }
  RowDescription(fields)
}

///|
fn parse_data_row(b : Bytes) -> BackendMessage raise DecodeError {
  let count = read_u16_be(b, 0)
  let mut pos = 2
  let values : Array[Bytes?] = []
  for i = 0; i < count; i = i + 1 {
    let len = read_i32_be(b, pos)
    pos = pos + 4
    if len < 0 {
      values.push(None)
    } else {
      if len > b.length() - pos {
        raise UnexpectedEof("data row value")
      }
      values.push(Some(b.clamped_view(start=pos, end=pos + len).to_owned()))
      pos = pos + len
    }
  }
  DataRow(values)
}

///|
fn parse_error(b : Bytes) -> PgError raise DecodeError {
  let n = b.length()
  let mut pos = 0
  let mut severity = ""
  let mut code = ""
  let mut message = ""
  let mut detail = ""
  let mut hint = ""
  while pos < n {
    let field_type = safe_byte(b, pos, 0).to_int()
    if field_type == 0 {
      break
    }
    let (value, next) = read_cstring(b, pos + 1)
    if field_type == 'S'.to_int() {
      severity = value
    } else if field_type == 'C'.to_int() {
      code = value
    } else if field_type == 'M'.to_int() {
      message = value
    } else if field_type == 'D'.to_int() {
      detail = value
    } else if field_type == 'H'.to_int() {
      hint = value
    }
    pos = next
  }
  { severity, code, message, detail, hint, }
}

///|
fn parse_payload(
  tag : Byte,
  payload : Bytes,
) -> BackendMessage raise DecodeError {
  if tag == b'R' {
    parse_authentication(payload)
  } else if tag == b'S' {
    let (name, p1) = read_cstring(payload, 0)
    let (value, _) = read_cstring(payload, p1)
    ParameterStatus(name, value)
  } else if tag == b'K' {
    BackendKeyData(read_i32_be(payload, 0), read_i32_be(payload, 4))
  } else if tag == b'Z' {
    if payload.length() < 1 {
      raise UnexpectedEof("ReadyForQuery")
    }
    ReadyForQuery(payload[0])
  } else if tag == b'T' {
    parse_row_description(payload)
  } else if tag == b'D' {
    parse_data_row(payload)
  } else if tag == b'C' {
    let (t, _) = read_cstring(payload, 0)
    CommandComplete(t)
  } else if tag == b'I' {
    EmptyQueryResponse
  } else if tag == b'E' {
    ErrorResponse(parse_error(payload))
  } else if tag == b'N' {
    NoticeResponse(parse_error(payload))
  } else if tag == b'1' {
    ParseComplete
  } else if tag == b'2' {
    BindComplete
  } else if tag == b'n' {
    NoData
  } else if tag == b't' {
    let count = read_u16_be(payload, 0)
    let oids : Array[Int] = []
    let mut pos = 2
    for i = 0; i < count; i = i + 1 {
      oids.push(read_i32_be(payload, pos))
      pos = pos + 4
    }
    ParameterDescription(oids)
  } else {
    Unknown(tag, payload)
  }
}

///|
/// 解析一条后端消息，返回 `(消息, 下一位置)`。
pub fn parse_backend(
  input : Bytes,
  pos : Int,
) -> (BackendMessage, Int) raise DecodeError {
  // 防御：负数位置会越界 panic（fuzz 实证）
  if pos < 0 || pos >= input.length() {
    raise UnexpectedEof("no message at \{pos}")
  }
  let tag = safe_byte(input, pos, 0)
  let len = read_i32_be(input, pos + 1)
  if len < 4 {
    raise Malformed("bad message length \{len}")
  }
  // 用减法比较，避免 `pos + 1 + len` 溢出为负而绕过长度检查
  if len > input.length() - pos - 1 {
    raise UnexpectedEof("message body incomplete")
  }
  let end = pos + 1 + len
  let payload = input.clamped_view(start=pos + 5, end~).to_owned()
  (parse_payload(tag, payload), end)
}
