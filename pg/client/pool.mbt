///|
/// PostgreSQL 连接池：基于 `Semaphore` 限流 + 空闲连接复用。
///
/// 与 `redis/client` 的池同思路：MoonBit 的 async 是单线程协作式，
/// 这里不需要跨线程锁，只用信号量限制同时占用的连接数。

///|
/// 连接池：最多 `size` 个连接。
pub struct Pool {
  host : String
  port : Int
  user : String
  password : String
  database : String
  ssl : Bool
  trust : @tls.TrustedRoot
  idle : Array[Client]
  sem : @semaphore.Semaphore
  /// 池是否已关闭（关闭后拒绝借出、归还的连接直接关闭而不入池）
  closed : Ref[Bool]
}

///|
/// 创建连接池（惰性建连；`ssl` 为真时每连接走 SSLRequest 协商）。
pub fn Pool::Pool(
  host : String,
  port : Int,
  user : String,
  password : String,
  database : String,
  ssl? : Bool = false,
  trust? : @tls.TrustedRoot = @tls.TrustedRoot::SystemRoot,
  size? : Int = 4,
) -> Pool {
  {
    host,
    port,
    user,
    password,
    database,
    ssl,
    trust,
    idle: [],
    sem: @semaphore.Semaphore(size),
    closed: Ref(false),
  }
}

///|
/// 借出一个连接；池满时挂起等待。
/// 取出的空闲连接会先做健康检查，失效则丢弃并重连。
pub async fn Pool::acquire(self : Pool) -> Client {
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
/// 建连超时（毫秒）：防止不可达/黑洞端点把池名额永久挂住（导致后续请求排队）。
const CONNECT_TIMEOUT_MS : Int = 10000

///|
/// 按池的配置新建一条连接（带超时）。
async fn Pool::connect_new(self : Pool) -> Client {
  @async.with_timeout(CONNECT_TIMEOUT_MS, async fn() {
    Client::connect(
      self.host,
      self.port,
      self.user,
      self.password,
      self.database,
      ssl=self.ssl,
      trust=self.trust,
    )
  })
}

///|
/// 归还连接。
///
/// 卫生检查（防止「脏连接」污染后续借用者）：
///   - 池已关闭 → 直接关闭该连接
///   - 连接仍处于**未结束的事务**中 → 关闭而非入池（否则下一个借用者会落入该事务）
pub fn Pool::release(self : Pool, c : Client) -> Unit {
  if self.closed.val || c.in_txn {
    c.close()
    self.sem.release()
    return
  }
  self.idle.push(c)
  self.sem.release()
}

///|
/// 借出连接执行一条查询，结束后自动归还。
pub async fn Pool::query(
  self : Pool,
  sql : String,
  params : Array[String?],
) -> QueryResult {
  let c = self.acquire()
  defer self.release(c)
  c.query_params(sql, params)
}

///|
/// 借出连接执行一条 SQL，返回受影响行数。
pub async fn Pool::exec(self : Pool, sql : String) -> Int {
  let c = self.acquire()
  defer self.release(c)
  c.exec(sql)
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
///
/// 注意：**正在被借用**的连接不在此处关闭 —— 它们归还时会被 `release` 关闭。
pub fn Pool::close(self : Pool) -> Unit {
  self.closed.val = true
  for c in self.idle {
    c.close()
  }
  self.idle.clear()
}
