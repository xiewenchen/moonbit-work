///|
/// 安全测试靶场：装上全部中间件（日志 / 指标 / 就绪 / 鉴权 / 限流），
/// 供渗透测试使用。限流刻意设小（2 req/s，桶 3），便于观察绕过。
///
/// 运行：`moon run --target native sec/cmd/main`（监听 127.0.0.1:8090）
async fn main {
  let base = @app.Config::default()
  let app = @app.App::new({ ..base, port: 8090, })
  app.use_logging()
  app.use_metrics()
  app.use_readiness()
  app.use_rate_limit(2.0, 3.0)
  app.use_auth("sec-secret")
  app.get("/api/echo", fn(req) { @http.Response::text(200, req.text()) })
  app.get("/api/notes/:id", fn(req) {
    match req.param("id") {
      Some(id) => @http.Response::text(200, "note:" + id)
      None => @http.Response::text(400, "no id")
    }
  })
  app.serve()
}
