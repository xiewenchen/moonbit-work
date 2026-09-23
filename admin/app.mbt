///|
/// 后端管理接口：给桌面 IDE 的「后端面板」提供只读的 PG / Redis 概览。
///
/// 端点：
///   GET /api/pg/tables            列出 public schema 的表
///   GET /api/pg/rows?table=x&limit=50   看某表的前 N 行
///   GET /api/redis/keys?pattern=* 列出匹配的 key（有数量上限）
///   GET /api/redis/get?key=x      读一个 key 的值
///
/// 安全要点：**表名/key 是标识符，不能用参数化占位符**，
/// 必须做白名单字符校验（否则是 SQL 注入）。

///|
/// 校验 SQL 标识符（表名/列名）：只允许字母数字下划线，防止注入。
fn safe_ident(name : String) -> String? {
  if name == "" || name.length() > 63 {
    return None
  }
  for i = 0; i < name.length(); i = i + 1 {
    match name.get_char(i) {
      Some(c) =>
        if !((c >= 'a' && c <= 'z') ||
          (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') ||
          c == '_') {
          return None
        }
      None => return None
    }
  }
  Some(name)
}

///|
/// 把一行渲染成 JSON 对象（键来自 columns）。
fn row_json(columns : Array[String], row : Array[String?]) -> String {
  let buf = Buffer()
  buf.write_string_utf8("{")
  for i = 0; i < columns.length(); i = i + 1 {
    if i > 0 {
      buf.write_string_utf8(",")
    }
    buf.write_string_utf8("\"")
    buf.write_string_utf8(admin_json_escape(columns[i]))
    buf.write_string_utf8("\":")
    match row.get(i) {
      Some(v) =>
        match v {
          Some(s) => {
            buf.write_string_utf8("\"")
            buf.write_string_utf8(admin_json_escape(s))
            buf.write_string_utf8("\"")
          }
          None => buf.write_string_utf8("null")
        }
      None => buf.write_string_utf8("null")
    }
  }
  buf.write_string_utf8("}")
  buf.to_bytes() |> @utf8.decode_lossy
}

///|
fn admin_json_escape(s : String) -> String {
  let buf = Buffer()
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some('"') => buf.write_string_utf8("\\\"")
      Some('\\') => buf.write_string_utf8("\\\\")
      Some('\n') => buf.write_string_utf8("\\n")
      Some('\r') => buf.write_string_utf8("\\r")
      Some('\t') => buf.write_string_utf8("\\t")
      Some(c) =>
        if c.to_int() < 32 || c.to_int() == 127 {
          ()
        } else {
          buf.write_string_utf8(c.to_string())
        }
      None => ()
    }
  }
  buf.to_bytes() |> @utf8.decode_lossy
}

