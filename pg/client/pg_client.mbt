///|
/// PostgreSQL 客户端：直接基于 `moonbitlang/async` 的 socket 收发 v3 线协议。
///
/// 不用 libpq，完全由 MoonBit 实现协议。仅 native 后端。
/// 支持明文与 TLS（SSLRequest 协商，Windows 走 schannel）。

///|
/// 未消费缓冲的上限：防止恶意/异常 PG 服务端声明超大消息却不发满，导致内存无界增长。
const MAX_PENDING_BYTES : Int = 8388608

///|
/// 一次简单查询的结果（值均为文本格式）。
pub(all) struct QueryResult {
  columns : Array[String]
  types : Array[Int]
  rows : Array[Array[String?]]
  command : String
} derive(Debug)

///|
/// 一个 PostgreSQL 连接。
pub struct Client {
  tcp : @socket.Tcp
  mut tls : @tls.Tls?
  mut pending : Bytes
  /// 是否处于显式事务中（用于归还连接时识别「脏连接」）
  mut in_txn : Bool
}

///|
/// 写出全部字节（自动走 TLS 或明文）。
async fn Client::write_bytes(self : Client, data : Bytes) -> Unit {
  let n = data.length()
  let mut off = 0
  while off < n {
    let written = match self.tls {
      Some(t) => t.write_once(data, offset=off, len=n - off)
      None => self.tcp.write_once(data, offset=off, len=n - off)
    }
    if written <= 0 {
      fail("socket write returned \{written}")
    }
    off = off + written
  }
}

///|
/// 读一块（自动走 TLS 或明文）。
async fn Client::read_some(self : Client) -> Bytes? {
  match self.tls {
    Some(t) => t.read_some()
    None => self.tcp.read_some()
  }
}

///|
/// 读取恰好一条后端消息；把多余字节留在 `pending` 里。
async fn Client::read_message(self : Client) -> @pg.BackendMessage {
  while true {
    let outcome : (@pg.BackendMessage, Int)? = try
      @pg.parse_backend(self.pending, 0)
    catch {
      @pg.UnexpectedEof(_) => None
      @pg.Malformed(m) => fail("malformed server message: \{m}")
    } noraise {
      pair => Some(pair)
    }
    match outcome {
      Some((msg, consumed)) => {
        self.pending = self.pending.clamped_view(start=consumed).to_owned()
        return msg
      }
      None =>
        match self.read_some() {
          Some(chunk) =>
            if chunk.length() > 0 {
              if self.pending.length() + chunk.length() > MAX_PENDING_BYTES {
                fail("pg message exceeds \{MAX_PENDING_BYTES} bytes")
              }
              let joined = Buffer()
              joined.write_bytes(self.pending)
              joined.write_bytes(chunk)
              self.pending = joined.to_bytes()
            } else {
              fail("connection closed by server")
            }
          None => fail("connection closed by server")
        }
    }
  }
  fail("unreachable: read_message loop exited")
}

///|
/// 建立连接并完成启动握手。
///
/// `ssl` 为真时先发 `SSLRequest`：服务器答应（`S`）则把连接升级为 TLS；
/// 拒绝（`N`）则退回明文。`trust` 控制证书校验（默认用系统根；自签需传 `NoVerification`）。
pub async fn Client::connect(
  host : String,
  port : Int,
  user : String,
  password : String,
  database : String,
  ssl? : Bool = false,
  trust? : @tls.TrustedRoot = @tls.TrustedRoot::SystemRoot,
) -> Client {
  let tcp = @socket.Tcp::connect_to_host(host, port~)
  // 若后续握手（SSLRequest / startup / 认证）失败，必须关掉已建立的 socket（否则每次失败漏一个 fd）
  errdefer tcp.close()
  let client : Client = {
    tcp,
    tls: None,
    pending: @utf8.encode(""),
    in_txn: false,
  }
  if ssl {
    tcp.write_once(@pg.ssl_request(), offset=0, len=8) |> ignore
    let resp = match tcp.read_some() {
      Some(b) =>
        if b.length() >= 1 {
          b[0]
        } else {
          fail("empty SSLRequest response")
        }
      None => fail("connection closed during SSLRequest")
    }
    if resp == b'S' {
      client.tls = Some(@tls.Tls::client_from_pair(tcp, tcp, trust~))
    }
    // 'N'：服务器不支持 TLS，按明文继续（如需强制，调用方可自行校验）
  }
  client.write_bytes(@pg.startup_message(user, database))
  let mut ready = false
  let mut client_first_bare = ""
  while !ready {
    match client.read_message() {
      @pg.BackendMessage::Authentication(@pg.AuthRequest::Ok) => ()
      @pg.BackendMessage::Authentication(@pg.AuthRequest::CleartextPassword) =>
        client.write_bytes(@pg.password_message(password).to_bytes())
      @pg.BackendMessage::Authentication(@pg.AuthRequest::MD5Password(salt)) =>
        client.write_bytes(
          @pg.password_message(@pg.md5_password(password, user, salt)).to_bytes(),
        )
      @pg.BackendMessage::Authentication(@pg.AuthRequest::SASL(_)) => {
        let (full, bare) = @pg.scram_client_first(user, gen_nonce())
        client_first_bare = bare
        client.write_bytes(
          @pg.sasl_initial_response("SCRAM-SHA-256", @utf8.encode(full)).to_bytes(),
        )
      }
      @pg.BackendMessage::Authentication(
        @pg.AuthRequest::SASLContinue(server_first)
      ) => {
        let (nonce, salt, iters) = @pg.parse_server_first(server_first)
        let final_msg = @pg.scram_client_final(
          password, client_first_bare, server_first, nonce, salt, iters,
        )
        client.write_bytes(
          @pg.sasl_response(@utf8.encode(final_msg)).to_bytes(),
        )
      }
      @pg.BackendMessage::Authentication(@pg.AuthRequest::SASLFinal(_)) => ()
      @pg.BackendMessage::Authentication(@pg.AuthRequest::Other(code)) =>
        fail("unsupported auth code \{code}")
      @pg.BackendMessage::ErrorResponse(e) =>
        fail("connect failed: \{e.message}")
      @pg.BackendMessage::ReadyForQuery(_) => ready = true
      _ => ()
    }
  }
  client
}

