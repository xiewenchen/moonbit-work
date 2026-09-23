///|
/// Redis 命令层：在 `Client` 上提供类型化的常用命令。
///
/// 全部走自研 RESP 收发，不依赖任何 C 绑定。

///|
/// 把一条字符串类回复（bulk / simple）取成 `String`。
fn as_string(v : @redis.Resp) -> String raise {
  match v {
    @redis.Resp::BulkString(b) => @utf8.decode_lossy(b)
    @redis.Resp::SimpleString(s) => s
    _ => fail("expected a string reply")
  }
}

///|
/// `EXISTS key` —— 键是否存在。
pub async fn Client::exists(self : Client, key : String) -> Bool {
  match self.command(["EXISTS", key]) {
    @redis.Resp::Integer(n) => n > 0L
    _ => fail("EXISTS failed")
  }
}

///|
/// `EXPIRE key seconds` —— 是否成功设置过期时间。
pub async fn Client::expire(self : Client, key : String, seconds : Int) -> Bool {
  match self.command(["EXPIRE", key, seconds.to_string()]) {
    @redis.Resp::Integer(n) => n == 1L
    _ => fail("EXPIRE failed")
  }
}

///|
/// `TTL key` —— 剩余秒数（-1 无过期，-2 不存在）。
pub async fn Client::ttl(self : Client, key : String) -> Int64 {
  match self.command(["TTL", key]) {
    @redis.Resp::Integer(n) => n
    _ => fail("TTL failed")
  }
}

///|
/// `INCR key`。
pub async fn Client::incr(self : Client, key : String) -> Int64 {
  match self.command(["INCR", key]) {
    @redis.Resp::Integer(n) => n
    _ => fail("INCR failed")
  }
}

///|
/// `INCRBY key delta`。
pub async fn Client::incr_by(
  self : Client,
  key : String,
  delta : Int64,
) -> Int64 {
  match self.command(["INCRBY", key, delta.to_string()]) {
    @redis.Resp::Integer(n) => n
    _ => fail("INCRBY failed")
  }
}

///|
/// `HSET key field value` —— 返回新增字段数。
pub async fn Client::hset(
  self : Client,
  key : String,
  field : String,
  value : String,
) -> Int64 {
  match self.command(["HSET", key, field, value]) {
    @redis.Resp::Integer(n) => n
    _ => fail("HSET failed")
  }
}

///|
/// `HGET key field`。
pub async fn Client::hget(
  self : Client,
  key : String,
  field : String,
) -> String? {
  match self.command(["HGET", key, field]) {
    @redis.Resp::BulkString(b) => Some(@utf8.decode_lossy(b))
    @redis.Resp::NullBulk => None
    _ => fail("HGET failed")
  }
}

///|
/// `HGETALL key` —— 扁平的字段/值数组折成键值对。
pub async fn Client::hgetall(
  self : Client,
  key : String,
) -> Array[(String, String)] {
  match self.command(["HGETALL", key]) {
    @redis.Resp::ArrayValue(items) => {
      let out : Array[(String, String)] = []
      let n = items.length()
      let mut i = 0
      while i + 1 < n {
        out.push((as_string(items[i]), as_string(items[i + 1])))
        i = i + 2
      }
      out
    }
    _ => fail("HGETALL failed")
  }
}

///|
/// `LPUSH key value...` —— 返回列表长度。
pub async fn Client::lpush(
  self : Client,
  key : String,
  values : Array[String],
) -> Int64 {
  match self.command(["LPUSH", key, ..values]) {
    @redis.Resp::Integer(n) => n
    _ => fail("LPUSH failed")
  }
}

///|
/// `LRANGE key start stop`。
pub async fn Client::lrange(
  self : Client,
  key : String,
  start : Int,
  stop : Int,
) -> Array[String] {
  match self.command(["LRANGE", key, start.to_string(), stop.to_string()]) {
    @redis.Resp::ArrayValue(items) => {
      let out : Array[String] = []
      for it in items {
        out.push(as_string(it))
      }
      out
    }
    _ => fail("LRANGE failed")
  }
}

///|
/// `KEYS pattern`（慎用：全量扫描，可能阻塞）。
pub async fn Client::keys(self : Client, pattern : String) -> Array[String] {
  match self.command(["KEYS", pattern]) {
    @redis.Resp::ArrayValue(items) => {
      let out : Array[String] = []
      for it in items {
        out.push(as_string(it))
      }
      out
    }
    _ => fail("KEYS failed")
  }
}