///|
/// 给 App 装上管理接口（只读）。
///
/// 注：MoonBit 不支持跨包给类型加方法，所以这里是普通函数（而非 `App::use_admin`）。
pub fn use_admin(a : @app.App) -> Unit {
  a.get("/api/pg/tables", async fn(_req) {
    let r = a.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      [],
    )
    let buf = Buffer()
    buf.write_string_utf8("[")
    for i = 0; i < r.rows.length(); i = i + 1 {
      if i > 0 {
        buf.write_string_utf8(",")
      }
      match r.text(i, 0) {
        Some(v) => {
          buf.write_string_utf8("\"")
          buf.write_string_utf8(admin_json_escape(v))
          buf.write_string_utf8("\"")
        }
        None => buf.write_string_utf8("null")
      }
    }
    buf.write_string_utf8("]")
    @http.Response::json(200, buf.to_bytes() |> @utf8.decode_lossy)
  })
  a.get("/api/pg/rows", async fn(req) {
    let table = match req.query("table") {
      Some(t) => t
      None => return @http.Response::text(400, "missing table")
    }
    match safe_ident(table) {
      None => @http.Response::text(400, "invalid table name")
      Some(t) => {
        let limit = match req.query("limit") {
          Some(l) => {
            let mut n = 0
            let mut ok = true
            for i = 0; i < l.length(); i = i + 1 {
              match l.get_char(i) {
                Some(c) =>
                  if c >= '0' && c <= '9' && n < 1000 {
                    n = n * 10 + (c.to_int() - '0'.to_int())
                  } else {
                    ok = false
                  }
                None => ()
              }
            }
            if ok && n > 0 && n <= 200 {
              n
            } else {
              50
            }
          }
          None => 50
        }
        // 表名已经过白名单校验，可安全嵌入
        let sql = "SELECT * FROM " + t + " LIMIT " + limit.to_string()
        let r = a.query(sql, [])
        let buf = Buffer()
        buf.write_string_utf8("{\"columns\":[")
        for i = 0; i < r.columns.length(); i = i + 1 {
          if i > 0 {
            buf.write_string_utf8(",")
          }
          buf.write_string_utf8("\"")
          buf.write_string_utf8(admin_json_escape(r.columns[i]))
          buf.write_string_utf8("\"")
        }
        buf.write_string_utf8("],\"rows\":[")
        for i = 0; i < r.rows.length(); i = i + 1 {
          if i > 0 {
            buf.write_string_utf8(",")
          }
          buf.write_string_utf8(row_json(r.columns, r.rows[i]))
        }
        buf.write_string_utf8("]}")
        @http.Response::json(200, buf.to_bytes() |> @utf8.decode_lossy)
      }
    }
  })
  a.get("/api/redis/keys", async fn(req) {
    let pattern = match req.query("pattern") {
      Some(p) => if p == "" { "*" } else { p }
      None => "*"
    }
    // `with_redis` 的闭包返回 Unit，用 Ref 把结果带出来
    let res_ref : Ref[@redis.Resp] = Ref(@redis.Resp::NullBulk)
    a.with_redis(async fn(c) { res_ref.val = c.command(["KEYS", pattern]) })
    let items : Array[String] = match res_ref.val {
      @redis.Resp::ArrayValue(arr) => {
        let out : Array[String] = []
        for v in arr {
          match v {
            @redis.Resp::BulkString(b) => out.push(@utf8.decode_lossy(b))
            @redis.Resp::SimpleString(s) => out.push(s)
            _ => ()
          }
        }
        out
      }
      _ => []
    }
    // 上限：避免超大 keyspace 把响应撑爆
    let n = if items.length() > 500 { 500 } else { items.length() }
    let buf = Buffer()
    buf.write_string_utf8("{\"total\":")
    buf.write_string_utf8(items.length().to_string())
    buf.write_string_utf8(",\"keys\":[")
    for i = 0; i < n; i = i + 1 {
      if i > 0 {
        buf.write_string_utf8(",")
      }
      buf.write_string_utf8("\"")
      buf.write_string_utf8(admin_json_escape(items[i]))
      buf.write_string_utf8("\"")
    }
    buf.write_string_utf8("]}")
    @http.Response::json(200, buf.to_bytes() |> @utf8.decode_lossy)
  })
  a.get("/api/redis/get", async fn(req) {
    let key = match req.query("key") {
      Some(k) => k
      None => return @http.Response::text(400, "missing key")
    }
    let res_ref : Ref[@redis.Resp] = Ref(@redis.Resp::NullBulk)
    a.with_redis(async fn(c) { res_ref.val = c.command(["GET", key]) })
    let value = match res_ref.val {
      @redis.Resp::BulkString(b) => Some(@utf8.decode_lossy(b))
      @redis.Resp::SimpleString(s) => Some(s)
      @redis.Resp::Integer(n) => Some(n.to_string())
      @redis.Resp::NullBulk | @redis.Resp::NullArray => None
      _ => None
    }
    let buf = Buffer()
    buf.write_string_utf8("{\"key\":\"")
    buf.write_string_utf8(admin_json_escape(key))
    buf.write_string_utf8("\",\"value\":")
    match value {
      Some(v) => {
        buf.write_string_utf8("\"")
        buf.write_string_utf8(admin_json_escape(v))
        buf.write_string_utf8("\"")
      }
      None => buf.write_string_utf8("null")
    }
    buf.write_string_utf8("}")
    @http.Response::json(200, buf.to_bytes() |> @utf8.decode_lossy)
  })
}
