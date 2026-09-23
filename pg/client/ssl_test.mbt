///|
/// PG SSLRequest / TLS 连接测试（需要本机 55432 的 PG，且其 ssl=on）。
///
/// docker 官方镜像默认 `ssl=on`（自签证书），所以 SSLRequest 会得到 `S`。

///|
#skip("需要本地 PostgreSQL TLS（本地起服务后跑 --include-skipped）")
async test "connect over TLS via SSLRequest" {
  let c = @client.Client::connect(
    "127.0.0.1",
    55435,
    "mbp",
    "",
    "mbptest",
    ssl=true,
    trust=@tls.TrustedRoot::NoVerification,
  )
  defer c.close()
  let r = c.query("SELECT 42 AS answer")
  assert_eq(r.columns, ["answer"])
  assert_eq(r.rows[0][0], Some("42"))
  // 服务器会报告是否在用 SSL
  let s = c.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
  assert_eq(s.rows[0][0], Some("t"))
}

///|
#skip("需要本地 PostgreSQL 55432（本地起服务后跑 --include-skipped）")
async test "connect without TLS still works" {
  let c = @client.Client::connect("127.0.0.1", 55432, "mbp", "", "mbptest")
  defer c.close()
  let s = c.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
  assert_eq(s.rows[0][0], Some("f"))
}
