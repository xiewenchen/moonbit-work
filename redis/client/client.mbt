///|
/// Redis 客户端：直接基于 `moonbitlang/async` 的 TCP socket 收发 RESP。
///
/// 不依赖任何 C 绑定（libhiredis 等），完全由 MoonBit 实现协议。
/// 仅 native 后端可用（socket 需要 native 运行时）。

///|
/// 未消费缓冲的上限：防止恶意/异常对端持续发送导致内存无界增长。
const MAX_PENDING_BYTES : Int = 8388608

///|
/// 一个 Redis 连接。
pub struct Client {
  tcp : @socket.Tcp
  tls : @tls.Tls?
  /// 已从 socket 读入但尚未消费的字节（一次 read 可能含多个回复，必须保留）。
  mut pending : Bytes
}

///|
/// 连接到 `host:port`。`ssl` 为真时直接建立 TLS（Redis 无 SSLRequest）。
pub async fn Client::connect(
  host : StringView,
  port : Int,
  ssl? : Bool = false,
  trust? : @tls.TrustedRoot = @tls.TrustedRoot::SystemRoot,
) -> Client {
  let tcp = @socket.Tcp::connect_to_host(host, port~)
  // TLS 握手失败时同样要关掉底层 socket
  errdefer tcp.close()
  let tls = if ssl {
    Some(@tls.Tls::client_from_pair(tcp, tcp, trust~))
  } else {
    None
  }
  { tcp, tls, pending: @utf8.encode(""), }
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
/// 健康检查：`PING`，成功返回 `true`（超时/出错返回 `false`，不抛错）。
pub async fn Client::is_healthy(
  self : Client,
  timeout_ms? : Int = 2000,
) -> Bool {
  let outcome : @redis.Resp? = try
    @async.with_timeout_opt(timeout_ms, async fn() { self.command(["PING"]) })
  catch {
    _ => None
  } noraise {
    r => r
  }
  match outcome {
    Some(@redis.Resp::SimpleString(_)) => true
    _ => false
  }
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
/// 发送一条命令（参数列表）并读取一条回复。
pub async fn Client::command(
  self : Client,
  args : Array[String],
) -> @redis.Resp {
  self.send_command(args)
  self.read_reply()
}

///|
/// `PING`，返回 `"PONG"`。
pub async fn Client::ping(self : Client) -> String {
  match self.command(["PING"]) {
    @redis.Resp::SimpleString(s) => s
    _ => fail("unexpected PING reply")
  }
}

///|
/// `SET key value`。
pub async fn Client::set(self : Client, key : String, value : String) -> Unit {
  match self.command(["SET", key, value]) {
    @redis.Resp::SimpleString(_) => ()
    _ => fail("SET failed")
  }
}

///|
/// `GET key`；键不存在返回 `None`。
pub async fn Client::get(self : Client, key : String) -> String? {
  match self.command(["GET", key]) {
    @redis.Resp::BulkString(b) => Some(@utf8.decode_lossy(b))
    @redis.Resp::NullBulk => None
    _ => fail("GET failed")
  }
}

///|
/// `DEL key...`，返回被删除的键数量。
pub async fn Client::del(self : Client, keys : Array[String]) -> Int64 {
  match self.command(["DEL", ..keys]) {
    @redis.Resp::Integer(n) => n
    _ => fail("DEL failed")
  }
}

///|
async fn Client::send_command(self : Client, args : Array[String]) -> Unit {
  let items : Array[@redis.Resp] = []
  for arg in args {
    items.push(@redis.Resp::BulkString(@utf8.encode(arg)))
  }
  self.write_bytes(@redis.Resp::ArrayValue(items).encode())
}

///|
/// 从 socket 读取恰好一条 RESP 回复。
async fn Client::read_reply(self : Client) -> @redis.Resp {
  while true {
    let outcome : (@redis.Resp, Int)? = try
      @redis.decode(self.pending, 0)
    catch {
      @redis.UnexpectedEof(_) => None
      @redis.Malformed(m) => fail("malformed reply: \{m}")
    } noraise {
      pair => Some(pair)
    }
    match outcome {
      Some((v, consumed)) => {
        // 关键：保留未消费字节（RESP 回复可能一股脑到达）
        self.pending = self.pending.clamped_view(start=consumed).to_owned()
        return v
      }
      None =>
        match self.read_some() {
          Some(chunk) =>
            if chunk.length() > 0 {
              if self.pending.length() + chunk.length() > MAX_PENDING_BYTES {
                fail("redis reply exceeds \{MAX_PENDING_BYTES} bytes")
              }
              let joined = Buffer()
              joined.write_bytes(self.pending)
              joined.write_bytes(chunk)
              self.pending = joined.to_bytes()
            } else {
              fail("connection closed by peer")
            }
          None => fail("connection closed by peer")
        }
    }
  }
  fail("unreachable: read_reply loop exited")
}
