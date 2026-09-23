///|
/// 极简 SQL 迁移：按文件名排序应用目录下的 `*.sql`，
/// 已应用的版本记录在 `schema_migrations`。

///|
async fn read_text(path : String) -> String {
  let data = @fs.read_file(path)
  @utf8.decode_lossy(data.binary())
}

///|
fn ends_with_sql(name : String) -> Bool {
  name.length() > 4 && name[name.length() - 4:].to_owned() == ".sql"
}

///|
/// 应用 `dir` 下所有尚未执行的迁移，返回本次新应用的版本名（按顺序）。
///
/// 每个迁移在**一个事务**里执行 SQL 并写入 `schema_migrations`，
/// 失败会整体回滚（不会留下半应用状态）。
pub async fn migrate(client : @client.Client, dir : String) -> Array[String] {
  client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  )
  |> ignore
  let applied_res = client.query("SELECT version FROM schema_migrations")
  let applied : Map[String, Unit] = Map([])
  for i = 0; i < applied_res.rows.length(); i = i + 1 {
    match applied_res.text(i, 0) {
      Some(v) => applied.set(v, ())
      None => ()
    }
  }
  // ⚠️ 实测（本机 Windows + native）：`@fs.readdir(sort=true)` 返回的是**降序**
  //    sort=true : 0002_seed.sql | 0001_create.sql
  //    sort=false: 0001_create.sql | 0002_seed.sql（文件系统自然序，不可依赖）
  // 迁移必须**升序**执行，故这里显式反转。不要想当然地认为 sort 是升序 —— 曾因此把顺序弄反。
  let raw = @fs.readdir(dir, sort=true)
  let files : Array[String] = []
  let m = raw.length()
  for i = 0; i < m; i = i + 1 {
    files.push(raw[m - 1 - i])
  }
  let newly : Array[String] = []
  for name in files {
    if ends_with_sql(name) && !applied.contains(name) {
      let sql = read_text(dir + "/" + name)
      // 原子性：DDL/DML 与「记录已应用」必须在同一事务里，
      // 否则中途失败会留下「SQL 已执行但未记录」的半应用状态。
      client.with_transaction(async fn() {
        client.query(sql) |> ignore
        client.query_params(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [Some(name)],
        )
        |> ignore
      })
      newly.push(name)
    }
  }
  newly
}
