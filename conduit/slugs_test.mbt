///|
/// slug 生成的单测（含中文/标点场景 —— 这些是踩过坑的地方）。

///|
test "slugify: ASCII 标题" {
  assert_eq(slugify("Hello World"), "hello-world")
  assert_eq(slugify("  Trim   Me  "), "trim-me")
  assert_eq(slugify("C++ Rocks"), "c-rocks")
}

///|
test "slugify: 中文必须保留（否则信息全失）" {
  // 回归：早先只保留 ASCII，导致纯中文标题退化成 "article"
  assert_eq(
    slugify("纯中文标题没有任何英文"),
    "纯中文标题没有任何英文",
  )
  assert_eq(slugify("MoonBit 写后端"), "moonbit-写后端")
}

///|
test "slugify: 排除 Unicode 标点" {
  // 回归：全角冒号曾留在 slug 里。
  // 标点被过滤后应变成词分隔符 `-`（保留词边界），而不是被静默丢弃。
  assert_eq(
    slugify("重构：把协议层剥出来"),
    "重构-把协议层剥出来",
  )
  assert_eq(slugify("标题、副标题"), "标题-副标题")
  assert_eq(slugify("问号？感叹号！"), "问号-感叹号")
}

///|
test "slugify: 长度上限" {
  let long = "a" + "很长的标题".repeat(40)
  let s = slugify(long)
  // 上限 60 个码点
  assert_true(s.length() <= 60 * 3)
}
