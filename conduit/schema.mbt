///|
/// 启动期 schema 自检。
///
/// ## 为什么需要
///
/// 迁移用的是 `CREATE TABLE IF NOT EXISTS`（幂等所必需），
/// 但这意味着：**若库里已存在同名但结构不同的表**（例如与另一个服务共用了数据库），
/// 迁移会静默跳过，随后所有查询都以 500 失败 —— 且报错信息是
/// `column "email" of relation "users" does not exist`，很难一眼看出根因。
///
/// 实测踩到过这个坑（本地 `mbptest` 库里有 demo 示例建的 `users(id, name)`）。
/// 因此在启动时**主动校验关键列存在**，缺了就明确报错并退出。

///|
/// 期望存在的 (表名, 列名) 清单。
///
/// 注意：MoonBit 的 `const` 只允许不可变基元类型，数组必须用函数返回。
fn required_columns() -> Array[(String, String)] {
  [
    ("users", "email"),
    ("users", "username"),
    ("users", "password_hash"),
    ("articles", "slug"),
    ("articles", "author_id"),
    ("comments", "body"),
    ("article_tags", "tag_id"),
    ("favorites", "user_id"),
    ("follows", "follower_id"),
  ]
}

///|
/// 校验 schema。返回缺失项描述（空数组表示全部正常）。
pub async fn verify_schema(a : @app.App) -> Array[String] {
  let missing : Array[String] = []
  for pair in required_columns() {
    let (table, col) = pair
    let r = a.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
      [Some(table), Some(col)],
    )
    if r.rows.length() == 0 {
      missing.push(table + "." + col)
    }
  }
  missing
}