///|
/// 关闭连接。
pub fn Client::close(self : Client) -> Unit {
  match self.tls {
    Some(t) => {
      // 库契约：`Tls::close` 必须先于底层 transport 关闭（否则底层 socket 不会被释放 → fd 泄漏）
      t.close()
      self.tcp.close()
    }
    None => self.tcp.close()
  }
}

///|
/// 执行一条简单查询，收集全部行（文本格式）。
pub async fn Client::query(self : Client, sql : String) -> QueryResult {
  self.write_bytes(@pg.simple_query(sql).to_bytes())
  self.collect_result()
}

///|
/// 参数化查询（扩展查询协议；参数以文本格式发送）。
pub async fn Client::query_params(
  self : Client,
  sql : String,
  params : Array[String?],
) -> QueryResult {
  let out = Buffer()
  out.write_bytes(@pg.parse_message("", sql, []).to_bytes())
  let bound : Array[Bytes?] = []
  for p in params {
    match p {
      Some(s) => bound.push(Some(@utf8.encode(s)))
      None => bound.push(None)
    }
  }
  out.write_bytes(@pg.bind_message("", "", bound).to_bytes())
  out.write_bytes(@pg.describe_portal_message("").to_bytes())
  out.write_bytes(@pg.execute_message("", 0).to_bytes())
  out.write_bytes(@pg.sync_message().to_bytes())
  self.write_bytes(out.to_bytes())
  self.collect_result()
}

///|
/// 读取响应直到 `ReadyForQuery`，收集列/行/命令标签。
async fn Client::collect_result(self : Client) -> QueryResult {
  let mut columns : Array[String] = []
  let mut types : Array[Int] = []
  let rows : Array[Array[String?]] = []
  let mut command = ""
  let mut done = false
  while !done {
    match self.read_message() {
      @pg.BackendMessage::RowDescription(fields) => {
        let names : Array[String] = []
        let oids : Array[Int] = []
        for f in fields {
          names.push(f.name)
          oids.push(f.type_oid)
        }
        columns = names
        types = oids
      }
      @pg.BackendMessage::DataRow(values) => {
        let row : Array[String?] = []
        for v in values {
          match v {
            Some(b) => row.push(Some(@utf8.decode_lossy(b)))
            None => row.push(None)
          }
        }
        rows.push(row)
      }
      @pg.BackendMessage::CommandComplete(tag) => command = tag
      @pg.BackendMessage::ReadyForQuery(_) => done = true
      @pg.BackendMessage::ErrorResponse(e) => fail("query failed: \{e.message}")
      _ => ()
    }
  }
  { columns, types, rows, command, }
}

///|
/// 取某单元格的类型化值（按列的类型 OID 解码）。
pub fn QueryResult::value(
  self : QueryResult,
  row : Int,
  col : Int,
) -> @pg.Value {
  // 边界检查：越界一律返回 Null，绝不 panic（panic 会崩掉整个进程）
  if row < 0 || col < 0 || row >= self.rows.length() {
    return @pg.Value::Null
  }
  let r = self.rows[row]
  if col >= r.length() {
    return @pg.Value::Null
  }
  let oid = if col < self.types.length() { self.types[col] } else { 0 }
  @pg.decode_value(oid, r[col])
}

