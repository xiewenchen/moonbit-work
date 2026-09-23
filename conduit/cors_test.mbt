///|
/// CORS 白名单逻辑的单测。

///|
test "parse_origins: 逗号分隔与空白清理" {
  let a = parse_origins("https://a.com, https://b.com")
  assert_eq(a.length(), 2)
  assert_eq(a[0], "https://a.com")
  assert_eq(a[1], "https://b.com")
  assert_eq(parse_origins("").length(), 0)
  assert_eq(parse_origins("  ,  ,").length(), 0)
  let star = parse_origins("*")
  assert_eq(star.length(), 1)
  assert_eq(star[0], "*")
  let trailing = parse_origins("https://a.com,,https://b.com,")
  assert_eq(trailing.length(), 2)
  assert_eq(trailing[0], "https://a.com")
  assert_eq(trailing[1], "https://b.com")
}

///|
test "cors_allowed: 精确匹配与通配" {
  let list : Array[String] = [
    "https://app.example.com", "https://admin.example.com",
  ]
  assert_eq(cors_allowed(list, "https://app.example.com"), true)
  assert_eq(cors_allowed(list, "https://admin.example.com"), true)
  // 不在白名单 → 拒绝
  assert_eq(cors_allowed(list, "https://evil.com"), false)
  // 只是前缀相同也要拒绝
  assert_eq(cors_allowed(list, "https://app.example.com.evil.com"), false)
  // 大小写不敏感
  assert_eq(cors_allowed(list, "HTTPS://APP.EXAMPLE.COM"), true)
  // 通配
  assert_eq(cors_allowed(["*"], "https://anything.example"), true)
  // 空白名单 → 全部拒绝（默认不开放跨域）
  let empty : Array[String] = []
  assert_eq(cors_allowed(empty, "https://app.example.com"), false)
}
