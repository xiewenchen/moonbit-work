///|
/// PostgreSQL 认证算法测试（SCRAM-SHA-256 / MD5），纯逻辑。

///|
/// RFC 7677 的官方测试向量。
const RFC_USER : String = "user"

///|
const RFC_PASSWORD : String = "pencil"

///|
const RFC_CLIENT_NONCE : String = "rOprNGfwEbeRWgbNEkqO"

///|
const RFC_SERVER_FIRST : String = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"

///|
const RFC_COMBINED_NONCE : String = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0"

///|
test "scram client first message" {
  let (full, bare) = @pg.scram_client_first(RFC_USER, RFC_CLIENT_NONCE)
  assert_eq(bare, "n=user,r=rOprNGfwEbeRWgbNEkqO")
  assert_eq(full, "n,,n=user,r=rOprNGfwEbeRWgbNEkqO")
}

///|
test "scram client final matches RFC 7677 vector" {
  let (_, bare) = @pg.scram_client_first(RFC_USER, RFC_CLIENT_NONCE)
  let client_final = @pg.scram_client_final(
    RFC_PASSWORD,
    bare,
    RFC_SERVER_FIRST,
    RFC_COMBINED_NONCE,
    "W22ZaJ0SNY7soEsUEjb6gQ==",
    4096,
  )
  assert_eq(
    client_final, "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
  )
}

///|
test "scram server signature matches RFC 7677 vector" {
  let (_, bare) = @pg.scram_client_first(RFC_USER, RFC_CLIENT_NONCE)
  let without_proof = "c=biws,r=\{RFC_COMBINED_NONCE}"
  let auth_message = "\{bare},\{RFC_SERVER_FIRST},\{without_proof}"
  let (_proof, server_sig) = @pg.scram_proof(
    RFC_PASSWORD,
    "W22ZaJ0SNY7soEsUEjb6gQ==",
    4096,
    auth_message,
  )
  assert_eq(server_sig, "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")
}

///|
test "md5 password response has md5 prefix and 35 chars" {
  let salt = Bytes::from_array([
    (1).to_byte(),
    (2).to_byte(),
    (3).to_byte(),
    (4).to_byte(),
  ])
  let out = @pg.md5_password("secret", "mbp", salt)
  assert_eq(out.length(), 35) // "md5" + 32 hex
  assert_eq(out.has_prefix("md5"), true)
}