///|
/// 取整数值。
pub fn QueryResult::int(self : QueryResult, row : Int, col : Int) -> Int64? {
  match self.value(row, col) {
    @pg.Value::Int(n) => Some(n)
    _ => None
  }
}

///|
/// 取布尔值。
pub fn QueryResult::bool(self : QueryResult, row : Int, col : Int) -> Bool? {
  match self.value(row, col) {
    @pg.Value::Bool(b) => Some(b)
    _ => None
  }
}

///|
/// 取浮点值（含 numeric）。
pub fn QueryResult::float(self : QueryResult, row : Int, col : Int) -> Double? {
  match self.value(row, col) {
    @pg.Value::Float(f) => Some(f)
    _ => None
  }
}

///|
/// 取原始文本（NULL 返回 None）；越界安全返回 None。
pub fn QueryResult::text(self : QueryResult, row : Int, col : Int) -> String? {
  if row < 0 || col < 0 || row >= self.rows.length() {
    return None
  }
  let r = self.rows[row]
  if col >= r.length() {
    None
  } else {
    r[col]
  }
}

///|
/// 便捷：执行一条 SQL，返回受影响行数（解析 `CommandComplete` 末尾数字）。
pub async fn Client::exec(self : Client, sql : String) -> Int {
  let r = self.query(sql)
  parse_command_rows(r.command)
}

// ---------------------------------------------------------------------------
// 健康检查与超时
// ---------------------------------------------------------------------------

///|
/// 带超时的简单查询（超时抛错）。
pub async fn Client::query_timeout(
  self : Client,
  sql : String,
  timeout_ms : Int,
) -> QueryResult {
  @async.with_timeout(timeout_ms, async fn() { self.query(sql) })
}

///|
/// 健康检查：`SELECT 1`，成功返回 `true`（超时/出错返回 `false`，不抛错）。
pub async fn Client::is_healthy(
  self : Client,
  timeout_ms? : Int = 2000,
) -> Bool {
  let outcome : QueryResult? = try
    @async.with_timeout_opt(timeout_ms, async fn() { self.query("SELECT 1") })
  catch {
    _ => None
  } noraise {
    r => r
  }
  match outcome {
    Some(r) => r.rows.length() == 1
    None => false
  }
}

// ---------------------------------------------------------------------------
// 事务
// ---------------------------------------------------------------------------

///|
/// `BEGIN`。
pub async fn Client::begin(self : Client) -> Unit {
  self.query("BEGIN") |> ignore
  self.in_txn = true
}

///|
/// `COMMIT`。
pub async fn Client::commit(self : Client) -> Unit {
  self.query("COMMIT") |> ignore
  self.in_txn = false
}

///|
/// `ROLLBACK`。
pub async fn Client::rollback(self : Client) -> Unit {
  self.query("ROLLBACK") |> ignore
  self.in_txn = false
}

///|
/// 在一个事务里执行 `f`：`f` 正常结束则 `COMMIT`，抛错则 `ROLLBACK`。
///
/// 出错时连接会回到可继续使用的状态（ROLLBACK 后处于 `ReadyForQuery`）。
/// 注意：出错路径会把原始错误替换为一个通用失败（首版简化）。
pub async fn Client::with_transaction(
  self : Client,
  f : async () -> Unit,
) -> Unit {
  self.begin()
  let ok : Bool = try f() catch {
    _ => false
  } noraise {
    _ => true
  }
  if ok {
    self.commit()
  } else {
    self.rollback()
    fail("transaction rolled back after error")
  }
}

///|
/// 从 `CommandComplete` 标签里取末尾的数字（如 `INSERT 0 1` → 1）。
fn parse_command_rows(tag : String) -> Int {
  let parts : Array[String] = []
  for s in tag.split(" ") {
    parts.push(s.to_owned())
  }
  let n = parts.length()
  if n == 0 {
    return 0
  }
  let last = parts[n - 1]
  let mut acc = 0
  let mut any = false
  for i = 0; i < last.length(); i = i + 1 {
    match last.get_char(i) {
      Some(c) =>
        if c >= '0' && c <= '9' {
          acc = acc * 10 + (c.to_int() - '0'.to_int())
          any = true
        } else {
          return 0
        }
      None => ()
    }
  }
  if any {
    acc
  } else {
    0
  }
}

///|
/// 生成一个 SCRAM nonce（18 随机字节的 base64）。
fn gen_nonce() -> String {
  let rnd = @random.Rand::new()
  let buf = Buffer()
  for i = 0; i < 18; i = i + 1 {
    buf.write_byte(rnd.int(limit=256).to_byte())
  }
  @base64.encode(buf.to_bytes())
}
