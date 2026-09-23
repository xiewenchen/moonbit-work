///|
/// 应用框架层：把 `http` + `pg` + `redis` 的兼容层封装成「写后端更省事」的一层。
///
/// - `Config`：一处配置（监听地址 + PG + Redis），可用环境变量覆盖
/// - `App`：应用对象，内置连接池、路由注册、中间件、健康检查
/// - `Group`：路由分组（统一前缀）
/// - 数据访问：原生 SQL（`query`/`exec`）+ 连接池复用；需要事务时用 `with_db`
///
/// 仅 native 后端。

///|
/// 查询结果类型别名（用框架时不必再单独 import `pg/client`）。
pub type PgResult = @pgclient.QueryResult

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

///|
/// 应用配置。
pub(all) struct Config {
  host : String
  port : Int
  pg_host : String
  pg_port : Int
  pg_user : String
  pg_password : String
  pg_db : String
  pg_ssl : Bool
  redis_host : String
  redis_port : Int
  redis_ssl : Bool
} derive(Debug)

///|
/// 默认配置（本地开发：PG 55432、Redis 6379）。
pub fn Config::default() -> Config {
  {
    host: "127.0.0.1",
    port: 8080,
    pg_host: "127.0.0.1",
    pg_port: 55432,
    pg_user: "mbp",
    pg_password: "",
    pg_db: "mbptest",
    pg_ssl: false,
    redis_host: "127.0.0.1",
    redis_port: 6379,
    redis_ssl: false,
  }
}

///|
fn parse_int_lenient(s : String) -> Int? {
  let mut acc = 0
  let mut any = false
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some(c) =>
        if c >= '0' && c <= '9' {
          acc = acc * 10 + (c.to_int() - '0'.to_int())
          any = true
        } else {
          return None
        }
      None => ()
    }
  }
  if any {
    Some(acc)
  } else {
    None
  }
}

///|
fn env_str(key : String, fallback : String) -> String {
  match @env.get_env_var(key) {
    Some(v) => v
    None => fallback
  }
}

///|
fn env_int(key : String, fallback : Int) -> Int {
  match @env.get_env_var(key) {
    Some(v) =>
      match parse_int_lenient(v) {
        Some(n) => n
        None => fallback
      }
    None => fallback
  }
}

///|
/// 从环境变量读取配置（未设置时用默认值）。
/// 支持：MBP_HOST / MBP_PORT / MBP_PG_HOST / MBP_PG_PORT / MBP_PG_USER /
/// MBP_PG_PASSWORD / MBP_PG_DB / MBP_REDIS_HOST / MBP_REDIS_PORT。
pub fn Config::from_env() -> Config {
  let d = Config::default()
  {
    host: env_str("MBP_HOST", d.host),
    port: env_int("MBP_PORT", d.port),
    pg_host: env_str("MBP_PG_HOST", d.pg_host),
    pg_port: env_int("MBP_PG_PORT", d.pg_port),
    pg_user: env_str("MBP_PG_USER", d.pg_user),
    pg_password: env_str("MBP_PG_PASSWORD", d.pg_password),
    pg_db: env_str("MBP_PG_DB", d.pg_db),
    pg_ssl: env_str("MBP_PG_SSL", "") == "true",
    redis_host: env_str("MBP_REDIS_HOST", d.redis_host),
    redis_port: env_int("MBP_REDIS_PORT", d.redis_port),
    redis_ssl: env_str("MBP_REDIS_SSL", "") == "true",
  }
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

///|
/// 应用的共享状态（放在 `Ref` 里，复制 `App` 后仍指向同一份）。
struct AppState {
  config : Config
  router : @server.Router
  pg : @pgclient.Pool
  redis : @redisclient.Pool
}

///|
/// 一个后端应用。
pub struct App {
  state : Ref[AppState]
}

///|
/// 用配置创建应用（自动注册 `/health`）。
pub fn App::new(config : Config) -> App {
  let router = @server.Router::new()
  let app : App = {
    state: Ref({
      config,
      router,
      pg: @pgclient.Pool::Pool(
        config.pg_host,
        config.pg_port,
        config.pg_user,
        config.pg_password,
        config.pg_db,
        ssl=config.pg_ssl,
      ),
      redis: @redisclient.Pool::Pool(
        config.redis_host,
        config.redis_port,
        ssl=config.redis_ssl,
      ),
    }),
  }
  app.get("/health", fn(_req) { @http.Response::text(200, "ok") })
  app
}

///|
pub fn App::config(self : App) -> Config {
  self.state.val.config
}

///|
/// 暴露底层路由（用于自定义 serve / 测试）。
pub fn App::router(self : App) -> @server.Router {
  self.state.val.router
}

// ---------------------------------------------------------------------------
// 路由 / 中间件
// ---------------------------------------------------------------------------

///|
/// 注册一个中间件。
pub fn App::use_middleware(self : App, mw : @server.Middleware) -> Unit {
  self.state.val.router.add_middleware(mw)
}

///|
fn json_escape(s : String) -> String {
  let buf = Buffer()
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some('"') => buf.write_string_utf8("\\\"")
      Some('\\') => buf.write_string_utf8("\\\\")
      Some('\n') => buf.write_string_utf8("\\n")
      Some('\r') => buf.write_string_utf8("\\r")
      Some('\t') => buf.write_string_utf8("\\t")
      Some(c) => buf.write_string_utf8(c.to_string())
      None => ()
    }
  }
  @utf8.decode_lossy(buf.to_bytes())
}

