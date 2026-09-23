///|
/// PostgreSQL 文本格式值的类型化解码（纯逻辑）。
///
/// 简单查询与默认扩展查询都以**文本格式**返回数据；
/// 这里按列的类型 OID 把文本还原成结构化的 `Value`。

///|
/// 解码后的值。
///
/// `numeric` 用**原始十进制字符串**表示（避免 `Double` 丢精度，金额场景必须用它）；
/// 时间/`uuid`/`json` 保留服务器原文。
pub(all) enum Value {
  Null
  Bool(Bool)
  Int(Int64)
  Float(Double)
  /// 精确十进制（PG `numeric`），原样保留文本
  Numeric(String)
  /// 时间戳/日期/时间（原文）
  Timestamp(String)
  /// `uuid`（原文）
  Uuid(String)
  /// `json` / `jsonb`（原文）
  Json(String)
  Str(String)
  /// 数组（元素按子类型解码）
  ArrayValue(Array[Value])
  Raw(Bytes)
} derive(Debug)

///|
fn parse_int64_str(s : String) -> Int64 {
  let mut neg = false
  let mut acc : Int64 = 0L
  let mut started = false
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some('-') => if !started { neg = true }
      Some(c) =>
        if c >= '0' && c <= '9' {
          acc = acc * 10L + (c.to_int() - '0'.to_int()).to_int64()
          started = true
        }
      None => ()
    }
  }
  if neg {
    -acc
  } else {
    acc
  }
}

///|
fn parse_double_str(s : String) -> Double {
  let mut neg = false
  let mut value = 0.0
  let mut scale = 1.0
  let mut in_frac = false
  let mut in_exp = false
  let mut exp_neg = false
  let mut exp = 0
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some('-') => if in_exp { exp_neg = true } else { neg = true }
      Some('+') => ()
      Some('.') => in_frac = true
      Some('e') | Some('E') => in_exp = true
      Some(c) =>
        if c >= '0' && c <= '9' {
          let d = c.to_int() - '0'.to_int()
          if in_exp {
            // 饱和，避免 32 位溢出后绕回异常值
            if exp > 100000 {
              exp = 100000
            } else {
              exp = exp * 10 + d
            }
          } else if in_frac {
            scale = scale * 10.0
            value = value + d.to_double() / scale
          } else {
            value = value * 10.0 + d.to_double()
          }
        }
      None => ()
    }
  }
  let mut result = value
  if in_exp {
    // 上限防护：10^400 已远超 Double 可表示范围，更大的幂无意义；
    // 且能防止恶意数字文本（如 `1e2000000000`）造成 CPU 挂死
    let e = if exp > 400 { 400 } else { exp }
    let mut m = 1.0
    for i = 0; i < e; i = i + 1 {
      m = m * 10.0
    }
    if exp_neg {
      result = result / m
    } else {
      result = result * m
    }
  }
  if neg {
    -result
  } else {
    result
  }
}

// ---------------------------------------------------------------------------
// 数组文本（PG 的 `{...}` 形式）
// ---------------------------------------------------------------------------

///|
/// 解析 PG 数组文本（如 `{1,2,3}`、`{"a","b,c"}`）为元素原文本数组。
fn parse_pg_array(s : String) -> Array[String] {
  let out : Array[String] = []
  let n = s.length()
  let mut i = 0
  // 跳过开头的 '{'
  while i < n && s.get_char(i) == Some('{') {
    i = i + 1
  }
  let mut cur = Buffer()
  let mut in_quotes = false
  let mut has = false
  while i < n {
    let c = match s.get_char(i) {
      Some(c) => c
      None => break
    }
    if in_quotes {
      if c == '\\' && i + 1 < n {
        match s.get_char(i + 1) {
          Some(next) => cur.write_string_utf8(next.to_string())
          None => ()
        }
        i = i + 2
        continue
      } else if c == '"' {
        in_quotes = false
      } else {
        cur.write_string_utf8(c.to_string())
      }
    } else if c == '"' {
      in_quotes = true
      has = true
    } else if c == ',' || c == '}' {
      if has || cur.to_bytes().length() > 0 {
        out.push(@utf8.decode_lossy(cur.to_bytes()))
      }
      cur = Buffer()
      has = false
      if c == '}' {
        break
      }
    } else {
      cur.write_string_utf8(c.to_string())
      has = true
    }
    i = i + 1
  }
  out
}

///|
/// 数组 OID → 元素 OID（常见的几种）。
fn element_oid(array_oid : Int) -> Int {
  if array_oid == 1000 {
    16 // bool[]
  } else if array_oid == 1005 {
    21 // int2[]
  } else if array_oid == 1007 {
    23 // int4[]
  } else if array_oid == 1016 {
    20 // int8[]
  } else if array_oid == 1021 {
    700 // float4[]
  } else if array_oid == 1022 {
    701 // float8[]
  } else if array_oid == 1009 {
    25 // text[]
  } else if array_oid == 1015 {
    1043 // varchar[]
  } else if array_oid == 1231 {
    1700 // numeric[]
  } else if array_oid == 1182 {
    1082 // date[]
  } else if array_oid == 1115 {
    1114 // timestamp[]
  } else if array_oid == 1185 {
    1184 // timestamptz[]
  } else if array_oid == 2951 {
    2950 // uuid[]
  } else if array_oid == 199 {
    114 // json[]
  } else if array_oid == 3807 {
    3802 // jsonb[]
  } else {
    25 // 默认按文本
  }
}

///|
/// 把文本格式的值按类型 OID 解码。
///
/// 覆盖：bool, bytea, int2/4/8, text/varchar/char, float4/8, numeric,
/// date/time/timestamp(tz), interval, uuid, json/jsonb, 以及上述类型的数组。
pub fn decode_value(oid : Int, text : String?) -> Value {
  match text {
    None => Null
    Some(s) =>
      if oid == 16 {
        Bool(s == "t")
      } else if oid == 20 || oid == 21 || oid == 23 {
        Int(parse_int64_str(s))
      } else if oid == 700 || oid == 701 {
        Float(parse_double_str(s))
      } else if oid == 1700 {
        Numeric(s)
      } else if oid == 1082 ||
        oid == 1083 ||
        oid == 1114 ||
        oid == 1184 ||
        oid == 1266 ||
        oid == 1186 {
        Timestamp(s)
      } else if oid == 2950 {
        Uuid(s)
      } else if oid == 114 || oid == 3802 {
        Json(s)
      } else if oid == 17 {
        Raw(@utf8.encode(s))
      } else if oid == 1000 ||
        oid == 1005 ||
        oid == 1007 ||
        oid == 1009 ||
        oid == 1015 ||
        oid == 1016 ||
        oid == 1021 ||
        oid == 1022 ||
        oid == 1115 ||
        oid == 1182 ||
        oid == 1185 ||
        oid == 1231 ||
        oid == 2951 ||
        oid == 199 ||
        oid == 3807 {
        let eo = element_oid(oid)
        let elems : Array[Value] = []
        for part in parse_pg_array(s) {
          elems.push(decode_value(eo, Some(part)))
        }
        ArrayValue(elems)
      } else {
        Str(s)
      }
  }
}
