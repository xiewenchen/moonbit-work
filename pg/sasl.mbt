///|
/// PostgreSQL 认证相关的纯算法：SCRAM-SHA-256（RFC 7677）与 MD5 密码响应。
/// 全部是纯计算，可跨后端（含 wasm-gc）测试。

///|
fn hmac_sha256(key : Bytes, msg : Bytes) -> Bytes {
  Bytes::from_array(@crypto.hmac(@crypto.SHA256::new(), key, msg))
}

///|
fn sha256(b : Bytes) -> Bytes {
  Bytes::from_array(@crypto.sha256(b))
}

///|
fn xor_bytes(a : Bytes, b : Bytes) -> Bytes {
  // 长度不等时按较短者处理，避免越界 panic（正常调用应等长）；
  // 读取一律走 safe_byte 兜底。
  let n = if a.length() < b.length() { a.length() } else { b.length() }
  let out = Buffer()
  for i = 0; i < n; i = i + 1 {
    out.write_byte(
      (safe_byte(a, i, 0).to_int() ^ safe_byte(b, i, 0).to_int()).to_byte(),
    )
  }
  out.to_bytes()
}

///|
/// PBKDF2-HMAC-SHA256，输出 32 字节（单块足够）。

///|
/// SCRAM 迭代数上限：`iterations` 来自**服务端**的 `server-first-message`，
/// 恶意服务器可喂一个巨大值让 `pbkdf2` 循环数十亿次 → **客户端 CPU 挂死（DoS）**。
/// 真实 PG 默认 4096，这里留 ~12 倍余量。
const MAX_SCRAM_ITERATIONS : Int = 50000

///|
fn pbkdf2_sha256(password : Bytes, salt : Bytes, iterations : Int) -> Bytes {
  // 夹到 [1, MAX]：过小的值无意义，过大的值是 DoS
  let iters = if iterations > MAX_SCRAM_ITERATIONS {
    MAX_SCRAM_ITERATIONS
  } else if iterations < 1 {
    1
  } else {
    iterations
  }
  let salt_block = Buffer()
  salt_block.write_bytes(salt)
  salt_block.write_byte((0).to_byte())
  salt_block.write_byte((0).to_byte())
  salt_block.write_byte((0).to_byte())
  salt_block.write_byte((1).to_byte()) // INT(1) 大端
  let mut u = hmac_sha256(password, salt_block.to_bytes())
  let mut acc = u
  for i = 2; i <= iters; i = i + 1 {
    u = hmac_sha256(password, u)
    acc = xor_bytes(acc, u)
  }
  acc
}

///|
/// 由密码、盐、迭代数与 auth message 算出 `(client_proof_b64, server_signature_b64)`。
pub fn scram_proof(
  password : String,
  salt_b64 : String,
  iterations : Int,
  auth_message : String,
) -> (String, String) raise {
  let salt = @base64.decode(salt_b64)
  let salted = pbkdf2_sha256(@utf8.encode(password), salt, iterations)
  let client_key = hmac_sha256(salted, @utf8.encode("Client Key"))
  let stored_key = sha256(client_key)
  let client_sig = hmac_sha256(stored_key, @utf8.encode(auth_message))
  let client_proof = xor_bytes(client_key, client_sig)
  let server_key = hmac_sha256(salted, @utf8.encode("Server Key"))
  let server_sig = hmac_sha256(server_key, @utf8.encode(auth_message))
  (@base64.encode(client_proof), @base64.encode(server_sig))
}

///|
/// SCRAM client-first-message 及其 bare 形式。
pub fn scram_client_first(user : String, nonce : String) -> (String, String) {
  let bare = "n=\{user},r=\{nonce}"
  ("n,," + bare, bare)
}

///|
/// SCRAM client-final-message（含 proof）。
pub fn scram_client_final(
  password : String,
  client_first_bare : String,
  server_first : String,
  combined_nonce : String,
  salt_b64 : String,
  iterations : Int,
) -> String raise {
  // channel binding "n,," 的 base64 固定为 "biws"
  let without_proof = "c=biws,r=\{combined_nonce}"
  let auth_message = "\{client_first_bare},\{server_first},\{without_proof}"
  let (proof, _server_sig) = scram_proof(
    password, salt_b64, iterations, auth_message,
  )
  "\{without_proof},p=\{proof}"
}

///|
/// PostgreSQL MD5 密码响应：
/// `"md5" + hex(md5( hex(md5(password ++ user)) ++ salt ))`。
pub fn md5_password(password : String, user : String, salt : Bytes) -> String {
  let inner_hex = @crypto.bytes_to_hex_string(
    @crypto.md5(@utf8.encode(password + user)),
  )
  let outer = Buffer()
  outer.write_string_utf8(inner_hex)
  outer.write_bytes(salt)
  let outer_hex = @crypto.bytes_to_hex_string(@crypto.md5(outer.to_bytes()))
  "md5" + outer_hex
}

///|
fn parse_decimal_str(s : StringView) -> Int {
  let mut acc = 0
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some(c) =>
        if c >= '0' && c <= '9' {
          // 饱和到最大安全值，避免 32 位溢出后绕回异常值
          if acc > 214748363 {
            return 2147483647
          }
          acc = acc * 10 + (c.to_int() - '0'.to_int())
        }
      None => ()
    }
  }
  acc
}

///|
/// 解析 SCRAM `server-first-message`，返回 `(combined_nonce, salt_b64, iterations)`。
pub fn parse_server_first(msg : String) -> (String, String, Int) {
  let mut nonce = ""
  let mut salt = ""
  let mut iters = 0
  for part in msg.split(",") {
    match part.to_owned().split_once("=") {
      Some((k, v)) =>
        if k == "r" {
          nonce = v.to_owned()
        } else if k == "s" {
          salt = v.to_owned()
        } else if k == "i" {
          iters = parse_decimal_str(v)
        }
      None => ()
    }
  }
  (nonce, salt, iters)
}
