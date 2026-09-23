///|
/// JSON 组装与读取工具。
///
/// ## 为什么不用 `derive(ToJson)`
///
/// 实测 `derive(ToJson)` 对 `Option` 为 `None` 的字段会**整个省略**，
/// 而 Conduit 规范要求 `bio` / `image` / `tagList` 等字段**必须存在**（可为 `null`）。
/// 因此这里用 `Json::object(...)` 手工组装，字段集合完全可控。
///
/// 实测输出：`{"author":{"username":"alice","bio":null,"image":"http://x/y.png","following":true}}`
/// 整数输出为 `3`（非 `3.0`），转义与 Unicode 均正确。

///|
/// 字符串 → Json。
pub fn jstr(s : String) -> Json {
  Json::string(s)
}

///|
/// 可空字符串 → Json（`None` 产出**真 null**，不是省略字段）。
pub fn jopt(s : String?) -> Json {
  match s {
    Some(v) => Json::string(v)
    None => Json::null()
  }
}

///|
/// 整数 → Json。
pub fn jnum(n : Int) -> Json {
  Json::number(n.to_double())
}

///|
/// Int64 → Json。
pub fn jnum64(n : Int64) -> Json {
  Json::number(n.to_double())
}

///|
/// 布尔 → Json。
pub fn jbool(b : Bool) -> Json {
  Json::boolean(b)
}

///|
/// 按字段名数组组装对象（顺序即传入顺序）。
pub fn jobj(fields : Array[(String, Json)]) -> Json {
  let m : Map[String, Json] = Map([])
  for f in fields {
    m.set(f.0, f.1)
  }
  Json::object(m)
}

///|
/// Json 数组。
pub fn jarr(items : Array[Json]) -> Json {
  Json::array(items)
}

///|
/// 字符串数组 → Json 数组。
pub fn jstrs(items : Array[String]) -> Json {
  Json::array(items.map(fn(s) { Json::string(s) }))
}

// ---------------------------------------------------------------------------
// 请求体读取
// ---------------------------------------------------------------------------

///|
/// 解析请求体文本。
pub fn parse_body(text : String) -> Json? {
  try Some(@json.parse(text)) catch {
    _ => None
  } noraise {
    v => v
  }
}

///|
/// 取出 `{"<key>": {...}}` 的内层对象。
///
/// Conduit 的请求体统一是这种包一层的形式（`{"user":{...}}`、`{"article":{...}}`）。
pub fn unwrap_obj(text : String, key : String) -> Map[String, Json]? {
  match parse_body(text) {
    Some(Json::Object(m)) =>
      match m.get(key) {
        Some(Json::Object(inner)) => Some(inner)
        _ => None
      }
    _ => None
  }
}

///|
/// 从对象里取字符串字段。
pub fn get_str(m : Map[String, Json]?, key : String) -> String? {
  match m {
    Some(mm) =>
      match mm.get(key) {
        Some(Json::String(s)) => Some(s)
        _ => None
      }
    None => None
  }
}

///|
/// 从对象里取字符串字段，区分「缺失」与「显式 null」。
///
/// - `Some(Some(s))` 有值
/// - `Some(None)`    显式 null
/// - `None`          字段缺失（或类型不是字符串/null）
pub fn get_opt_str(m : Map[String, Json]?, key : String) -> String?? {
  match m {
    Some(mm) =>
      match mm.get(key) {
        Some(Json::String(s)) => Some(Some(s))
        Some(Json::Null) => Some(None)
        _ => None
      }
    None => None
  }
}

///|
/// 从对象里取字符串数组字段（非数组或缺失返回 None）。
pub fn get_strs(m : Map[String, Json]?, key : String) -> Array[String]? {
  match m {
    Some(mm) =>
      match mm.get(key) {
        Some(Json::Array(arr)) => {
          let out : Array[String] = []
          for item in arr {
            match item {
              Json::String(s) => out.push(s)
              _ => ()
            }
          }
          Some(out)
        }
        _ => None
      }
    None => None
  }
}

///|
/// 取字符串数组字段，区分「缺失」「显式 null」「有值」。
///
/// 与 `get_opt_str` 同理：必填数组字段显式传 null 应被拒（422），
/// 而不是当成「未提供该字段」静默忽略。
pub fn get_opt_strs(m : Map[String, Json]?, key : String) -> Array[String]?? {
  match m {
    Some(mm) =>
      match mm.get(key) {
        Some(Json::Array(arr)) => {
          let out : Array[String] = []
          for item in arr {
            match item {
              Json::String(s) => out.push(s)
              _ => ()
            }
          }
          Some(Some(out))
        }
        Some(Json::Null) => Some(None)
        _ => None
      }
    None => None
  }
}

// ---------------------------------------------------------------------------
// 字符串 → 数值
// ---------------------------------------------------------------------------

///|
/// 十进制字符串 → 非负整数（严格：只接受数字，溢出返回 None）。
pub fn parse_nonneg_int(s : String) -> Int? {
  if s == "" {
    return None
  }
  let mut n = 0
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some(c) =>
        if c >= '0' && c <= '9' {
          let d = c.to_int() - '0'.to_int()
          if n > 214748364 {
            return None
          }
          n = n * 10 + d
        } else {
          return None
        }
      None => return None
    }
  }
  Some(n)
}
