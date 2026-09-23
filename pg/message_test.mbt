///|
/// PostgreSQL 协议编解码测试（纯逻辑，跨后端可测）。

///|
fn cstr(buf : Buffer, s : String) -> Unit {
  buf.write_string_utf8(s)
  buf.write_byte((0).to_byte())
}

///|
fn build_backend(tag : Char, payload : Bytes) -> Bytes {
  let buf = Buffer()
  buf.write_byte(tag.to_int().to_byte())
  buf.write_int_be(payload.length() + 4)
  buf.write_bytes(payload)
  buf.to_bytes()
}

///|
test "startup message encodes protocol 3.0" {
  let b = @pg.startup_message("alice", "testdb")
  // 4(length) + 4(version) + 5("user\0") + 6("alice\0") + 9("database\0") + 7("testdb\0") + 1(终\0)
  assert_eq(b.length(), 36)
  assert_eq(b[4], (0).to_byte())
  assert_eq(b[5], (3).to_byte())
  assert_eq(b[6], (0).to_byte())
  assert_eq(b[7], (0).to_byte())
}

///|
test "simple query encoding" {
  let b = @pg.simple_query("SELECT 1").to_bytes()
  assert_eq(b[0], 'Q'.to_int().to_byte())
  assert_eq(b.length(), 1 + 4 + 9) // tag + len + "SELECT 1\0"
  assert_eq(b[5], 'S'.to_int().to_byte())
}

///|
test "parse AuthenticationOk" {
  let p = Buffer()
  p.write_int_be(0)
  let raw = build_backend('R', p.to_bytes())
  let (msg, next) = @pg.parse_backend(raw, 0)
  assert_eq(msg, @pg.BackendMessage::Authentication(@pg.AuthRequest::Ok))
  assert_eq(next, raw.length())
}

///|
test "parse cleartext password request" {
  let p = Buffer()
  p.write_int_be(3)
  let (msg, _) = @pg.parse_backend(build_backend('R', p.to_bytes()), 0)
  assert_eq(
    msg,
    @pg.BackendMessage::Authentication(@pg.AuthRequest::CleartextPassword),
  )
}

///|
test "parse md5 password request with salt" {
  let p = Buffer()
  p.write_int_be(5)
  p.write_bytes(
    Bytes::from_array([
      (1).to_byte(),
      (2).to_byte(),
      (3).to_byte(),
      (4).to_byte(),
    ]),
  )
  let (msg, _) = @pg.parse_backend(build_backend('R', p.to_bytes()), 0)
  assert_eq(
    msg,
    @pg.BackendMessage::Authentication(
      @pg.AuthRequest::MD5Password(
        Bytes::from_array([
          (1).to_byte(),
          (2).to_byte(),
          (3).to_byte(),
          (4).to_byte(),
        ]),
      ),
    ),
  )
}

///|
test "parse ReadyForQuery" {
  let p = Buffer()
  p.write_byte('I'.to_int().to_byte())
  let (msg, _) = @pg.parse_backend(build_backend('Z', p.to_bytes()), 0)
  assert_eq(msg, @pg.BackendMessage::ReadyForQuery('I'.to_int().to_byte()))
}

///|
test "parse ParameterStatus and BackendKeyData" {
  let p = Buffer()
  cstr(p, "server_version")
  cstr(p, "16.0")
  let (s, _) = @pg.parse_backend(build_backend('S', p.to_bytes()), 0)
  assert_eq(s, @pg.BackendMessage::ParameterStatus("server_version", "16.0"))
  let k = Buffer()
  k.write_int_be(1234)
  k.write_int_be(5678)
  let (b, _) = @pg.parse_backend(build_backend('K', k.to_bytes()), 0)
  assert_eq(b, @pg.BackendMessage::BackendKeyData(1234, 5678))
}

