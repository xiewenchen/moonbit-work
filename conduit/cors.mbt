///|
/// CORS 中间件：按**来源白名单**下发跨域头。
///
/// ## 为什么不能用 `*`
///
/// 当前实现原先无条件返回 `Access-Control-Allow-Origin: *`，
/// 意味着**任意网站**都能用受害者浏览器直接调用本 API。
/// 对带 `Authorization` 的接口，这会把用户凭据暴露给任何第三方页面。
///
/// ## 默认策略
///
/// **默认不开放跨域**（未配置白名单时不返回任何 CORS 头）。
/// 需要跨域时由部署方显式列出前端来源：
///
/// ```
/// MBP_CORS_ORIGINS=https://app.example.com,https://admin.example.com
/// ```
///
/// 特殊值 `*` 表示确实要放开所有来源（仅在公开只读 API 等场景使用）。

///|
/// 解析 `MBP_CORS_ORIGINS`：逗号分隔，去空白，丢弃空项。
pub fn parse_origins(spec : String) -> Array[String] {
  let out : Array[String] = []
  for part in spec.split(",") {
    let t = part.trim().to_owned()
    if t != "" {
      out.push(t)
    }
  }
  out
}

///|
/// 判断某来源是否被允许。
///
/// 精确匹配（大小写不敏感，来源的 scheme/host 按规范大小写敏感，
/// 但此处宽松处理不影响安全性 —— 白名单本身由部署方维护）。
pub fn cors_allowed(origins : Array[String], origin : String) -> Bool {
  for o in origins {
    if o == "*" {
      return true
    }
    if o.to_lower() == origin.to_lower() {
      return true
    }
  }
  false
}

///|
/// 装上 CORS 中间件。
///
/// - 预检（OPTIONS）：来源被允许时返回 204 + 允许的方法/头；否则返回 204 但**不带** CORS 头
/// - 实际请求：来源被允许时补上 `Access-Control-Allow-Origin` 与 `Vary: Origin`
pub fn use_cors(app : @app.App, spec : String) -> Unit {
  let origins = parse_origins(spec)
  app.use_middleware(async fn(req, next) {
    let origin = req.header("origin")
    let allowed : String? = match origin {
      Some(o) => if cors_allowed(origins, o) { Some(o) } else { None }
      None => None
    }
    if req.verb is @http.Method::Options {
      // 预检：无论是否允许都返回 204；被拒绝时不带 CORS 头，浏览器自会拦截
      let r = @http.Response::new(204, @utf8.encode(""))
      match allowed {
        Some(o) => {
          r.headers.push(("Access-Control-Allow-Origin", o))
          r.headers.push(
            ("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS"),
          )
          r.headers.push(
            ("Access-Control-Allow-Headers", "Authorization,Content-Type"),
          )
          r.headers.push(("Access-Control-Max-Age", "86400"))
          // 来源不同响应不同，必须参与缓存键
          r.headers.push(("Vary", "Origin"))
        }
        None => ()
      }
      r
    } else {
      let resp = next()
      match allowed {
        Some(o) => {
          resp.headers.push(("Access-Control-Allow-Origin", o))
          resp.headers.push(
            ("Access-Control-Allow-Headers", "Authorization,Content-Type"),
          )
          resp.headers.push(("Vary", "Origin"))
        }
        None => ()
      }
      resp
    }
  })
}
