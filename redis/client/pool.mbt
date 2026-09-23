///|
/// 一个简单的 Redis 连接池。
///
/// MoonBit 的 async 运行时是**单线程协作式**的，所以这里的"池"不做跨线程同步，
/// 而是：用 `Semaphore` 限制同时在用的连接数，空闲连接复用，避免频繁重连。

///|
/// 连接池：最多 `size` 个连接。
pub struct Pool {
  host : String
  port : Int
  ssl : Bool
  trust : @tls.TrustedRoot
  idle : Array[Client]
  sem : @semaphore.Semaphore
  /// 池是否已关闭（关闭后拒绝借出、归还的连接直接关闭而不入池）
  closed : Ref[Bool]
}

///|
/// 创建连接池（惰性建连：第一次 `acquire` 时才真正连接）。
pub fn Pool::Pool(
  host : String,
  port : Int,
  ssl? : Bool = false,
  trust? : @tls.TrustedRoot = @tls.TrustedRoot::SystemRoot,
  size? : Int = 4,
) -> Pool {
  {
    host,
    port,
    ssl,
    trust,
    idle: [],
    sem: @semaphore.Semaphore(size),
    closed: Ref(false),
  }
}

///|
/// 借出一个连接；池满（`size` 个都在用）时挂起等待。
/// 取出的空闲连接会先做健康检查，失效则丢弃并重连。
pub async fn Pool::acquire(self : Pool) -> Client {
  if self.closed.val {
    raise Failure("pool is closed")
  }
  self.sem.acquire()
  // 关键：若建连/健康检查失败，必须归还名额，否则池会被永久耗尽（远程可触发的 DoS）
  let c = {
    errdefer self.sem.release()
    match self.idle.pop() {
      Some(c) =>
        if c.is_healthy() {
          c
        } else {
          c.close()
          self.connect_new()
        }
      None => self.connect_new()
    }
  }
  c
}

///|
/// 建连超时（毫秒）：防止不可达/黑洞端点把池名额永久挂住。
const CONNECT_TIMEOUT_MS : Int = 10000

///|
/// 按池的配置新建一条连接（带超时）。
async fn Pool::connect_new(self : Pool) -> Client {
  @async.with_timeout(CONNECT_TIMEOUT_MS, async fn() {
    Client::connect(self.host, self.port, ssl=self.ssl, trust=self.trust)
  })
}

///|
/// 归还连接，供后续复用；池已关闭则直接关闭该连接。
pub fn Pool::release(self : Pool, c : Client) -> Unit {
  if self.closed.val {
    c.close()
    self.sem.release()
    return
  }
  self.idle.push(c)
  self.sem.release()
}

///|
/// 借出连接执行 `f`，结束后自动归还。
pub async fn Pool::run(self : Pool, f : async (Client) -> Unit) -> Unit {
  let c = self.acquire()
  defer self.release(c)
  f(c)
}

///|
/// 当前空闲连接数。
pub fn Pool::idle_count(self : Pool) -> Int {
  self.idle.length()
}

///|
/// 探活：借一条连接做健康检查（用于就绪探针）。
pub async fn Pool::ping(self : Pool) -> Bool {
  let c = self.acquire()
  defer self.release(c)
  c.is_healthy()
}

///|
/// 关闭池：标记为已关闭（后续借出会失败、归还的连接会被关闭），并关闭所有空闲连接。
/// 正在被借用的连接会在归还时被 `release` 关闭。
pub fn Pool::close(self : Pool) -> Unit {
  self.closed.val = true
  for c in self.idle {
    c.close()
  }
  self.idle.clear()
}
