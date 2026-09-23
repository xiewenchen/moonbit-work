///|
/// RealWorld / Conduit 后端服务入口。
///
/// 环境变量（沿用平台 `MBP_` 前缀，见 `@app.Config::from_env`）：
///   MBP_HOST / MBP_PORT           监听地址（默认 0.0.0.0:8080）
///   MBP_PG_HOST / MBP_PG_PORT / MBP_PG_USER / MBP_PG_PASSWORD / MBP_PG_DB
///   MBP_REDIS_HOST / MBP_REDIS_PORT
///   MBP_JWT_SECRET                JWT 签名密钥（**生产必须设置**）
///   MBP_JWT_TTL_SEC               token 有效期秒数（默认 604800 = 7 天）
///   MBP_RATE_LIMIT                每秒令牌数（默认 50；压测时可调大）
///   MBP_TRUST_PROXY               置 1 时按 X-Forwarded-For 限流（**仅在反向代理之后才可开启**）
///   MBP_CORS_ORIGINS              允许的跨域来源（逗号分隔；**默认不开放**，`*` 表示全部）
///   MBP_BCRYPT_COST               bcrypt 成本因子（默认 6，夹到 [4,14]）
///   MBP_MAX_CONNECTIONS           并发连接上限（默认 64；实测并发 32 时单实例吞吐达峰）
async fn main {
  let base = @app.Config::from_env()
  let app = @app.App::new(base)
  app.use_logging()
  app.use_metrics()
  app.use_readiness()
  let rate = match @env.get_env_var("MBP_RATE_LIMIT") {
    Some(s) =>
      match @conduit.parse_nonneg_int(s) {
        Some(n) => if n == 0 { 50.0 } else { n.to_double() }
        None => 50.0
      }
    None => 50.0
  }
  // 是否信任反向代理的 X-Forwarded-For（仅在确实部署于可信代理之后时才开启）
  let trust_proxy = match @env.get_env_var("MBP_TRUST_PROXY") {
    Some(s) => s == "1" || s.to_lower() == "true"
    None => false
  }
  app.use_rate_limit(rate, rate * 2.0, trust_proxy~)
  // CORS：RealWorld 前端是独立部署的 SPA，需要预检与跨域头。
  // 默认**不开放跨域**；部署方用 MBP_CORS_ORIGINS 显式列出前端来源。
  let cors_spec = match @env.get_env_var("MBP_CORS_ORIGINS") {
    Some(v) => v
    None => ""
  }
  @conduit.use_cors(app, cors_spec)
  let secret = match @env.get_env_var("MBP_JWT_SECRET") {
    Some(s) => if s == "" { "conduit-dev-secret-change-me" } else { s }
    None => "conduit-dev-secret-change-me"
  }
  let ttl = match @env.get_env_var("MBP_JWT_TTL_SEC") {
    Some(s) =>
      match @conduit.parse_nonneg_int(s) {
        Some(n) => if n == 0 { 604800UL } else { n.to_uint64() }
        None => 604800UL
      }
    None => 604800UL
  }
  let bcrypt_cost = match @env.get_env_var("MBP_BCRYPT_COST") {
    Some(v) =>
      match @conduit.parse_nonneg_int(v) {
        Some(n) => @conduit.clamp_bcrypt_cost(n)
        None => 6
      }
    None => 6
  }
  @conduit.use_conduit(app, secret, ttl, bcrypt_cost~)
  // 迁移（幂等）
  app.with_db(async fn(c) {
    let applied = @db.migrate(c, "conduit/migrations")
    if applied.length() > 0 {
      for name in applied {
        println("已应用迁移: \{name}")
      }
    }
  })
  // 启动自检：表结构不符时立刻失败，而不是让每个请求都 500
  let missing = @conduit.verify_schema(app)
  if missing.length() > 0 {
    println("[fatal] 数据库 schema 与预期不符，缺少以下列：")
    for m in missing {
      println("  - " + m)
    }
    println(
      "[fatal] 常见原因：与其他服务共用了数据库（同名表被 CREATE TABLE IF NOT EXISTS 跳过）。",
    )
    println("[fatal] 请为 Conduit 使用独立数据库（MBP_PG_DB）。")
    fail("schema 自检失败")
  }
  // 并发上限：基于容量标定（单实例并发 32 时吞吐达峰），默认取 64 作缓冲
  let max_conns = match @env.get_env_var("MBP_MAX_CONNECTIONS") {
    Some(v) =>
      match @conduit.parse_nonneg_int(v) {
        Some(n) => if n == 0 { 64 } else { n }
        None => 64
      }
    None => 64
  }
  let base_limits = @server.ServerLimits::default()
  app.serve_with({ ..base_limits, max_connections: max_conns, })
}
