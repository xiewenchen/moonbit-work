///|
/// 示例后端服务：一个用 `app` 框架写的小「笔记」API。
///
/// - `GET    /health`     —— 框架内置
/// - `GET    /notes`      —— 列出全部笔记（PostgreSQL）
/// - `GET    /notes/:id`  —— 取一条（PostgreSQL）
/// - `POST   /notes`      —— 新建（JSON body：`{"title": "...", "body": "..."}`）
/// - `DELETE /notes/:id`  —— 删除
/// - `GET    /stats`      —— 请求计数（Redis `INCR`）
///
/// 数据访问是原生 SQL（`app.query`），配合框架的连接池。

///|
/// 建表。
pub async fn ensure_schema(app : @app.App) -> Unit {
  app.exec(
    "CREATE TABLE IF NOT EXISTS notes (id serial primary key, title text not null, body text)",
  )
  |> ignore
}

///|
/// 从 JSON 文本里取一个字符串字段。
fn json_field(text : String, key : String) -> String? {
  let parsed : Json? = try @json.parse(text) catch {
    _ => None
  } noraise {
    v => Some(v)
  }
  match parsed {
    Some(Json::Object(m)) =>
      match m.get(key) {
        Some(Json::String(s)) => Some(s)
        _ => None
      }
    _ => None
  }
}

///|
fn json_escape(s : String) -> String {
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
          // 丢弃其它控制字符，保证输出是合法 JSON
        } else {
          buf.write_string_utf8(c.to_string())
        }
      None => ()
    }
  }
  buf.to_bytes() |> @utf8.decode_lossy
}

///|
fn cell(rows : @app.PgResult, row : Int, col : Int) -> String {
  match rows.text(row, col) {
    Some(s) => s
    None => ""
  }
}

///|
fn note_json(rows : @app.PgResult, i : Int) -> String {
  let id = cell(rows, i, 0)
  let title = json_escape(cell(rows, i, 1))
  let body = json_escape(cell(rows, i, 2))
  "{\"id\":\{id},\"title\":\"\{title}\",\"body\":\"\{body}\"}"
}

///|
fn notes_json(rows : @app.PgResult) -> String {
  let buf = Buffer()
  buf.write_string_utf8("[")
  for i = 0; i < rows.rows.length(); i = i + 1 {
    if i > 0 {
      buf.write_string_utf8(",")
    }
    buf.write_string_utf8(note_json(rows, i))
  }
  buf.write_string_utf8("]")
  buf.to_bytes() |> @utf8.decode_lossy
}

///|
/// 构建应用（注册中间件与路由）。
pub fn build_app(config : @app.Config) -> @app.App {
  let app = @app.App::new(config)
  app.use_logging()
  app.use_metrics()
  app.use_readiness()
  let a = app
  // 中间件：统计每个请求（写 Redis）
  app.use_middleware(async fn(_req, next) {
    // 计数是「尽力而为」：Redis 不可用绝不能影响业务请求与探针
    let _ = @app.best_effort(0L, async fn() { a.incr("notes:requests") })
    next()
  })
  let api = app.group("/notes")
  api.get("", async fn(_req) {
    let rows = a.query("SELECT id, title, body FROM notes ORDER BY id", [])
    @http.Response::json(200, notes_json(rows))
  })
  api.get("/:id", async fn(req) {
    let id = match req.param("id") {
      Some(s) => s
      None => "0"
    }
    let rows = a.query("SELECT id, title, body FROM notes WHERE id = $1", [
      Some(id),
    ])
    if rows.rows.length() == 0 {
      @http.Response::json(404, "{\"error\":\"not found\"}")
    } else {
      @http.Response::json(200, note_json(rows, 0))
    }
  })
  api.post("", async fn(req) {
    let text = req.text()
    let title = match json_field(text, "title") {
      Some(s) => s
      None => ""
    }
    let body = match json_field(text, "body") {
      Some(s) => s
      None => ""
    }
    if title == "" {
      @http.Response::json(400, "{\"error\":\"title required\"}")
    } else {
      let rows = a.query(
        "INSERT INTO notes (title, body) VALUES ($1, $2) RETURNING id",
        [Some(title), Some(body)],
      )
      let id = cell(rows, 0, 0)
      @http.Response::json(201, "{\"id\":\{id}}")
    }
  })
  api.delete("/:id", async fn(req) {
    let id = match req.param("id") {
      Some(s) => s
      None => "0"
    }
    let n = a.query("DELETE FROM notes WHERE id = $1 RETURNING id", [Some(id)])
    if n.rows.length() == 0 {
      @http.Response::json(404, "{\"error\":\"not found\"}")
    } else {
      @http.Response::json(200, "{\"deleted\":\{id}}")
    }
  })
  app.get("/stats", async fn(_req) {
    let n = a.incr("notes:requests")
    @http.Response::json(200, "{\"requests\":\{n}}")
  })
  app
}