///|
fn gen_request_id() -> String {
  let rnd = @random.Rand::new()
  let buf = Buffer()
  for i = 0; i < 16; i = i + 1 {
    buf.write_byte(rnd.int(limit=256).to_byte())
  }
  @base64.encode(buf.to_bytes())
}

///|
/// 一行访问日志（JSON）。
fn access_log_line(
  req : @http.Request,
  resp : @http.Response,
  rid : String,
  ms : UInt64,
) -> String {
  let buf = Buffer()
  buf.write_string_utf8("{\"level\":\"info\",\"method\":\"")
  buf.write_string_utf8(req.verb.as_str())
  buf.write_string_utf8("\",\"path\":\"")
  buf.write_string_utf8(json_escape(req.target))
  buf.write_string_utf8("\",\"status\":")
  buf.write_string_utf8(resp.status.to_string())
  buf.write_string_utf8(",\"duration_ms\":")
  buf.write_string_utf8(ms.to_string())
  buf.write_string_utf8(",\"request_id\":\"")
  buf.write_string_utf8(json_escape(rid))
  buf.write_string_utf8("\"}")
  @utf8.decode_lossy(buf.to_bytes())
}

///|
/// 清洗要写回响应头的值：去掉 CR/LF 与控制字符，防止**响应头注入/响应拆分**。
///
/// 请求头里可以夹带裸 `\r`（`read_line` 只按 `\r\n` 切分），若原样回显，
/// 某些代理/客户端会把裸 CR 当行结束 → 可注入额外响应头。
pub fn sanitize_header_value(v : String) -> String {
  let buf = Buffer()
  for i = 0; i < v.length(); i = i + 1 {
    match v.get_char(i) {
      Some(c) =>
        if c == '\r' || c == '\n' || c.to_int() < 32 || c.to_int() == 127 {
          // 丢弃危险字符
        } else {
          buf.write_string_utf8(c.to_string())
        }
      None => ()
    }
  }
  let cleaned = @utf8.decode_lossy(buf.to_bytes())
  // 限制长度，避免超大回显
  if cleaned.length() > 200 {
    cleaned[:200].to_owned()
  } else {
    cleaned
  }
}

///|
/// 启用结构化访问日志：生成/透传 `X-Request-Id`，记录一行 JSON 到 stdout，
/// 并把 `X-Request-Id` 写回响应头。
pub fn App::use_logging(self : App) -> Unit {
  self.use_middleware(async fn(req, next) {
    let start = @env.now()
    let rid = match req.header("x-request-id") {
      Some(v) => sanitize_header_value(v)
      None => gen_request_id()
    }
    let resp = next()
    // 注意：`@env.now()` 单位是**毫秒**
    let ms = @env.now() - start
    resp.headers.push(("X-Request-Id", rid))
    println(access_log_line(req, resp, rid, ms))
    resp
  })
}

