///|
/// PG 事务测试（需要本机 55432 的 PG）。

///|
async fn txn_conn() -> @client.Client {
  @client.Client::connect("127.0.0.1", 55432, "mbp", "", "mbptest")
}

///|
async test "transaction commit persists" {
  let c = txn_conn()
  defer c.close()
  c.query("DROP TABLE IF EXISTS txn_test") |> ignore
  c.query("CREATE TABLE txn_test (v text)") |> ignore
  c.with_transaction(async fn() {
    c.query("INSERT INTO txn_test VALUES ('a')") |> ignore
    c.query("INSERT INTO txn_test VALUES ('b')") |> ignore
  })
  let r = c.query("SELECT count(*) FROM txn_test")
  assert_eq(r.text(0, 0), Some("2"))
  c.query("DROP TABLE txn_test") |> ignore
}

///|
async test "transaction rolls back on error and connection still usable" {
  let c = txn_conn()
  defer c.close()
  c.query("DROP TABLE IF EXISTS txn_test2") |> ignore
  c.query("CREATE TABLE txn_test2 (v text)") |> ignore
  let failed : Bool = try
    c.with_transaction(async fn() {
      c.query("INSERT INTO txn_test2 VALUES ('x')") |> ignore
      fail("boom")
    })
  catch {
    _ => true
  } noraise {
    _ => false
  }
  assert_eq(failed, true)
  // 回滚生效：表里没有数据
  let r = c.query("SELECT count(*) FROM txn_test2")
  assert_eq(r.text(0, 0), Some("0"))
  // 出错后连接仍可用（错误恢复）
  let ok = c.query("SELECT 1 AS one")
  assert_eq(ok.text(0, 0), Some("1"))
  c.query("DROP TABLE txn_test2") |> ignore
}

///|
async test "manual begin / commit" {
  let c = txn_conn()
  defer c.close()
  c.query("DROP TABLE IF EXISTS txn_test3") |> ignore
  c.query("CREATE TABLE txn_test3 (v int)") |> ignore
  c.begin()
  c.query("INSERT INTO txn_test3 VALUES (7)") |> ignore
  c.rollback()
  c.begin()
  c.query("INSERT INTO txn_test3 VALUES (8)") |> ignore
  c.commit()
  let r = c.query("SELECT v FROM txn_test3")
  assert_eq(r.rows.length(), 1)
  assert_eq(r.text(0, 0), Some("8"))
  c.query("DROP TABLE txn_test3") |> ignore
}
