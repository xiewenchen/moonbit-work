///|
/// 鉴权：密码哈希（bcrypt）与 JWT（HS256）签发/校验，以及一个 `App` 中间件。

///|
/// 生成随机 salt（bcrypt 用）。
fn random_bytes(n : Int) -> Bytes {
  let rnd = @random.Rand::new()
  let buf = Buffer()
  for i = 0; i < n; i = i + 1 {
    buf.write_byte(rnd.int(limit=256).to_byte())
  }
  buf.to_bytes()
}

///|
/// 用 bcrypt 哈希密码（默认 cost=10）。
pub fn hash_password(password : String, cost? : Int = 10) -> String raise {
  @bcrypt.hash(
    password=@utf8.encode(password),
    salt=random_bytes(@bcrypt.salt_length),
    cost~,
  )
}

///|
/// 校验密码与 bcrypt 哈希是否匹配。
pub fn verify_password(password : String, hashed : String) -> Bool raise {
  @bcrypt.verify(password=@utf8.encode(password), hashed~)
}

///|
/// base64url（无填充）编码。
fn b64url_encode(data : Bytes) -> String {
  let s = @base64.encode(data, url_safe=true)
  let mut end = s.length()
  while end > 0 && s.get_char(end - 1) == Some('=') {
    end = end - 1
  }
  s[:end].to_owned()
}

///|
/// base64url 解码（容忍无填充）。
fn b64url_decode(s : String) -> Bytes raise {
  let pad = (4 - s.length() % 4) % 4
  let buf = Buffer()
  buf.write_string_utf8(s)
  for i = 0; i < pad; i = i + 1 {
    buf.write_string_utf8("=")
  }
  @base64.decode(@utf8.decode_lossy(buf.to_bytes()), url_safe=true)
}

///|
fn hmac_sha256(key : Bytes, msg : Bytes) -> Bytes {
  Bytes::from_array(@crypto.hmac(@crypto.SHA256::new(), key, msg))
}

///|
/// 恒定时间字符串比较（比较完所有字符再判定），用于签名校验，
/// 避免通过响应时间差逐字节推断出正确签名（计时攻击）。
fn ct_eq(a : String, b : String) -> Bool {
  if a.length() != b.length() {
    return false
  }
  let mut diff = 0
  for i = 0; i < a.length(); i = i + 1 {
    let xa = match a.get_char(i) {
      Some(c) => c.to_int()
      None => 0
    }
    let xb = match b.get_char(i) {
      Some(c) => c.to_int()
      None => 0
    }
    diff = diff | (xa ^ xb)
  }
  diff == 0
}

///|
/// 转义 JSON 字符串内容。
///
/// **安全要点**：`sign_jwt` 的 claim 常来自用户（如用户名）。若不转义，
/// 含 `"` 或 `\` 的值会**破坏 JSON 结构 → 注入伪造 claim**（如提升 role）。
fn json_escape_str(s : String) -> String {
  let buf = Buffer()
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some(c) =>
        if c == '"' {
          buf.write_string_utf8("\\\"")
        } else if c == '\\' {
          buf.write_string_utf8("\\\\")
        } else if c == '\n' {
          buf.write_string_utf8("\\n")
        } else if c == '\r' {
          buf.write_string_utf8("\\r")
        } else if c == '\t' {
          buf.write_string_utf8("\\t")
        } else if c.to_int() < 32 || c.to_int() == 127 {
          // 丢弃其它控制字符
        } else {
          buf.write_string_utf8(c.to_string())
        }
      None => ()
    }
  }
  @utf8.decode_lossy(buf.to_bytes())
}

///|
/// 签发一个 HS256 JWT（payload 为字符串键值对）。
///
/// claim 的键值都会做 JSON 转义，避免用户输入注入伪造 claim。
pub fn sign_jwt(claims : Map[String, String], secret : String) -> String {
  let header = b64url_encode(
    @utf8.encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}"),
  )
  let body = Buffer()
  body.write_string_utf8("{")
  let mut first = true
  for entry in claims.iter() {
    let (k, v) = entry
    if !first {
      body.write_string_utf8(",")
    }
    first = false
    body.write_string_utf8(
      "\"\{json_escape_str(k)}\":\"\{json_escape_str(v)}\"",
    )
  }
  body.write_string_utf8("}")
  let payload = b64url_encode(body.to_bytes())
  let signing_input = header + "." + payload
  let sig = b64url_encode(
    hmac_sha256(@utf8.encode(secret), @utf8.encode(signing_input)),
  )
  signing_input + "." + sig
}