// ---------------------------------------------------------------------------
// 指标（Prometheus 文本格式）
// ---------------------------------------------------------------------------

///|
/// 校验配置（端口范围、必填项）；非法返回错误信息。
pub fn Config::validate(self : Config) -> Result[Unit, String] {
  if self.host == "" {
    return Err("host must not be empty")
  }
  if self.port <= 0 || self.port > 65535 {
    return Err("port out of range: \{self.port}")
  }
  if self.pg_host == "" {
    return Err("pg_host must not be empty")
  }
  if self.pg_port <= 0 || self.pg_port > 65535 {
    return Err("pg_port out of range: \{self.pg_port}")
  }
  if self.pg_user == "" {
    return Err("pg_user must not be empty")
  }
  if self.pg_db == "" {
    return Err("pg_db must not be empty")
  }
  if self.redis_host == "" {
    return Err("redis_host must not be empty")
  }
  if self.redis_port <= 0 || self.redis_port > 65535 {
    return Err("redis_port out of range: \{self.redis_port}")
  }
  Ok(())
}

///|
/// 进程内指标（单线程协作式，无需锁）。
pub struct Metrics {
  counts : Map[String, Int]
  mut duration_sum_ms : UInt64
  mut duration_count : UInt64
  /// 延迟直方图桶（**累积**计数，末尾为 +Inf）
  buckets : Array[UInt64]
}

