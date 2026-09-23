///|
/// 认证集成测试：连使用 SCRAM-SHA-256 与 MD5 的 PostgreSQL。
///
/// 起服务：
///   docker run -d --name mbp-pg-scram -e POSTGRES_PASSWORD=secret \
///     -e POSTGRES_DB=mbptest -e POSTGRES_USER=mbp -p 55434:5432 postgres:16-alpine
///   docker run -d --name mbp-pg-md5 -e POSTGRES_HOST_AUTH_METHOD=md5 \
///     -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=mbptest -e POSTGRES_USER=mbp \
///     -p 55433:5432 postgres:16-alpine

///|
async test "scram-sha-256 authentication" {
  let c = @client.Client::connect(
    "127.0.0.1", 55434, "mbp", "secret", "mbptest",
  )
  defer c.close()
  let r = c.query("SELECT 1 AS one")
  assert_eq(r.columns, ["one"])
  assert_eq(r.rows[0][0], Some("1"))
}

///|
async test "md5 authentication" {
  let c = @client.Client::connect(
    "127.0.0.1", 55433, "mbp", "secret", "mbptest",
  )
  defer c.close()
  let r = c.query("SELECT 2 AS two")
  assert_eq(r.rows[0][0], Some("2"))
}

///|
async test "wrong password is rejected" {
  let failed : Bool = try
    @client.Client::connect("127.0.0.1", 55434, "mbp", "wrong", "mbptest")
  catch {
    _ => true
  } noraise {
    _ => false
  }
  assert_eq(failed, true)
}
