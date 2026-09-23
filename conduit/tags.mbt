///|
/// Conduit 标签端点。
///
///   GET /tags → 200 {"tags":["a","b",...]}

///|
/// GET /tags：返回全部已使用的标签（按名称排序）。
pub async fn handle_tags(
  a : @app.App,
  _auth : AuthConfig,
  _req : @http.Request,
) -> @http.Response {
  let rows = a.query("SELECT name FROM tags ORDER BY name", [])
  let names : Array[String] = []
  for i = 0; i < rows.rows.length(); i = i + 1 {
    match rows.text(i, 0) {
      Some(n) => names.push(n)
      None => ()
    }
  }
  @http.Response::json(200, jobj([("tags", jstrs(names))]).stringify())
}