///|
/// 延迟直方图桶边界（毫秒）。
///
/// 没有直方图就只能算平均值，`histogram_quantile` 无法使用 ——
/// 而延迟告警必须看分位数（平均值会被长尾掩盖）。
fn histogram_bounds() -> Array[Int] {
  // 上界要覆盖到「远超超时」的量级：否则更慢的请求都落进 +Inf，
  // histogram_quantile 的估计会封顶在最后一个边界，慢请求告警将永远不触发。
  [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
}

///|
/// 新建全零桶数组（长度 = 边界数 + 1，末尾是 +Inf）。
fn new_buckets() -> Array[UInt64] {
  let out : Array[UInt64] = []
  let n = histogram_bounds().length() + 1
  let mut i = 0
  while i < n {
    out.push(0UL)
    i = i + 1
  }
  out
}

///|
fn render_metrics(m : Metrics) -> String {
  let buf = Buffer()
  buf.write_string_utf8("# HELP http_requests_total Total HTTP requests\n")
  buf.write_string_utf8("# TYPE http_requests_total counter\n")
  for entry in m.counts.iter() {
    let (k, v) = entry
    match k.split_once("|") {
      Some((verb, status)) =>
        buf.write_string_utf8(
          "http_requests_total{method=\"\{verb}\",status=\"\{status}\"} \{v}\n",
        )
      None => ()
    }
  }
  // 延迟直方图：有了 _bucket 才能用 histogram_quantile 算 p95/p99
  let bounds = histogram_bounds()
  buf.write_string_utf8(
    "# HELP http_request_duration_ms HTTP request duration in milliseconds\n",
  )
  buf.write_string_utf8("# TYPE http_request_duration_ms histogram\n")
  for i = 0; i < bounds.length(); i = i + 1 {
    buf.write_string_utf8(
      "http_request_duration_ms_bucket{le=\"\{bounds[i]}\"} \{m.buckets[i]}\n",
    )
  }
  buf.write_string_utf8(
    "http_request_duration_ms_bucket{le=\"+Inf\"} \{m.buckets[bounds.length()]}\n",
  )
  buf.write_string_utf8("http_request_duration_ms_sum \{m.duration_sum_ms}\n")
  buf.write_string_utf8("http_request_duration_ms_count \{m.duration_count}\n")
  // 兼容保留：请求总数（等价于 http_requests_total 的合计）
  buf.write_string_utf8("# TYPE http_requests_count counter\n")
  buf.write_string_utf8("http_requests_count \{m.duration_count}\n")
  @utf8.decode_lossy(buf.to_bytes())
}

///|
/// 启用指标收集，并在 `GET /metrics` 暴露 Prometheus 文本格式。
pub fn App::use_metrics(self : App) -> Unit {
  let m : Ref[Metrics] = Ref({
    counts: Map([]),
    duration_sum_ms: 0UL,
    duration_count: 0UL,
    buckets: new_buckets(),
  })
  self.use_middleware(async fn(req, next) {
    let start = @env.now()
    let resp = next()
    // 注意：`@env.now()` 单位是**毫秒**
    let ms = @env.now() - start
    // 方法名归一化：`Method::Other(_)` 的是**攻击者可控的任意字符串**，
    // 若原样作为 Map 键，攻击者可每次换一个方法名 → counts 无界增长（内存 DoS）。
    let verb = match req.verb {
      @http.Method::Other(_) => "OTHER"
      m => m.as_str()
    }
    // 状态码同样归一化到有限集合
    let status_bucket = if resp.status >= 100 && resp.status < 600 {
      resp.status.to_string()
    } else {
      "other"
    }
    let key = verb + "|" + status_bucket
    // 纵深防御：即使键空间意外膨胀，也不让它超过固定上限
    if m.val.counts.length() < 256 || m.val.counts.contains(key) {
      let cur = match m.val.counts.get(key) {
        Some(n) => n
        None => 0
      }
      m.val.counts.set(key, cur + 1)
    }
    m.val.duration_sum_ms = m.val.duration_sum_ms + ms
    m.val.duration_count = m.val.duration_count + 1UL
    // 直方图累加：le 是「小于等于」，桶计数是累积的
    let bounds = histogram_bounds()
    let mut bi = 0
    while bi < bounds.length() {
      if ms <= bounds[bi].to_uint64() {
        m.val.buckets[bi] = m.val.buckets[bi] + 1UL
      }
      bi = bi + 1
    }
    m.val.buckets[bounds.length()] = m.val.buckets[bounds.length()] + 1UL
    resp
  })
  self.get("/metrics", fn(_req) {
    @http.Response::text(200, render_metrics(m.val))
  })
}

///|
/// 注册一条任意方法的路由。
pub fn App::route(
  self : App,
  verb : @http.Method,
  path : String,
  handler : @server.Handler,
) -> Unit {
  self.state.val.router.add(verb, path, handler)
}

///|
/// 注册 `GET` 路由。
pub fn App::get(self : App, path : String, handler : @server.Handler) -> Unit {
  self.route(@http.Method::Get, path, handler)
}

///|
/// 注册 `POST` 路由。
pub fn App::post(self : App, path : String, handler : @server.Handler) -> Unit {
  self.route(@http.Method::Post, path, handler)
}

///|
/// 注册 `PUT` 路由。
pub fn App::put(self : App, path : String, handler : @server.Handler) -> Unit {
  self.route(@http.Method::Put, path, handler)
}

///|
/// 注册 `DELETE` 路由。
pub fn App::delete(
  self : App,
  path : String,
  handler : @server.Handler,
) -> Unit {
  self.route(@http.Method::Delete, path, handler)
}

///|
/// 建一个路由分组（统一前缀）。
pub fn App::group(self : App, prefix : String) -> Group {
  { app: self, prefix, }
}

// ---------------------------------------------------------------------------
// 数据访问：原生 SQL + 连接池
// ---------------------------------------------------------------------------

///|
/// 执行参数化查询（连接池）。
pub async fn App::query(
  self : App,
  sql : String,
  params : Array[String?],
) -> @pgclient.QueryResult {
  self.state.val.pg.query(sql, params)
}

///|
/// 执行一条 SQL，返回受影响行数。
pub async fn App::exec(self : App, sql : String) -> Int {
  self.state.val.pg.exec(sql)
}

///|
/// 借用一条 PG 连接执行多步操作（例如事务），结束后自动归还。
pub async fn App::with_db(
  self : App,
  f : async (@pgclient.Client) -> Unit,
) -> Unit {
  let pool = self.state.val.pg
  let c = pool.acquire()
  defer pool.release(c)
  f(c)
}

// ---------------------------------------------------------------------------
// 缓存：Redis
// ---------------------------------------------------------------------------

///|
/// 借用一条 Redis 连接执行多步操作，结束后自动归还。
pub async fn App::with_redis(
  self : App,
  f : async (@redisclient.Client) -> Unit,
) -> Unit {
  let pool = self.state.val.redis
  let c = pool.acquire()
  defer pool.release(c)
  f(c)
}

///|
/// `INCR key`。
pub async fn App::incr(self : App, key : String) -> Int64 {
  let pool = self.state.val.redis
  let c = pool.acquire()
  defer pool.release(c)
  c.incr(key)
}

///|
/// `GET key`。
pub async fn App::get_str(self : App, key : String) -> String? {
  let pool = self.state.val.redis
  let c = pool.acquire()
  defer pool.release(c)
  c.get(key)
}

///|
/// `SET key value`。
pub async fn App::set_str(self : App, key : String, value : String) -> Unit {
  let pool = self.state.val.redis
  let c = pool.acquire()
  defer pool.release(c)
  c.set(key, value)
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

///|
/// 探活数据库依赖（连接失败返回 `false`，不抛错）。
pub async fn App::ping_db(self : App) -> Bool {
  let ok : Bool = try self.state.val.pg.ping() catch {
    _ => false
  } noraise {
    v => v
  }
  ok
}

///|
/// 探活缓存依赖（连接失败返回 `false`，不抛错）。
pub async fn App::ping_redis(self : App) -> Bool {
  let ok : Bool = try self.state.val.redis.ping() catch {
    _ => false
  } noraise {
    v => v
  }
  ok
}

///|
/// 注册就绪探针 `GET /ready`：探测 PG 与 Redis，任一失败返回 503。
///
/// （`/health` 是存活探针，只表示进程还在。）
pub fn App::use_readiness(self : App) -> Unit {
  let a = self
  self.get("/ready", async fn(_req) {
    let pg_ok = a.ping_db()
    let rd_ok = a.ping_redis()
    if pg_ok && rd_ok {
      @http.Response::text(200, "ready")
    } else {
      error_response(503, "dependencies not ready")
    }
  })
}

///|
/// 启动服务（阻塞，直到被取消）。
pub async fn App::serve(self : App) -> Unit {
  self.serve_with(@server.ServerLimits::default())
}

///|
/// 用指定的限制/超时启动服务。
pub async fn App::serve_with(self : App, limits : @server.ServerLimits) -> Unit {
  let c = self.state.val.config
  println("[app] listening on \{c.host}:\{c.port}")
  @server.serve(self.state.val.router, c.host, c.port, limits~)
}

///|
/// 关闭连接池。
pub fn App::close(self : App) -> Unit {
  self.state.val.pg.close()
  self.state.val.redis.close()
}

// ---------------------------------------------------------------------------
// 路由分组
// ---------------------------------------------------------------------------

///|
/// 带统一前缀的路由分组。
pub struct Group {
  app : App
  prefix : String
}

///|
pub fn Group::get(
  self : Group,
  path : String,
  handler : @server.Handler,
) -> Unit {
  self.app.get(self.prefix + path, handler)
}

///|
pub fn Group::post(
  self : Group,
  path : String,
  handler : @server.Handler,
) -> Unit {
  self.app.post(self.prefix + path, handler)
}

///|
pub fn Group::put(
  self : Group,
  path : String,
  handler : @server.Handler,
) -> Unit {
  self.app.put(self.prefix + path, handler)
}

///|
pub fn Group::delete(
  self : Group,
  path : String,
  handler : @server.Handler,
) -> Unit {
  self.app.delete(self.prefix + path, handler)
}
