///|
/// 一个把 HTTP + Redis + PostgreSQL 串起来的 demo 服务，展示三层如何协作：
///
/// - `GET  /health`        —— 存活探针（纯 HTTP）
/// - `GET  /visits`        —— 访问计数（写 Redis：`INCR`）
/// - `POST /users`         —— 新建用户（写 PostgreSQL）
/// - `GET  /users/:id`     —— 查用户（读 PostgreSQL）
///
/// handler 内部按需建立后端连接（演示从简，未做连接池）。

///|
/// 后端连接参数。
pub(all) struct Backends {
  pg_port : Int
  redis_port : Int
} derive(Debug)

///|
/// 确保所需的表存在。
pub async fn ensure_schema(backends : Backends) -> Unit {
  let pg = @pgclient.Client::connect(
    "127.0.0.1",
    backends.pg_port,
    "mbp",
    "",
    "mbptest",
  )
  defer pg.close()
  pg.query(
    "CREATE TABLE IF NOT EXISTS users (id serial primary key, name text)",
  )
  |> ignore
}

///|
/// 构建路由。
pub fn build_router(backends : Backends) -> @server.Router {
  let router = @server.Router::new()
  router.get("/health", fn(_req) { @http.Response::text(200, "ok") })
  router.get("/visits", async fn(_req) {
    let cache = @redisclient.Client::connect("127.0.0.1", backends.redis_port)
    defer cache.close()
    let n = cache.incr("demo:visits")
    @http.Response::text(200, "visits: \{n}")
  })
  router.get("/users/:id", async fn(req) {
    let id = match req.param("id") {
      Some(s) => s
      None => "0"
    }
    let pg = @pgclient.Client::connect(
      "127.0.0.1",
      backends.pg_port,
      "mbp",
      "",
      "mbptest",
    )
    defer pg.close()
    let r = pg.query_params("SELECT name FROM users WHERE id = $1", [Some(id)])
    if r.rows.length() == 0 {
      @http.Response::text(404, "not found")
    } else {
      let name = match r.text(0, 0) {
        Some(s) => s
        None => ""
      }
      @http.Response::text(200, name)
    }
  })
  router.post("/users", async fn(req) {
    let pg = @pgclient.Client::connect(
      "127.0.0.1",
      backends.pg_port,
      "mbp",
      "",
      "mbptest",
    )
    defer pg.close()
    let r = pg.query_params(
      "INSERT INTO users (name) VALUES ($1) RETURNING id",
      [Some(req.text())],
    )
    let id = match r.text(0, 0) {
      Some(s) => s
      None => "0"
    }
    @http.Response::text(201, id)
  })
  router
}
