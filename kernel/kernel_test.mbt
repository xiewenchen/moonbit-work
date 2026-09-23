///|
/// 平台内核集成测试（测试 cwd 为模块根）。

///|
async test "find module up the tree" {
  match @kernel.find_module(".") {
    Some(m) => {
      assert_eq(m.name, "xiewenchen/moonbit-platform")
      assert_eq(m.version, "0.1.0")
    }
    None => fail("moon.mod not found")
  }
}

///|
async test "moon version runs and captures stdout" {
  let out = @kernel.moon_version()
  assert_eq(out.code, 0)
  assert_eq(out.stdout.contains("moon"), true)
}

///|
async test "moon check on this module succeeds" {
  let out = @kernel.moon_check(".")
  if out.code != 0 {
    fail("moon check failed: \{out.stderr}")
  }
  assert_eq(out.code, 0)
}

///|
async test "moon ide outline returns JSON" {
  let out = @kernel.ide_outline(".", "kernel/kernel.mbt")
  assert_eq(out.code, 0)
  // outline 输出是 JSON 数组
  assert_eq(out.stdout.contains("find_module"), true)
}
