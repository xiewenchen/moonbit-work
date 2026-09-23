///|
/// Conduit 用户与鉴权端点。
///
///   POST /users        注册       → 201 {user} / 409 / 422
///   POST /users/login  登录       → 200 {user} / 401 / 422
///   GET  /user         当前用户   → 200 {user} / 401
///   PUT  /user         更新用户   → 200 {user} / 401 / 422

///|
/// Conduit 的 `user` 对象。
pub fn user_json(
  email : String,
  token : String,
  username : String,
  bio : String?,
  image : String?,
) -> Json {
  jobj([
    ("email", jstr(email)),
    ("token", jstr(token)),
    ("username", jstr(username)),
    ("bio", jopt(bio)),
    ("image", jopt(image)),
  ])
}

///|
/// 单用户响应体：`{"user":{...}}`
pub fn user_envelope(
  email : String,
  token : String,
  username : String,
  bio : String?,
  image : String?,
) -> String {
  jobj([("user", user_json(email, token, username, bio, image))]).stringify()
}

///|
/// 基础的 email 格式校验（有且只有一个 `@`，两侧非空，域名含 `.`）。
pub fn valid_email(s : String) -> Bool {
  if s.length() < 5 || s.length() > 254 {
    return false
  }
  let mut at = -1
  let mut at_count = 0
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some('@') => {
        at = i
        at_count = at_count + 1
      }
      Some(' ') => return false
      Some(c) => if c.to_int() < 33 || c.to_int() > 126 { return false }
      None => ()
    }
  }
  if at_count != 1 || at <= 0 || at >= s.length() - 1 {
    return false
  }
  let domain = s[at + 1:].to_owned()
  domain.contains(".") &&
  !domain.has_prefix(".") &&
  !domain.has_suffix(".") &&
  !domain.contains("..")
}

///|
/// username 校验：1..64 字符，字母/数字/下划线/连字符。
pub fn valid_username(s : String) -> Bool {
  if s.length() == 0 || s.length() > 64 {
    return false
  }
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some(c) =>
        if !((c >= 'a' && c <= 'z') ||
          (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') ||
          c == '_' ||
          c == '-') {
          return false
        }
      None => return false
    }
  }
  true
}

///|
/// 从查询结果第 0 行取用户字段，拼成 `user` 响应（需要 token 由调用方签发）。
fn user_row_json(rows : @pgclient.QueryResult, token : String) -> String {
  let email = rows.text(0, 1).unwrap_or("")
  let username = rows.text(0, 2).unwrap_or("")
  let bio = rows.text(0, 3)
  let image = rows.text(0, 4)
  user_envelope(email, token, username, bio, image)
}

///|
/// 注册（POST /users）。
pub async fn handle_register(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let body = unwrap_obj(req.text(), "user")
  let username = get_str(body, "username").unwrap_or("")
  let email = get_str(body, "email").unwrap_or("")
  let password = get_str(body, "password").unwrap_or("")
  if username == "" {
    return unprocessable("username", "can't be blank")
  }
  if !valid_username(username) {
    return unprocessable("username", "is invalid")
  }
  if email == "" {
    return unprocessable("email", "can't be blank")
  }
  if !valid_email(email) {
    return unprocessable("email", "is invalid")
  }
  if password == "" {
    return unprocessable("password", "can't be blank")
  }
  if password.length() < 8 {
    return unprocessable("password", "is too short (minimum is 8 characters)")
  }
  let hash = @app.hash_password(password, cost=auth.bcrypt_cost)
  // ON CONFLICT DO NOTHING 保证并发下也不会重复插入
  let ins = a.query(
    "INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id, email, username, bio, image",
    [Some(email), Some(username), Some(hash)],
  )
  if ins.rows.length() == 0 {
    // 冲突：判断是哪个字段
    let dup = a.query(
      "SELECT (SELECT 1 FROM users WHERE email = $1) AS e, (SELECT 1 FROM users WHERE username = $2) AS u",
      [Some(email), Some(username)],
    )
    let email_taken = dup.rows.length() > 0 && dup.text(0, 0) is Some(_)
    if email_taken {
      return field_err_resp(409, "email", "has already been taken")
    }
    return field_err_resp(409, "username", "has already been taken")
  }
  let id = ins.int(0, 0).unwrap_or(0L)
  let token = issue_token(auth, id.to_int(), username)
  @http.Response::json(201, user_row_json(ins, token))
}

///|
/// 登录（POST /users/login）。
pub async fn handle_login(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let body = unwrap_obj(req.text(), "user")
  let email = get_str(body, "email").unwrap_or("")
  let password = get_str(body, "password").unwrap_or("")
  if email == "" {
    return unprocessable("email", "can't be blank")
  }
  if password == "" {
    return unprocessable("password", "can't be blank")
  }
  let rows = a.query(
    "SELECT id, email, username, bio, image, password_hash FROM users WHERE email = $1",
    [Some(email)],
  )
  if rows.rows.length() == 0 {
    return bad_credentials()
  }
  let hash = rows.text(0, 5).unwrap_or("")
  if !@app.verify_password(password, hash) {
    return bad_credentials()
  }
  let id = rows.int(0, 0).unwrap_or(0L).to_int()
  let username = rows.text(0, 2).unwrap_or("")
  let token = issue_token(auth, id, username)
  @http.Response::json(
    200,
    user_envelope(
      rows.text(0, 1).unwrap_or(""),
      token,
      username,
      rows.text(0, 3),
      rows.text(0, 4),
    ),
  )
}

