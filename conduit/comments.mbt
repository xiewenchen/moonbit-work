///|
/// Conduit 评论端点。
///
///   GET    /articles/:slug/comments      → 200 {comments:[...]}（鉴权可选）
///   POST   /articles/:slug/comments      → 201 {comment} / 401 / 404 / 422
///   DELETE /articles/:slug/comments/:id  → 204 / 401 / 403 / 404

///|
/// 评论行的统一 SELECT。`$1` = 观察者 id（空串=匿名），`$2` = slug。
///
/// 列：0 id, 1 created_at, 2 updated_at, 3 body, 4 username, 5 bio, 6 image, 7 author_following
const COMMENT_COLS : String = "SELECT c.id, " +
  "to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at, " +
  "to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at, " +
  "c.body, u.username, u.bio, u.image, " +
  "CASE WHEN $1 = '' THEN false ELSE EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = NULLIF($1, '')::int AND f.following_id = c.author_id) END AS author_following " +
  "FROM comments c JOIN users u ON u.id = c.author_id " +
  "WHERE c.article_id = (SELECT id FROM articles WHERE slug = $2)"

///|
/// 一行评论 → JSON。
fn comment_from_row(rows : @pgclient.QueryResult, row : Int) -> Json {
  jobj([
    ("id", jnum64(rows.int(row, 0).unwrap_or(0L))),
    ("createdAt", jstr(rows.text(row, 1).unwrap_or(""))),
    ("updatedAt", jstr(rows.text(row, 2).unwrap_or(""))),
    ("body", jstr(rows.text(row, 3).unwrap_or(""))),
    (
      "author",
      profile_json(
        rows.text(row, 4).unwrap_or(""),
        rows.text(row, 5),
        rows.text(row, 6),
        rows.bool(row, 7).unwrap_or(false),
      ),
    ),
  ])
}

///|
/// GET /articles/:slug/comments
pub async fn handle_list_comments(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let slug = match req.param("slug") {
    Some(s) => s
    None => return not_found("article")
  }
  let viewer = match user_id_of(auth, req) {
    Some(id) => id.to_string()
    None => ""
  }
  // 文章不存在时也返回 404（与规范一致）
  let exists = a.query("SELECT 1 FROM articles WHERE slug = $1", [Some(slug)])
  if exists.rows.length() == 0 {
    return not_found("article")
  }
  let rows = a.query(COMMENT_COLS + " ORDER BY c.created_at DESC, c.id DESC", [
    Some(viewer),
    Some(slug),
  ])
  let items : Array[Json] = []
  for i = 0; i < rows.rows.length(); i = i + 1 {
    items.push(comment_from_row(rows, i))
  }
  @http.Response::json(
    200,
    jobj([("comments", Json::array(items))]).stringify(),
  )
}

///|
/// POST /articles/:slug/comments
pub async fn handle_create_comment(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let slug = match req.param("slug") {
    Some(s) => s
    None => return not_found("article")
  }
  let body_obj = unwrap_obj(req.text(), "comment")
  let text = get_str(body_obj, "body").unwrap_or("")
  if text == "" {
    return unprocessable("body", "can't be blank")
  }
  let exists = a.query("SELECT id FROM articles WHERE slug = $1", [Some(slug)])
  if exists.rows.length() == 0 {
    return not_found("article")
  }
  let ins = a.query(
    "INSERT INTO comments (article_id, author_id, body) SELECT id, $2::int, $3 FROM articles WHERE slug = $1 RETURNING id, " +
    "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at, " +
    "to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at, body",
    [Some(slug), Some(me.to_string()), Some(text)],
  )
  if ins.rows.length() == 0 {
    return not_found("article")
  }
  // 取作者信息（含 following 状态）
  let rows = a.query(COMMENT_COLS + " AND c.id = $3::int", [
    Some(me.to_string()),
    Some(slug),
    Some(ins.int(0, 0).unwrap_or(0L).to_string()),
  ])
  if rows.rows.length() == 0 {
    return err_resp(500, "could not create comment")
  }
  @http.Response::json(
    201,
    jobj([("comment", comment_from_row(rows, 0))]).stringify(),
  )
}

///|
/// DELETE /articles/:slug/comments/:id
pub async fn handle_delete_comment(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let slug = match req.param("slug") {
    Some(s) => s
    None => return not_found("article")
  }
  let id_str = match req.param("id") {
    Some(s) => s
    None => return not_found("comment")
  }
  let comment_id = match parse_nonneg_int(id_str) {
    Some(n) => n
    None => return not_found("comment")
  }
  // 先确认文章存在。
  // 规范要求「文章不存在」报 `article: not found`、「评论不存在」报 `comment: not found` ——
  // 二者语义不同，客户端需要能区分，不能笼统地都报 comment。
  let art = a.query("SELECT 1 FROM articles WHERE slug = $1", [Some(slug)])
  if art.rows.length() == 0 {
    return not_found("article")
  }
  let rows = a.query(
    "SELECT author_id FROM comments WHERE id = $1::int AND article_id = (SELECT id FROM articles WHERE slug = $2)",
    [Some(comment_id.to_string()), Some(slug)],
  )
  if rows.rows.length() == 0 {
    return not_found("comment")
  }
  let author_id = rows.int(0, 0).unwrap_or(0L).to_int()
  if author_id != me {
    return forbidden("comment")
  }
  let _ = a.query("DELETE FROM comments WHERE id = $1::int", [
    Some(comment_id.to_string()),
  ])
  no_content()
}