///|
test "parse RowDescription" {
  let p = Buffer()
  p.write_uint16_be((1).to_uint16()) // 列数
  cstr(p, "id")
  p.write_int_be(0) // table oid
  p.write_uint16_be((0).to_uint16()) // column id
  p.write_int_be(23) // type oid = int4
  p.write_uint16_be((4).to_uint16()) // type size
  p.write_int_be(-1) // type modifier
  p.write_uint16_be((0).to_uint16()) // format
  let (msg, _) = @pg.parse_backend(build_backend('T', p.to_bytes()), 0)
  assert_eq(
    msg,
    @pg.BackendMessage::RowDescription([
      { name: "id", type_oid: 23, type_size: 4, format: 0, },
    ]),
  )
}

///|
test "parse DataRow with a NULL" {
  let p = Buffer()
  p.write_uint16_be((2).to_uint16())
  p.write_int_be(2)
  p.write_bytes(Bytes::from_array([(104).to_byte(), (105).to_byte()])) // "hi"
  p.write_int_be(-1) // NULL
  let (msg, _) = @pg.parse_backend(build_backend('D', p.to_bytes()), 0)
  match msg {
    @pg.BackendMessage::DataRow(values) => {
      assert_eq(values.length(), 2)
      assert_eq(
        values[0],
        Some(Bytes::from_array([(104).to_byte(), (105).to_byte()])),
      )
      assert_eq(values[1], None)
    }
    _ => fail("expected DataRow")
  }
}

///|
test "parse CommandComplete" {
  let p = Buffer()
  cstr(p, "SELECT 1")
  let (msg, _) = @pg.parse_backend(build_backend('C', p.to_bytes()), 0)
  assert_eq(msg, @pg.BackendMessage::CommandComplete("SELECT 1"))
}

///|
test "parse ErrorResponse" {
  let p = Buffer()
  p.write_byte('S'.to_int().to_byte())
  cstr(p, "ERROR")
  p.write_byte('C'.to_int().to_byte())
  cstr(p, "42P01")
  p.write_byte('M'.to_int().to_byte())
  cstr(p, "relation \"nope\" does not exist")
  p.write_byte((0).to_byte())
  let (msg, _) = @pg.parse_backend(build_backend('E', p.to_bytes()), 0)
  match msg {
    @pg.BackendMessage::ErrorResponse(e) => {
      assert_eq(e.severity, "ERROR")
      assert_eq(e.code, "42P01")
      assert_eq(e.message, "relation \"nope\" does not exist")
    }
    _ => fail("expected ErrorResponse")
  }
}

///|
test "incomplete message reports UnexpectedEof" {
  // 声明长度 10 但只给 5 字节
  let raw = Bytes::from_array([
    'R'.to_int().to_byte(),
    (0).to_byte(),
    (0).to_byte(),
    (0).to_byte(),
    (10).to_byte(),
  ])
  let need_more : Bool = try @pg.parse_backend(raw, 0) catch {
    @pg.UnexpectedEof(_) => true
    @pg.Malformed(_) => false
  } noraise {
    _ => false
  }
  assert_eq(need_more, true)
}

///|
test "parse message layout" {
  let b = @pg.parse_message("", "SELECT $1", []).to_bytes()
  assert_eq(b[0], 'P'.to_int().to_byte())
  // payload: ""\0(1) + "SELECT $1"\0(10) + int16 0(2) = 13；len = 17
  assert_eq(b.length(), 1 + 4 + 13)
}

///|
test "bind message encodes null as -1" {
  let params : Array[Bytes?] = [Some(@utf8.encode("42")), None]
  let b = @pg.bind_message("", "", params).to_bytes()
  assert_eq(b[0], 'B'.to_int().to_byte())
  // 尾部：参数值 "42"(4+2) 与 NULL(4)，再加两个 int16 格式码计数
  assert_eq(b.length(), 1 + 4 + 1 + 1 + 2 + 2 + 6 + 4 + 2)
}

///|
test "parse ParameterDescription" {
  let p = Buffer()
  p.write_uint16_be((2).to_uint16())
  p.write_int_be(23)
  p.write_int_be(25)
  let (msg, _) = @pg.parse_backend(build_backend('t', p.to_bytes()), 0)
  assert_eq(msg, @pg.BackendMessage::ParameterDescription([23, 25]))
}
