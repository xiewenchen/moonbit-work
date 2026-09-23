///|
/// 模糊测试：PostgreSQL SCRAM / MD5 认证**不得 panic**。
///
/// `parse_server_first` 与 `md5_password` 都直接处理**服务端/外部来源**的数据，
/// 是最该 fuzz 的入口。

///|
fn sasl_random_string(rnd : @random.Rand, n : Int) -> String {
  let buf = Buffer()
  for i = 0; i < n; i = i + 1 {
    // 覆盖 ASCII 可打印 + 少量特殊字符
    let c = rnd.int(limit=128)
    buf.write_byte(c.to_byte())
  }
  @utf8.decode_lossy(buf.to_bytes())
}

///|
fn sasl_swallow(f : () -> Unit raise) -> Unit {
  try f() catch {
    _ => ()
  } noraise {
    _ => ()
  }
}

///|
test "fuzz: parse_server_first 任意字符串不 panic" {
  let rnd = @random.Rand::new()
  // 结构性样本 + 随机
  let samples : Array[String] = [
    "", "r=", "r=abc,s=,i=", "r=abc,s===,i=0", "r=abc,s=AAA,ddd", // 非法 base64
     "r=abc,s=AAA,i=notanumber", "r=abc,s=AAA,i=99999999999999999999", // 溢出
     "r=abc,s=AAA,i=-1", "s=AAA,i=4096,r=abc", // 乱序
     "r=", "s=", "i=", ",,,", "=,=,=", "r=\r\n", "s=////,i=1",
  ]
  for i = 0; i < 5000; i = i + 1 {
    let msg = if rnd.int(limit=2) == 0 {
      samples[rnd.int(limit=samples.length())]
    } else {
      sasl_random_string(rnd, rnd.int(limit=64))
    }
    sasl_swallow(fn() { let _ = @pg.parse_server_first(msg) })
    let _ = msg
  }
}

///|
test "fuzz: md5_password 任意 salt/user 不 panic" {
  let rnd = @random.Rand::new()
  for i = 0; i < 4000; i = i + 1 {
    let salt_buf = Buffer()
    for j = 0; j < rnd.int(limit=16); j = j + 1 {
      salt_buf.write_byte(rnd.int(limit=256).to_byte())
    }
    let salt = salt_buf.to_bytes()
    let pw = sasl_random_string(rnd, rnd.int(limit=32))
    let user = sasl_random_string(rnd, rnd.int(limit=32))
    // 不应 panic（盐长度不足/过长都要能处理）
    let _ = @pg.md5_password(pw, user, salt)
  }
}

///|
test "fuzz: scram_client_first / final / proof 任意输入不 panic" {
  let rnd = @random.Rand::new()
  for i = 0; i < 3000; i = i + 1 {
    let user = sasl_random_string(rnd, rnd.int(limit=16))
    let nonce = sasl_random_string(rnd, rnd.int(limit=24))
    let (first, bare) = @pg.scram_client_first(user, nonce)
    let _ = first
    let _ = bare
    let server_first = sasl_random_string(rnd, rnd.int(limit=48))
    let salt_buf = Buffer()
    for j = 0; j < rnd.int(limit=32); j = j + 1 {
      salt_buf.write_byte(rnd.int(limit=256).to_byte())
    }
    let salt_b64 = @utf8.decode_lossy(salt_buf.to_bytes())
    let pw = sasl_random_string(rnd, rnd.int(limit=24))
    sasl_swallow(fn() raise {
      let _ = @pg.scram_client_final(
        pw, bare, server_first, nonce, salt_b64, 4096,
      )
    })
    sasl_swallow(fn() raise {
      let _ = @pg.scram_proof(pw, salt_b64, 4096, server_first)
    })
  }
}
