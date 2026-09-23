///|
/// Conduit Profile 与关注端点。
///
///   GET    /profiles/:username         → 200 {profile} / 404（鉴权可选）
///   POST   /profiles/:username/follow  → 200 {profile} / 401 / 404
///   DELETE /profiles/:username/follow  → 200 {profile} / 401 / 404

///|
/// Conduit 的 `profile` 对象。
pub fn profile_json(
  username : String,
  bio : String?,
  image : String?,
  following : Bool,
) -> Json {
  jobj([
    ("username", jstr(username)),
    ("bio", jopt(bio)),
    ("image", jopt(image)),
    ("following", jbool(following)),
  ])
}

///|
/// 单 profile 响应体：`{"profile":{...}}`
pub fn profile_envelope(
  username : String,
  bio : String?,
  image : String?,
  following : Bool,
) -> String {
  jobj([("profile", profile_json(username, bio, image, following))]).stringify()
}

///|
/// 从一行「user 左连 follows」的结果里取 profile JSON。
///
/// 约定列顺序：0=username, 1=bio, 2=image, 3=following
fn profile_from_row(rows : @pgclient.QueryResult, row : Int) -> Json {
  profile_json(
    rows.text(row, 0).unwrap_or(""),
    rows.text(row, 1),
    rows.text(row, 2),
    rows.bool(row, 3).unwrap_or(false),
  )
}

///|
/// 查询某 username 的 profile（`viewer_id` 为 `None` 表示匿名）。
///
/// 用 `NULLIF($2,'')::int` 让「匿名」与「已登录」走同一条 SQL：
/// 匿名时 `$2` 传空串，EXISTS 子句短路为 false。
const PROFILE_SQL : String = "SELECT u.username, u.bio, u.image, CASE WHEN $2 = '' THEN false ELSE EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = NULLIF($2, '')::int AND f.following_id = u.id) END AS following FROM users u WHERE u.username = $1"

///|
/// GET /profiles/:username
pub async fn handle_get_profile(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let username = match req.param("username") {
    Some(u) => u
    None => return not_found("profile")
  }
  let viewer = match user_id_of(auth, req) {
    Some(id) => id.to_string()
    None => ""
  }
  let rows = a.query(PROFILE_SQL, [Some(username), Some(viewer)])
  if rows.rows.length() == 0 {
    return not_found("profile")
  }
  let profile = profile_from_row(rows, 0)
  @http.Response::json(200, jobj([("profile", profile)]).stringify())
}

///|
/// POST /profiles/:username/follow
pub async fn handle_follow(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let username = match req.param("username") {
    Some(u) => u
    None => return not_found("profile")
  }
  // 目标用户存在？
  let target = a.query(
    "SELECT username, bio, image FROM users WHERE username = $1",
    [Some(username)],
  )
  if target.rows.length() == 0 {
    return not_found("profile")
  }
  // 幂等关注
  let _ = a.query(
    "INSERT INTO follows (follower_id, following_id) SELECT $1::int, id FROM users WHERE username = $2 ON CONFLICT DO NOTHING",
    [Some(me.to_string()), Some(username)],
  )
  let rows = a.query(PROFILE_SQL, [Some(username), Some(me.to_string())])
  @http.Response::json(
    200,
    jobj([("profile", profile_from_row(rows, 0))]).stringify(),
  )
}

///|
/// DELETE /profiles/:username/follow
pub async fn handle_unfollow(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let username = match req.param("username") {
    Some(u) => u
    None => return not_found("profile")
  }
  let target = a.query(
    "SELECT username, bio, image FROM users WHERE username = $1",
    [Some(username)],
  )
  if target.rows.length() == 0 {
    return not_found("profile")
  }
  let _ = a.query(
    "DELETE FROM follows WHERE follower_id = $1::int AND following_id = (SELECT id FROM users WHERE username = $2)",
    [Some(me.to_string()), Some(username)],
  )
  let rows = a.query(PROFILE_SQL, [Some(username), Some(me.to_string())])
  @http.Response::json(
    200,
    jobj([("profile", profile_from_row(rows, 0))]).stringify(),
  )
}
