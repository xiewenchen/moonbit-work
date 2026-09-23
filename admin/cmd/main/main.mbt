///|
/// 后端管理服务入口：`moon run --target native admin/cmd/main`
///
/// 默认监听 127.0.0.1:8081，提供只读的 PG / Redis 概览接口，
/// 供桌面 IDE 的「后端面板」调用。
async fn main {
  let base = @app.Config::default()
  let config : @app.Config = { ..base, port: 8081, }
  let app = @app.App::new(config)
  @admin.use_admin(app)
  println(
    "[admin] 管理接口已启用：/api/pg/tables | /api/pg/rows?table= | /api/redis/keys | /api/redis/get?key=",
  )
  app.serve()
}
