///|
/// 并发模型测试：验证多进程 spawn 机制（Windows 用 cmd）。

///|
#skip("需要 worker 二进制（本地起服务后跑 --include-skipped）")
async test "spawn_workers runs N processes" {
  let codes = @cluster.spawn_workers("cmd", ["/c", "exit", "0"], 3, 9000)
  assert_eq(codes.length(), 3)
  for c in codes {
    assert_eq(c, 0)
  }
}