///|
/// 校验 HS256 JWT 的签名（并解出 claims）；非法返回 `None`。
pub fn verify_jwt(token : String, secret : String) -> Map[String, String]? {
  match token.split(".").to_array() {
    [h, p, sig] => {
      let signing_input = h.to_owned() + "." + p.to_owned()
      let expected = b64url_encode(
        hmac_sha256(@utf8.encode(secret), @utf8.encode(signing_input)),
      )
      // 恒定时间比较：避免通过响应时间差逐字节推断签名（计时攻击）
      if !ct_eq(expected, sig.to_owned()) {
        return None
      }
      // 解析 payload（这里只做最简单的 "k":"v" 提取）
      let claims = decode_claims(p.to_owned())
      match claims {
        None => None
        Some(m) =>
          // 过期校验：若含 `exp`（Unix 秒）且已过期 → 拒绝
          match m.get("exp") {
            None => Some(m)
            Some(exp_str) =>
              match parse_u64(exp_str) {
                Some(exp) =>
                  if @env.now() / 1000UL > exp {
                    None
                  } else {
                    Some(m)
                  }
                None => None
              }
          }
      }
    }
    _ => None
  }
}

///|
/// 解析无符号十进制整数（用于 `exp`）；非法返回 `None`。
fn parse_u64(s : String) -> UInt64? {
  if s == "" {
    return None
  }
  let mut acc : UInt64 = 0UL
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some(c) =>
        if c >= '0' && c <= '9' {
          acc = acc * 10UL + (c.to_int() - '0'.to_int()).to_uint64()
        } else {
          return None
        }
      None => return None
    }
  }
  Some(acc)
}

///|
/// 签发一个带过期时间的 HS256 JWT：自动加入 `exp`（当前时间 + `ttl_sec` 秒）。
pub fn sign_jwt_expiring(
  claims : Map[String, String],
  secret : String,
  ttl_sec : UInt64,
) -> String {
  let with_exp : Map[String, String] = Map([])
  for entry in claims.iter() {
    let (k, v) = entry
    with_exp.set(k, v)
  }
  with_exp.set("exp", (@env.now() / 1000UL + ttl_sec).to_string())
  sign_jwt(with_exp, secret)
}

///|
/// 从 base64url payload 里解出字符串键值对。
fn decode_claims(payload_b64 : String) -> Map[String, String]? {
  let raw : Bytes = try b64url_decode(payload_b64) catch {
    _ => return None
  } noraise {
    v => v
  }
  let text = @utf8.decode_lossy(raw)
  let out : Map[String, String] = Map([])
  // 去掉首尾 {}，按 , 切
  let inner = match text.split_once("{") {
    Some((_, rest)) => rest
    None => return None
  }
  let body = match inner.rev_find("}") {
    Some(i) => inner[:i].to_owned()
    None => return None
  }
  for pair in body.split(",") {
    match pair.to_owned().split_once(":") {
      Some((k, v)) => {
        let key = strip_quotes(k.to_owned())
        let value = strip_quotes(v.to_owned())
        out.set(key, value)
      }
      None => ()
    }
  }
  Some(out)
}

///|
fn strip_quotes(s : String) -> String {
  let t = s.trim().to_owned()
  if t.length() >= 2 && t.get_char(0) == Some('"') {
    t[1:t.length() - 1].to_owned()
  } else {
    t
  }
}

///|
/// 取出 `Authorization: Bearer <token>` 里的 token。
fn bearer_token(req : @http.Request) -> String? {
  match req.header("authorization") {
    Some(v) =>
      if v.length() > 7 && v[:7] == "Bearer " {
        Some(v[7:].to_owned())
      } else {
        None
      }
    None => None
  }
}

///|
/// 启用 JWT 鉴权中间件：除放行路径外，要求带合法 `Bearer` token，
/// 否则返回 401。
pub fn App::use_auth(self : App, secret : String) -> Unit {
  let s = secret
  self.use_middleware(async fn(req, next) {
    let path = req.target
    if path == "/health" || path == "/ready" || path == "/metrics" {
      return next()
    }
    match bearer_token(req) {
      None => @http.Response::text(401, "missing bearer token")
      Some(t) =>
        match verify_jwt(t, s) {
          Some(_) => next()
          None => @http.Response::text(401, "invalid or expired token")
        }
    }
  })
}
