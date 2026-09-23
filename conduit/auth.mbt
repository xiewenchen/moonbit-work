///|
/// bcrypt 成本因子的安全下限。低于 4 强度太弱。
///
/// ## 关于成本与阻塞
///
/// 纯 MoonBit 的 bcrypt 比原生实现慢约 10 倍。实测（本机）：
///
/// | cost | 单次哈希 |
/// |------|---------|
/// | 4 | ~20 ms |
/// | 6 | ~37 ms |
/// | 8 | ~250 ms |
///
/// 且平台的 async 是**单线程协作式**，哈希期间整个事件循环被占用。
/// 实测 20 并发登录风暴下，`/health` 的 p95 从 14 ms 抬到 53 ms、max 到 121 ms
/// （拖慢 5 倍，但未超时）。
///
/// 因此成本做成**可配置**（`MBP_BCRYPT_COST`），由部署方按 CPU 能力与安全要求权衡：
/// 生产建议改用原生 bcrypt/argon2 后再提到 10+。
const BCRYPT_COST_MIN : Int = 4

///|
/// 上限：再高单次哈希会到秒级，实际不可用。
const BCRYPT_COST_MAX : Int = 14

///|
/// 把配置里的成本因子夹到安全区间内（防止误配成 0 或 31）。
pub fn clamp_bcrypt_cost(cost : Int) -> Int {
  if cost < BCRYPT_COST_MIN {
    BCRYPT_COST_MIN
  } else if cost > BCRYPT_COST_MAX {
    BCRYPT_COST_MAX
  } else {
    cost
  }
}

///|
/// Conduit 鉴权：JWT 签发/校验、可选鉴权、统一错误响应。
///
/// ## 与平台 `use_auth` 的差异
///
/// 平台自带的 `@app.App::use_auth` 只认 `Bearer ` 前缀、且**没有可选鉴权**
/// （无 token 一律 401）。Conduit 用 `Authorization: Token <jwt>`，
/// 且 `/articles`、`GET /articles/:slug`、`GET /profiles/:username` 是
/// **鉴权可选**（带 token 时返回 `favorited`/`following`，不带也能访问）。

///|
/// 当前服务的 JWT 密钥与有效期（由 `use_conduit` 注入）。
pub(all) struct AuthConfig {
  secret : String
  ttl_sec : UInt64
  /// bcrypt 成本因子。见 `BCRYPT_COST_MIN/MAX` 说明。
  bcrypt_cost : Int
}

///|
/// 从 `Authorization` 头取 token。
///
/// 同时接受 Conduit 的 `Token ` 前缀与通用的 `Bearer ` 前缀（大小写不敏感地匹配前缀名）。
pub fn token_of(req : @http.Request) -> String? {
  match req.header("authorization") {
    Some(v) => {
      let n = v.length()
      if n > 6 && v[:6].to_lower() == "token " {
        Some(v[6:].to_owned())
      } else if n > 7 && v[:7].to_lower() == "bearer " {
        Some(v[7:].to_owned())
      } else {
        None
      }
    }
    None => None
  }
}

///|
/// 校验 token 并取出用户 id（`sub` claim）。
///
/// **可选鉴权语义**：token 缺失、非法、过期都返回 `None`（匿名），不报错。
pub fn user_id_of(auth : AuthConfig, req : @http.Request) -> Int? {
  match token_of(req) {
    Some(t) =>
      match @app.verify_jwt(t, auth.secret) {
        Some(claims) =>
          match claims.get("sub") {
            Some(sub) => parse_nonneg_int(sub)
            None => None
          }
        None => None
      }
    None => None
  }
}

///|
/// 需要登录的端点用这个：取不到用户就返回 401。
pub fn require_user_id(
  auth : AuthConfig,
  req : @http.Request,
) -> Result[Int, @http.Response] {
  match user_id_of(auth, req) {
    Some(id) => Ok(id)
    None => Err(unauthorized())
  }
}

///|
/// 签发 token（`sub` = 用户 id，`username` 一并带上便于调试）。
pub fn issue_token(
  auth : AuthConfig,
  user_id : Int,
  username : String,
) -> String {
  let claims : Map[String, String] = Map([])
  claims.set("sub", user_id.to_string())
  claims.set("username", username)
  @app.sign_jwt_expiring(claims, auth.secret, auth.ttl_sec)
}

// ---------------------------------------------------------------------------
// 统一错误响应
// ---------------------------------------------------------------------------

///|
/// `{"errors":{"<field>":["<msg>"]}}`
pub fn errors_body(message : String) -> String {
  jobj([("errors", jobj([("body", jarr([jstr(message)]))]))]).stringify()
}

///|
/// 通用错误响应（错误键用 `body`）。
pub fn err_resp(status : Int, message : String) -> @http.Response {
  @http.Response::json(status, errors_body(message))
}

///|
/// 指定字段名的错误响应：`{"errors":{"<field>":["<msg>"]}}`
pub fn field_err_resp(
  status : Int,
  field : String,
  message : String,
) -> @http.Response {
  @http.Response::json(
    status,
    jobj([("errors", jobj([(field, jarr([jstr(message)]))]))]).stringify(),
  )
}

///|
/// 401（token 缺失）。
///
/// 官方规范要求消息**精确**为 `is missing` —— 带多余措辞会让 hurl 断言失败。
pub fn unauthorized() -> @http.Response {
  field_err_resp(401, "token", "is missing")
}

///|
/// 403（不是资源所有者）。
///
/// 字段名随资源类型变化：文章用 `article`、评论用 `comment`（官方规范如此）。
pub fn forbidden(resource : String) -> @http.Response {
  field_err_resp(403, resource, "forbidden")
}

///|
/// 404（资源不存在）。
pub fn not_found(what : String) -> @http.Response {
  field_err_resp(404, what, "not found")
}

///|
/// 登录凭据错误。
///
/// 官方规范用 `credentials: ["invalid"]` 这个字段名。
pub fn bad_credentials() -> @http.Response {
  field_err_resp(401, "credentials", "invalid")
}

///|
/// 422（校验失败）。
pub fn unprocessable(field : String, message : String) -> @http.Response {
  field_err_resp(422, field, message)
}

///|
/// 204 空响应。
pub fn no_content() -> @http.Response {
  @http.Response::new(204, @utf8.encode(""))
}