///|
/// 当前用户（GET /user）。
pub async fn handle_current_user(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let id = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let rows = a.query(
    "SELECT id, email, username, bio, image FROM users WHERE id = $1",
    [Some(id.to_string())],
  )
  if rows.rows.length() == 0 {
    return unauthorized()
  }
  // 重新签发（刷新有效期）
  let username = rows.text(0, 2).unwrap_or("")
  let token = issue_token(auth, id, username)
  @http.Response::json(200, user_row_json(rows, token))
}

///|
/// 更新当前用户（PUT /user）。支持部分更新。
pub async fn handle_update_user(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let id = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let body = unwrap_obj(req.text(), "user")
  // 注意：必须用 `get_opt_str` 区分「字段未提供」与「显式传 null」。
  // 必填字段（email / username / password）显式传 null 要 422 ——
  // 早先用 `get_str` 把 null 当成「未提供」静默忽略了，官方测试正好覆盖这一点。
  let email_field = get_opt_str(body, "email")
  let username_field = get_opt_str(body, "username")
  let password_field = get_opt_str(body, "password")
  match username_field {
    Some(Some(u)) =>
      if !valid_username(u) {
        return unprocessable("username", "is invalid")
      }
    Some(None) => return unprocessable("username", "can't be null")
    None => ()
  }
  match email_field {
    Some(Some(e)) =>
      if !valid_email(e) {
        return unprocessable("email", "is invalid")
      }
    Some(None) => return unprocessable("email", "can't be null")
    None => ()
  }
  match password_field {
    Some(Some(p)) =>
      if p.length() < 8 {
        return unprocessable("password", "is too short (minimum is 8 characters)")
      }
    Some(None) => return unprocessable("password", "can't be null")
    None => ()
  }
  // bio / image 本身可空，显式 null 是合法输入（表示清空）
  let new_bio = get_opt_str(body, "bio")
  let new_image = get_opt_str(body, "image")
  // 组装 SQL 参数：只有「有值」才写，null 或未提供都不改
  let new_email : String? = match email_field {
    Some(Some(e)) => Some(e)
    _ => None
  }
  let new_username : String? = match username_field {
    Some(Some(u)) => Some(u)
    _ => None
  }
  let new_password : String? = match password_field {
    Some(Some(p)) => Some(p)
    _ => None
  }
  // 逐字段更新（NULL 表示不改）；新字段若有冲突则 0 行受影响
  let hash = match new_password {
    Some(p) => Some(@app.hash_password(p, cost=auth.bcrypt_cost))
    None => None
  }
  let bio_set = match new_bio {
    Some(v) => v
    None => None
  }
  let image_set = match new_image {
    Some(v) => v
    None => None
  }
  let upd = a.query(
    "UPDATE users SET " +
    "email = COALESCE($2, email), " +
    "username = COALESCE($3, username), " +
    "password_hash = COALESCE($4, password_hash), " +
    "bio = CASE WHEN $5::bool THEN NULLIF($6, '') ELSE bio END, " +
    "image = CASE WHEN $7::bool THEN NULLIF($8, '') ELSE image END, " +
    "updated_at = now() " +
    "WHERE id = $1 " +
    "RETURNING id, email, username, bio, image",
    [
      Some(id.to_string()),
      new_email,
      new_username,
      hash,
      // 是否显式提供了 bio/image
      Some(if new_bio is Some(_) { "true" } else { "false" }),
      bio_set,
      Some(if new_image is Some(_) { "true" } else { "false" }),
      image_set,
    ],
  )
  if upd.rows.length() == 0 {
    // 要么用户不存在，要么 email/username 撞了唯一约束
    let dup = a.query(
      "SELECT (SELECT 1 FROM users WHERE email = COALESCE($1, '')) AS e, (SELECT 1 FROM users WHERE username = COALESCE($2, '')) AS u",
      [new_email, new_username],
    )
    if dup.rows.length() > 0 &&
      dup.text(0, 0) is Some(_) &&
      new_email is Some(_) {
      return field_err_resp(409, "email", "has already been taken")
    }
    if dup.rows.length() > 0 &&
      dup.text(0, 1) is Some(_) &&
      new_username is Some(_) {
      return field_err_resp(409, "username", "has already been taken")
    }
    return unauthorized()
  }
  let username = upd.text(0, 2).unwrap_or("")
  let token = issue_token(auth, id, username)
  @http.Response::json(200, user_row_json(upd, token))
}
