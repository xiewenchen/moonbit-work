///|
/// notes 服务入口：`moon run --target native notes/cmd/main`
///
/// 启动时先跑 `notes/migrations/` 下的迁移，再监听。
async fn main {
  let config = @app.Config::from_env()
  match config.validate() {
    Ok(_) => ()
    Err(msg) => {
      println("[fatal] invalid config: \{msg}")
      return
    }
  }
  let app = @notes.build_app(config)
  app.with_db(async fn(c) { @db.migrate(c, "notes/migrations") |> ignore })
  app.serve()
}
