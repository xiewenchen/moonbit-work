///|
/// 限流、输入校验与统一错误响应。

// ---------------------------------------------------------------------------
// 统一错误响应
// ---------------------------------------------------------------------------

///|
/// 「尽力而为」（异步版）：执行可能失败的副作用（统计、缓存写入等），失败时忽略并返回兜底值。
///
/// 用途：这类操作**不应**影响主流程 —— 例如 Redis 挂了不该让 `/health` 变 500。
pub async fn[T] best_effort(default : T, f : async () -> T) -> T {
  try f() catch {
    _ => default
  } noraise {
    v => v
  }
}

///|
/// 统一错误响应（JSON：`{"error": "..."}`）。
pub fn error_response(status : Int, message : String) -> @http.Response {
  @http.Response::json(status, "{\"error\":\"\{json_escape(message)}\"}")
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

///|
/// 校验：字段必须存在且非空，返回去除首尾空白的值或错误信息。
pub fn require_non_empty(
  value : String?,
  field : String,
) -> Result[String, String] {
  match value {
    Some(v) =>
      if v.trim().to_owned() != "" {
        Ok(v)
      } else {
        Err("\{field} must not be empty")
      }
    None => Err("\{field} is required")
  }
}

///|
/// 校验：字符串长度不超过 `max`。
pub fn require_max_len(
  value : String,
  max : Int,
  field : String,
) -> Result[String, String] {
  if value.length() <= max {
    Ok(value)
  } else {
    Err("\{field} must be at most \{max} characters")
  }
}

// ---------------------------------------------------------------------------
// 令牌桶限流
// ---------------------------------------------------------------------------

///|
/// 一个令牌桶。
priv struct Bucket {
  tokens : Double
  last_ms : UInt64
}

///|

///|
/// 限流的客户端标识：**优先用真实 socket 远端地址**（客户端不可伪造）。
///
/// `X-Forwarded-For` 仅作为回退，且只在「自己前面确实有可信代理」时才应采纳——
/// 否则攻击者只要每次改这个头就能绕过限流（此前的缺陷）。

///|
/// 限流用的客户端标识。
///
/// ## 为什么默认**不**信任 `X-Forwarded-For`
///
/// 该头是客户端可任意伪造的。若服务直接暴露公网却信任它，
/// 攻击者每次换一个伪造 IP 就绕过了限流。
///
/// 因此只有当服务**确实位于可信反向代理之后**（部署方显式开启 `trust_proxy`）时，
/// 才采用 `X-Forwarded-For` 的**第一个**地址（最接近真实客户端）；
/// 否则一律用 socket 层的 `remote_addr`（客户端无法伪造）。
fn client_key(req : @http.Request, trust_proxy : Bool) -> String {
  if trust_proxy {
    match req.header("x-forwarded-for") {
      Some(v) => {
        let first = match v.find(",") {
          Some(i) => v[:i].to_owned()
          None => v
        }
        let t = first.trim().to_owned()
        if t != "" {
          return t
        }
      }
      None => ()
    }
  }
  if req.remote_addr != "" {
    req.remote_addr
  } else {
    "unknown"
  }
}

///|
/// 启用按客户端限流（令牌桶）：`rate_per_sec` 每秒补充令牌，`burst` 为桶容量。
/// 超出返回 429 并带 `Retry-After`。
///
/// 说明：客户端标识取自 `X-Forwarded-For` / `X-Real-IP`（无 socket 层远端地址），
/// 真实部署应在可信代理后使用。
pub fn App::use_rate_limit(
  self : App,
  rate_per_sec : Double,
  burst : Double,
  trust_proxy? : Bool = false,
) -> Unit {
  let buckets : Ref[Map[String, Bucket]] = Ref(Map([]))
  let rate = rate_per_sec
  let cap = burst
  // 桶数量上限：超过后清理「已补满」的桶（等价于新桶），防止 Map 无限增长（内存泄漏）
  let max_buckets = 10000
  self.use_middleware(async fn(req, next) {
    let key = client_key(req, trust_proxy)
    // 注意：`@env.now()` 单位是**毫秒**
    let now = @env.now()
    let (tokens, last) = match buckets.val.get(key) {
      Some(b) => (b.tokens, b.last_ms)
      None => (cap, now)
    }
    let elapsed_sec = (if now > last { now - last } else { 0UL }).to_double() /
      1000.0
    let boosted = tokens + elapsed_sec * rate
    let refilled = if boosted > cap { cap } else { boosted }
    if refilled < 1.0 {
      let resp = error_response(429, "rate limit exceeded")
      resp.headers.push(("Retry-After", "1"))
      resp
    } else {
      buckets.val.set(key, { tokens: refilled - 1.0, last_ms: now, })
      // 有界淘汰：**不能**只删「已补满」的桶 —— 攻击者每个 key 只发一次请求时，
      // 所有桶都不满，清理会完全失效（Map 仍无界增长），且每请求都 O(n) 扫描。
      // 改为：超上限时一次淘汰一半（摊还成本 = 1/5000 次请求一次 O(n)）。
      if buckets.val.length() > max_buckets {
        let keys : Array[String] = []
        for entry in buckets.val.iter() {
          let (k, _) = entry
          keys.push(k)
        }
        let half = keys.length() / 2
        let mut i = 0
        while i < half {
          buckets.val.remove(keys[i])
          i = i + 1
        }
      }
      next()
    }
  })
}
