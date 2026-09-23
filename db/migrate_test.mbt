///|
/// 迁移测试（需要本机 55432 的 PG）。

///|
async test "migrations apply once and are idempotent" {
  let c = @client.Client::connect("127.0.0.1", 55432, "mbp", "", "mbptest")
  defer c.close()
  // 清理状态，保证可重复运行
  c.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  )
  |> ignore
  c.query("DELETE FROM schema_migrations") |> ignore
  c.query("DROP TABLE IF EXISTS mig_demo") |> ignore
  // 第一次：应用 2 个
  let first = @db.migrate(c, "db/testdata/migrations")
  assert_eq(first.length(), 2)
  // 第二次：无新增（幂等）
  let second = @db.migrate(c, "db/testdata/migrations")
  assert_eq(second.length(), 0)
  // 迁移确实生效
  let r = c.query("SELECT count(*) FROM mig_demo")
  assert_eq(r.text(0, 0), Some("2"))
  // 版本被记录
  let v = c.query(
    "SELECT count(*) FROM schema_migrations WHERE version = '0001_create.sql'",
  )
  assert_eq(v.text(0, 0), Some("1"))
  c.query("DROP TABLE mig_demo") |> ignore
  c.query("DELETE FROM schema_migrations") |> ignore
}
