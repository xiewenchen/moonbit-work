///|
/// PostgreSQL 客户端集成测试：需要本机 5432 的 PG（trust 认证）。
///
/// 起服务：
///   docker run -d --name mbp-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
///     -e POSTGRES_DB=mbptest -e POSTGRES_USER=mbp -p 5432:5432 postgres:16-alpine
/// 跑测试：`moon test --target native`

///|
async fn connect() -> @client.Client {
  @client.Client::connect("127.0.0.1", 55432, "mbp", "", "mbptest")
}

///|
async test "connect and SELECT 1" {
  let c = connect()
  defer c.close()
  let r = c.query("SELECT 1 AS one")
  assert_eq(r.columns, ["one"])
  assert_eq(r.rows.length(), 1)
  assert_eq(r.rows[0][0], Some("1"))
  assert_eq(r.command, "SELECT 1")
}

///|
async test "create / insert / select / drop" {
  let c = connect()
  defer c.close()
  c.query("DROP TABLE IF EXISTS mbp_test") |> ignore
  c.query("CREATE TABLE mbp_test (id int, name text)") |> ignore
  let n = c.exec("INSERT INTO mbp_test VALUES (1, 'alice'), (2, 'bob')")
  assert_eq(n, 2)
  let r = c.query("SELECT id, name FROM mbp_test ORDER BY id")
  assert_eq(r.columns, ["id", "name"])
  assert_eq(r.rows.length(), 2)
  assert_eq(r.rows[0][0], Some("1"))
  assert_eq(r.rows[0][1], Some("alice"))
  assert_eq(r.rows[1][1], Some("bob"))
  c.query("DROP TABLE mbp_test") |> ignore
}

///|
async test "NULL comes back as None" {
  let c = connect()
  defer c.close()
  let r = c.query("SELECT NULL::text AS v")
  assert_eq(r.rows.length(), 1)
  assert_eq(r.rows[0][0], None)
}

///|
async test "server error raises" {
  let c = connect()
  defer c.close()
  let failed : Bool = try c.query("SELECT * FROM no_such_table_xyz") catch {
    _ => true
  } noraise {
    _ => false
  }
  assert_eq(failed, true)
}

///|
async test "parameterized query" {
  let c = connect()
  defer c.close()
  let r = c.query_params("SELECT $1::int AS a, $2::text AS b", [
    Some("42"),
    Some("hello"),
  ])
  assert_eq(r.columns, ["a", "b"])
  assert_eq(r.rows[0][0], Some("42"))
  assert_eq(r.rows[0][1], Some("hello"))
}

///|
async test "parameterized query with NULL" {
  let c = connect()
  defer c.close()
  let r = c.query_params("SELECT $1::text AS v", [None])
  assert_eq(r.rows.length(), 1)
  assert_eq(r.rows[0][0], None)
}

///|
async test "parameterized insert and select" {
  let c = connect()
  defer c.close()
  c.query("DROP TABLE IF EXISTS mbp_param") |> ignore
  c.query("CREATE TABLE mbp_param (id int, name text)") |> ignore
  c.query_params("INSERT INTO mbp_param VALUES ($1, $2)", [
    Some("7"),
    Some("zed"),
  ])
  |> ignore
  let r = c.query_params("SELECT name FROM mbp_param WHERE id = $1", [Some("7")])
  assert_eq(r.rows.length(), 1)
  assert_eq(r.rows[0][0], Some("zed"))
  c.query("DROP TABLE mbp_param") |> ignore
}
