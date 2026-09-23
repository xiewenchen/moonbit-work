///|
/// JSON-RPC 2.0 分发层（手册 0.4 / 1.1）。
///
/// 设计：**纯逻辑**放在 MoonBit 里（路由、参数校验、响应组装），
/// 只有"读文件/跑命令"这类真正碰系统的动作才走 FFI 到 Node。
/// 这样这层本身可以被测试，也符合"后端逻辑用 MoonBit 写"的初衷。
///
/// 方法表（对应手册 1.1 的后端工作区 API）：
///   ping                      → "pong"
///   workspace.listDir  {path}         → [ {name, dir}, ... ]
///   workspace.readFile {path}         → {content}
///   workspace.writeFile{path,content} → {ok:true}
///   task.run           {cmd}          → {code, stdout, stderr}

///|
/// 转义 JSON 字符串里的特殊字符（结果要拼进响应里）。
fn esc(s : String) -> String {
  let buf = Buffer()
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some('"') => buf.write_string_utf8("\\\"")
      Some('\\') => buf.write_string_utf8("\\\\")
      Some('\n') => buf.write_string_utf8("\\n")
      Some('\r') => buf.write_string_utf8("\\r")
      Some('\t') => buf.write_string_utf8("\\t")
      Some(c) =>
        if c.to_int() < 32 {
          buf.write_string_utf8(" ")
        } else {
          buf.write_string_utf8(c.to_string())
        }
      None => ()
    }
  }
  @utf8.decode_lossy(buf.to_bytes())
}

///|
/// 从请求里取字符串参数（`params` 是对象时按 key 取）。
fn param_str(j : Json, key : String) -> String? {
  match j {
    Json::Object(m) =>
      match m.get("params") {
        Some(Json::Object(ps)) =>
          match ps.get(key) {
            Some(Json::String(s)) => Some(s)
            _ => None
          }
        _ => None
      }
    _ => None
  }
}

///|
/// 取请求 id（可能是数字或字符串；原样回传，JSON-RPC 要求 id 必须一致）。
fn req_id(j : Json) -> String {
  match j {
    Json::Object(m) =>
      match m.get("id") {
        Some(Json::Number(n, ..)) => n.to_int().to_string()
        Some(Json::String(s)) => "\"" + esc(s) + "\""
        _ => "null"
      }
    _ => "null"
  }
}

///|
/// 取 method 名。
fn req_method(j : Json) -> String {
  match j {
    Json::Object(m) =>
      match m.get("method") {
        Some(Json::String(s)) => s
        _ => ""
      }
    _ => ""
  }
}

///|
/// 组装成功响应。
fn ok_resp(id : String, result : String) -> String {
  "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":" + result + "}"
}

///|
/// 组装错误响应。
fn err_resp(id : String, code : Int, message : String) -> String {
  "{\"jsonrpc\":\"2.0\",\"id\":" +
  id +
  ",\"error\":{\"code\":" +
  code.to_string() +
  ",\"message\":\"" +
  esc(message) +
  "\"}}"
}

///|
fn m_list_dir(id : String, j : Json) -> String {
  match param_str(j, "path") {
    Some(p) => ok_resp(id, list_dir(p))
    None => err_resp(id, -32602, "missing param: path")
  }
}

///|
fn m_read_file(id : String, j : Json) -> String {
  match param_str(j, "path") {
    Some(p) => {
      // read_file 是 FFI 到 fs.readFileSync，文件不存在时会抛 —— 所以必须兜住
      let content : String? = try {
        Some(read_file(p))
      } catch {
        _ => None
      } noraise {
        v => v
      }
      match content {
        Some(c) => ok_resp(id, "{\"content\":\"" + esc(c) + "\"}")
        None => err_resp(id, -32000, "read failed: " + p)
      }
    }
    None => err_resp(id, -32602, "missing param: path")
  }
}

///|
fn m_write_file(id : String, j : Json) -> String {
  match (param_str(j, "path"), param_str(j, "content")) {
    (Some(p), Some(c)) => {
      let ok : Bool = try {
        write_file(p, c)
        true
      } catch {
        _ => false
      } noraise {
        v => v
      }
      if ok {
        ok_resp(id, "{\"ok\":true}")
      } else {
        err_resp(id, -32000, "write failed: " + p)
      }
    }
    _ => err_resp(id, -32602, "missing param: path/content")
  }
}

///|
fn m_task_run(id : String, j : Json) -> String {
  match param_str(j, "cmd") {
    // exec_try 保证"命令失败也不抛异常"，它的 JSON 可直接作为 result
    Some(cmd) => ok_resp(id, exec_try(cmd))
    None => err_resp(id, -32602, "missing param: cmd")
  }
}

///|
/// 处理一条 JSON-RPC 请求，返回要回给前端的 JSON 文本。
///
/// 传入**原始请求文本**（WebSocket/HTTP 收到的原样内容），
/// 调用方不必懂 JSON-RPC 细节。
pub fn handle_line(line : String) -> String {
  let parsed : Json? = try {
    Some(@json.parse(line))
  } catch {
    _ => None
  } noraise {
    v => v
  }
  match parsed {
    None => err_resp("null", -32700, "Parse error")
    Some(j) => {
      let id = req_id(j)
      let meth = req_method(j)
      match meth {
        "ping" => ok_resp(id, "\"pong\"")
        "workspace.listDir" => m_list_dir(id, j)
        "workspace.readFile" => m_read_file(id, j)
        "workspace.writeFile" => m_write_file(id, j)
        "task.run" => m_task_run(id, j)
        "" => err_resp(id, -32600, "Invalid Request: missing method")
        _ => err_resp(id, -32601, "Method not found: " + meth)
      }
    }
  }
}

///|
/// 主程序自检：把 FFI 与分发链路各跑一遍。
pub fn self_check() -> String {
  let buf = Buffer()
  buf.write_string_utf8("--- FFI 自检 ---\n")
  buf.write_string_utf8("cwd = " + cwd() + "\n")
  buf.write_string_utf8(
    "exec_sync(moon --version) = " + exec_sync("moon --version").trim().to_owned() + "\n",
  )
  let dir = list_dir(".")
  buf.write_string_utf8("list_dir(.) = " + (if dir.length() > 100 { dir[:100].to_owned() } else { dir }) + " ...\n")
  buf.write_string_utf8("--- RPC 自检 ---\n")
  buf.write_string_utf8(
    "ping → " + handle_line("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}") + "\n",
  )
  buf.write_string_utf8(
    "未知方法 → " + handle_line("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"nope\"}") + "\n",
  )
  buf.write_string_utf8("坏 JSON → " + handle_line("not json at all") + "\n")
  buf.write_string_utf8(
    "task.run → " +
    handle_line(
      "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"task.run\",\"params\":{\"cmd\":\"echo hello-from-moonbit\"}}",
    ) +
    "\n",
  )
  @utf8.decode_lossy(buf.to_bytes())
}
