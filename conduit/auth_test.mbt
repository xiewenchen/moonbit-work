///|
/// bcrypt 成本因子护栏的单测。

///|
test "clamp_bcrypt_cost: 夹到安全区间" {
  // 太低 → 抬到下限
  assert_eq(clamp_bcrypt_cost(0), 4)
  assert_eq(clamp_bcrypt_cost(1), 4)
  assert_eq(clamp_bcrypt_cost(3), 4)
  // 区间内 → 原样
  assert_eq(clamp_bcrypt_cost(4), 4)
  assert_eq(clamp_bcrypt_cost(6), 6)
  assert_eq(clamp_bcrypt_cost(10), 10)
  assert_eq(clamp_bcrypt_cost(14), 14)
  // 太高 → 压到上限（否则单次哈希到秒级，实际不可用）
  assert_eq(clamp_bcrypt_cost(15), 14)
  assert_eq(clamp_bcrypt_cost(31), 14)
}
