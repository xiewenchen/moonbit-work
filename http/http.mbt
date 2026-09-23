///|
/// HTTP/1.1 报文解析与序列化（纯逻辑层）。
///
/// 和 `redis/resp.mbt` 一样，这一层不碰 socket、不依赖任何 C 绑定，
/// 所以能在所有后端（含 wasm-gc）上测试；连接层放在单独的包里。
///
/// ## 安全约定（重要）
///
/// **所有接受 `pos` / `index` 的解析函数，入口处必须同时校验上下界**
/// （`pos < 0 || pos >= input.length()`）—— 只查上界是历史缺陷来源
/// （见 `docs/SECURITY.md`：`read_line`、`pg.parse_backend` 都因此 panic 过）。
///
/// 作为**系统性防御**，对字节的读取一律走 `safe_byte` / `safe_get`（越界返回兜底值），
/// 而不是裸索引 `input[i]` —— 这样即使某处漏了校验，也只是解析失败，不会崩掉进程。

///|
/// 安全取字节：越界返回 `None`（绝不 panic）。
pub fn safe_get(b : Bytes, i : Int) -> Byte? {
  if i < 0 || i >= b.length() {
    None
  } else {
    Some(b[i])
  }
}

///|
/// 安全取字节：越界返回 `default`（用于「比较 / 读字段」这类不想改控制流的场景）。
pub fn safe_byte(b : Bytes, i : Int, default : Byte) -> Byte {
  if i < 0 || i >= b.length() {
    default
  } else {
    b[i]
  }
}

///|
/// HTTP 方法。
pub(all) enum Method {
  Get
  Post
  Put
  Delete
  Patch
  Head
  Options
  Other(String)
} derive(Eq, Debug)

///|
pub fn Method::parse(s : StringView) -> Method {
  if s == "GET" {
    Get
  } else if s == "POST" {
    Post
  } else if s == "PUT" {
    Put
  } else if s == "DELETE" {
    Delete
  } else if s == "PATCH" {
    Patch
  } else if s == "HEAD" {
    Head
  } else if s == "OPTIONS" {
    Options
  } else {
    Other(s.to_owned())
  }
}

///|
pub fn Method::as_str(self : Method) -> String {
  match self {
    Get => "GET"
    Post => "POST"
    Put => "PUT"
    Delete => "DELETE"
    Patch => "PATCH"
    Head => "HEAD"
    Options => "OPTIONS"
    Other(s) => s
  }
}

///|
/// 解析/序列化失败。
pub suberror DecodeError {
  /// 报文不完整，需要更多字节
  UnexpectedEof(String)
  /// 报文格式非法
  Malformed(String)
  /// 请求体/头超过服务端上限
  PayloadTooLarge(String)
}

///|
/// 一个 HTTP 请求。
pub(all) struct Request {
  verb : Method
  target : String
  version : String
  headers : Array[(String, String)]
  mut body : Bytes
  mut params : Array[(String, String)]
  /// 连接的真实远端地址（由服务端填充，客户端无法伪造）。
  mut remote_addr : String
} derive(Debug)

///|
/// 一个 HTTP 响应。
pub(all) struct Response {
  status : Int
  reason : String
  headers : Array[(String, String)]
  body : Bytes
} derive(Debug)

///|
/// 大小写不敏感地查一个头字段。
fn find_header(headers : Array[(String, String)], name : String) -> String? {
  let want = name.to_lower()
  for kv in headers {
    let (k, v) = kv
    if k.to_lower() == want {
      return Some(v)
    }
  }
  None
}

///|
pub fn Request::header(self : Request, name : String) -> String? {
  find_header(self.headers, name)
}

///|
pub fn Response::header(self : Response, name : String) -> String? {
  find_header(self.headers, name)
}

///|
/// 常见状态码的默认 reason phrase。
pub fn default_reason(status : Int) -> String {
  match status {
    200 => "OK"
    201 => "Created"
    204 => "No Content"
    301 => "Moved Permanently"
    302 => "Found"
    304 => "Not Modified"
    400 => "Bad Request"
    401 => "Unauthorized"
    403 => "Forbidden"
    404 => "Not Found"
    405 => "Method Not Allowed"
    500 => "Internal Server Error"
    502 => "Bad Gateway"
    503 => "Service Unavailable"
    _ => "Unknown"
  }
}

///|
pub fn Request::new(verb : Method, target : String) -> Request {
  {
    verb,
    target,
    version: "HTTP/1.1",
    headers: [],
    body: @utf8.encode(""),
    params: [],
    remote_addr: "",
  }
}

///|
/// 取路由参数（由 Router 在匹配时填充）。
pub fn Request::param(self : Request, name : String) -> String? {
  for kv in self.params {
    let (k, v) = kv
    if k == name {
      return Some(v)
    }
  }
  None
}

///|
/// 把请求体按 UTF-8 解码为字符串。
pub fn Request::text(self : Request) -> String {
  @utf8.decode_lossy(self.body)
}

///|
/// 把请求体解析为 JSON。
pub fn Request::json(self : Request) -> Json raise {
  @json.parse(@utf8.decode_lossy(self.body))
}

// ---------------------------------------------------------------------------
// URL 解码与 query 解析
// ---------------------------------------------------------------------------

///|
fn hex_val(c : Char) -> Int? {
  if c >= '0' && c <= '9' {
    Some(c.to_int() - '0'.to_int())
  } else if c >= 'a' && c <= 'f' {
    Some(c.to_int() - 'a'.to_int() + 10)
  } else if c >= 'A' && c <= 'F' {
    Some(c.to_int() - 'A'.to_int() + 10)
  } else {
    None
  }
}

///|
/// URL percent-decode（解 `%XX`）。`plus_as_space` 为真时把 `+` 当空格（query 语义）。
pub fn percent_decode(s : StringView, plus_as_space? : Bool = true) -> String {
  let buf = Buffer()
  let n = s.length()
  let mut i = 0
  while i < n {
    match s.get_char(i) {
      Some('%') =>
        if i + 2 < n {
          let h = match s.get_char(i + 1) {
            Some(c) => hex_val(c)
            None => None
          }
          let l = match s.get_char(i + 2) {
            Some(c) => hex_val(c)
            None => None
          }
          match (h, l) {
            (Some(h), Some(l)) => {
              buf.write_byte((h * 16 + l).to_byte())
              i = i + 2
            }
            _ => buf.write_string_utf8("%")
          }
        } else {
          buf.write_string_utf8("%")
        }
      Some('+') =>
        if plus_as_space {
          buf.write_string_utf8(" ")
        } else {
          buf.write_string_utf8("+")
        }
      Some(c) => buf.write_string_utf8(c.to_string())
      None => ()
    }
    i = i + 1
  }
  @utf8.decode_lossy(buf.to_bytes())
}

///|
/// 请求路径（percent-decoded，不含 query）。
pub fn Request::path(self : Request) -> String {
  match self.target.split_once("?") {
    Some((p, _)) => percent_decode(p, plus_as_space=false)
    None => percent_decode(self.target, plus_as_space=false)
  }
}

///|
/// 全部 query 参数（已 percent-decode）。
pub fn Request::query_params(self : Request) -> Array[(String, String)] {
  let out : Array[(String, String)] = []
  match self.target.split_once("?") {
    Some((_, q)) =>
      for pair in q.split("&") {
        let p = pair.to_owned()
        if p != "" {
          match p.split_once("=") {
            Some((k, v)) => out.push((percent_decode(k), percent_decode(v)))
            None => out.push((percent_decode(p), ""))
          }
        }
      }
    None => ()
  }
  out
}

///|
/// 取一个 query 参数。
pub fn Request::query(self : Request, name : String) -> String? {
  for kv in self.query_params() {
    let (k, v) = kv
    if k == name {
      return Some(v)
    }
  }
  None
}

// ---------------------------------------------------------------------------
// 增量解析（供服务端分块读取使用）
// ---------------------------------------------------------------------------

///|
/// 只解析请求行与头部（不读 body），返回 `(请求, body 起始位置)`。
pub fn Request::parse_head(
  input : Bytes,
  pos : Int,
) -> (Request, Int) raise DecodeError {
  let (line, p) = read_line(input, pos)
  let (method_s, rest) = match line.split_once(" ") {
    Some(pair) => pair
    None => raise Malformed("bad request line: \{line}")
  }
  let (target, version) = match rest.split_once(" ") {
    Some(pair) => pair
    None => raise Malformed("bad request line: \{line}")
  }
  let (headers, p2) = parse_headers(input, p)
  (
    {
      verb: Method::parse(method_s),
      target: target.to_owned(),
      version: version.to_owned(),
      headers,
      body: @utf8.encode(""),
      params: [],
      remote_addr: "",
    },
    p2,
  )
}

///|
/// 按 `Content-Length` 取 body；数据不足返回 `None`，超限抛 `PayloadTooLarge`。
pub fn body_for_length(
  input : Bytes,
  pos : Int,
  headers : Array[(String, String)],
  max_body_bytes : Int,
) -> (Bytes, Int)? raise DecodeError {
  match find_header(headers, "content-length") {
    Some(v) => {
      let len = parse_decimal(v)
      if len > max_body_bytes {
        raise PayloadTooLarge("body \{len} bytes > limit \{max_body_bytes}")
      }
      if pos + len > input.length() {
        None
      } else {
        Some(
          (input.clamped_view(start=pos, end=pos + len).to_owned(), pos + len),
        )
      }
    }
    None => Some((@utf8.encode(""), pos))
  }
}

///|
fn read_line_opt(input : Bytes, pos : Int) -> (String, Int)? {
  let n = input.length()
  // 防御：非法位置直接当作「数据不足」，绝不能越界访问（会 panic 掉整个进程）
  if pos < 0 || pos > n {
    return None
  }
  let mut i = pos
  while i + 1 < n {
    if safe_byte(input, i, 0) == b'\r' && safe_byte(input, i + 1, 0) == b'\n' {
      return Some(
        (@utf8.decode_lossy(input.clamped_view(start=pos, end=i)), i + 2),
      )
    }
    i = i + 1
  }
  None
}

///|
fn parse_hex_size(s : String) -> Int raise DecodeError {
  let head = match s.split_once(";") {
    Some((h, _)) => h.to_owned()
    None => s
  }
  if head == "" {
    raise Malformed("empty chunk size")
  }
  let mut acc = 0
  for i = 0; i < head.length(); i = i + 1 {
    match head.get_char(i) {
      Some(c) =>
        match hex_val(c) {
          Some(v) => {
            // 溢出防护：阈值保证 acc*16+15 不溢出（134217727*16+15 仍在 2^31-1 内）
            if acc > 134217727 {
              raise Malformed("chunk size too large")
            }
            acc = acc * 16 + v
            if acc < 0 {
              raise Malformed("chunk size overflow")
            }
          }
          None => raise Malformed("bad chunk size: \{head}")
        }
      None => ()
    }
  }
  acc
}

///|
/// 尝试解码 `Transfer-Encoding: chunked` 的 body；
/// 数据不足返回 `None`，非法或超限抛错。
pub fn decode_chunked(
  input : Bytes,
  pos : Int,
  max_body_bytes : Int,
) -> (Bytes, Int)? raise DecodeError {
  let out = Buffer()
  let mut p = pos
  while true {
    let (line, np) = match read_line_opt(input, p) {
      Some(x) => x
      None => return None
    }
    let size = parse_hex_size(line)
    if size == 0 {
      // trailer：读到空行为止（累计长度也受限，防止用海量 trailer 占内存）
      let mut q = np
      let mut done = false
      let mut trailer_bytes = 0
      while !done {
        match read_line_opt(input, q) {
          Some((tl, nq)) => {
            trailer_bytes = trailer_bytes + (nq - q)
            if trailer_bytes > max_body_bytes {
              raise PayloadTooLarge("chunked trailer too large")
            }
            q = nq
            if tl == "" {
              done = true
            }
          }
          None => return None
        }
      }
      return Some((out.to_bytes(), q))
    }
    // 用减法比较，避免 `out.length() + size` 溢出为负而绕过上限
    if size > max_body_bytes - out.length() {
      raise PayloadTooLarge("chunked body > limit \{max_body_bytes}")
    }
    if size < 0 {
      raise Malformed("negative chunk size")
    }
    if np + size + 2 > input.length() {
      return None
    }
    out.write_bytes(input.clamped_view(start=np, end=np + size))
    let next_p = np + size + 2
    // 防御：位置必须严格前进，否则会死循环 / 越界
    if next_p <= p {
      raise Malformed("chunk decoding did not advance")
    }
    p = next_p
  }
  None
}

///|
pub fn Response::new(status : Int, body : Bytes) -> Response {
  { status, reason: default_reason(status), headers: [], body, }
}

///|
/// 构造一个 `text/plain; charset=utf-8` 响应。
pub fn Response::text(status : Int, body : String) -> Response {
  {
    status,
    reason: default_reason(status),
    headers: [("Content-Type", "text/plain; charset=utf-8")],
    body: @utf8.encode(body),
  }
}

///|
/// 构造一个 `application/json` 响应。
pub fn Response::json(status : Int, body : String) -> Response {
  {
    status,
    reason: default_reason(status),
    headers: [("Content-Type", "application/json")],
    body: @utf8.encode(body),
  }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

///|
fn read_line(input : Bytes, pos : Int) -> (String, Int) raise DecodeError {
  let n = input.length()
  // 防御：非法位置一律按「找不到行」处理，绝不越界访问（会 panic 掉整个进程）
  if pos < 0 || pos > n {
    raise UnexpectedEof("invalid position \{pos} for read_line")
  }
  let mut i = pos
  while i + 1 < n {
    if safe_byte(input, i, 0) == b'\r' && safe_byte(input, i + 1, 0) == b'\n' {
      return (@utf8.decode_lossy(input.clamped_view(start=pos, end=i)), i + 2)
    }
    i = i + 1
  }
  raise UnexpectedEof("CRLF not found after position \{pos}")
}

///|
fn parse_headers(
  input : Bytes,
  pos : Int,
) -> (Array[(String, String)], Int) raise DecodeError {
  let headers : Array[(String, String)] = []
  // 头数量上限（纵深防御；服务端另有 max_header_bytes 字节上限）
  let max_headers = 200
  let mut p = pos
  let mut done = false
  while !done {
    if headers.length() > max_headers {
      raise Malformed("too many headers")
    }
    let (line, next) = read_line(input, p)
    p = next
    if line == "" {
      done = true
    } else {
      match line.split_once(":") {
        Some((k, v)) => headers.push((k.trim().to_owned(), v.trim().to_owned()))
        None => raise Malformed("bad header line: \{line}")
      }
    }
  }
  (headers, p)
}

///|
fn parse_decimal(view : StringView) -> Int raise DecodeError {
  let b = @utf8.encode(view)
  let n = b.length()
  if n == 0 {
    raise Malformed("empty number")
  }
  let mut acc = 0
  let mut i = 0
  while i < n {
    let c = safe_byte(b, i, 0)
    if c < b'0' || c > b'9' {
      raise Malformed("invalid digit in number")
    }
    // 溢出防护：Int 是 32 位。阈值必须保证 acc*10+9 不溢出：
    // 214748363*10+9 = 2147483639 ≤ 2^31-1 ✓
    // （否则 `Content-Length: 4294967396` 会绕回成 100，绕过 body 上限）
    if acc > 214748363 {
      raise Malformed("number too large")
    }
    acc = acc * 10 + (c.to_int() - 48)
    if acc < 0 {
      raise Malformed("number overflow")
    }
    i = i + 1
  }
  acc
}

///|
fn parse_body(
  input : Bytes,
  pos : Int,
  headers : Array[(String, String)],
  max_body_bytes? : Int = 8388608,
) -> (Bytes, Int) raise DecodeError {
  match find_header(headers, "content-length") {
    Some(v) => {
      let len = parse_decimal(v)
      if len > max_body_bytes {
        raise PayloadTooLarge("body \{len} bytes > limit \{max_body_bytes}")
      }
      if pos + len > input.length() {
        raise UnexpectedEof("body incomplete: need \{len} bytes")
      }
      (input.clamped_view(start=pos, end=pos + len).to_owned(), pos + len)
    }
    None => (@utf8.encode(""), pos)
  }
}

///|
/// 解析一个 HTTP 请求，返回 `(请求, 下一位置)`。
pub fn Request::parse(
  input : Bytes,
  pos : Int,
  max_body_bytes? : Int = 8388608,
) -> (Request, Int) raise DecodeError {
  let (line, p) = read_line(input, pos)
  let (method_s, rest) = match line.split_once(" ") {
    Some(pair) => pair
    None => raise Malformed("bad request line: \{line}")
  }
  let (target, version) = match rest.split_once(" ") {
    Some(pair) => pair
    None => raise Malformed("bad request line: \{line}")
  }
  let (headers, p2) = parse_headers(input, p)
  let (body, p3) = parse_body(input, p2, headers, max_body_bytes~)
  (
    {
      verb: Method::parse(method_s),
      target: target.to_owned(),
      version: version.to_owned(),
      headers,
      body,
      params: [],
      remote_addr: "",
    },
    p3,
  )
}

///|
/// 解析一个 HTTP 响应，返回 `(响应, 下一位置)`。
pub fn Response::parse(
  input : Bytes,
  pos : Int,
) -> (Response, Int) raise DecodeError {
  let (line, p) = read_line(input, pos)
  let (version, rest) = match line.split_once(" ") {
    Some(pair) => pair
    None => raise Malformed("bad status line: \{line}")
  }
  let _ = version
  let (status_s, reason) = match rest.split_once(" ") {
    Some(pair) => pair
    None => raise Malformed("bad status line: \{line}")
  }
  let (headers, p2) = parse_headers(input, p)
  let (body, p3) = parse_body(input, p2, headers)
  (
    {
      status: parse_decimal(status_s),
      reason: reason.to_owned(),
      headers,
      body,
    },
    p3,
  )
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

///|
/// 序列化一个请求（客户端用）。
pub fn Request::to_bytes(self : Request) -> Bytes {
  let buf = Buffer()
  buf.write_string_utf8(
    "\{self.verb.as_str()} \{self.target} \{self.version}\r\n",
  )
  for kv in self.headers {
    let (k, v) = kv
    buf.write_string_utf8("\{k}: \{v}\r\n")
  }
  buf.write_string_utf8("Content-Length: \{self.body.length()}\r\n\r\n")
  buf.write_bytes(self.body)
  buf.to_bytes()
}

///|
/// 去掉字符串中的 CR/LF，防止把外部输入写进响应头时造成**响应拆分**。
fn strip_crlf(s : String) -> String {
  let buf = Buffer()
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some(c) =>
        if c != '\r' && c != '\n' {
          buf.write_string_utf8(c.to_string())
        }
      None => ()
    }
  }
  @utf8.decode_lossy(buf.to_bytes())
}

///|
/// 序列化一个响应（服务端用）；会自动补上 `Content-Length`。
pub fn Response::to_bytes(self : Response) -> Bytes {
  let buf = Buffer()
  buf.write_string_utf8(
    "HTTP/1.1 \{self.status} \{strip_crlf(self.reason)}\r\n",
  )
  let mut has_len = false
  for kv in self.headers {
    let (k, v) = kv
    if k.to_lower() == "content-length" {
      has_len = true
    }
    // 纵深防御：header 名/值一律去掉 CR/LF
    buf.write_string_utf8("\{strip_crlf(k)}: \{strip_crlf(v)}\r\n")
  }
  if !has_len {
    buf.write_string_utf8("Content-Length: \{self.body.length()}\r\n")
  }
  buf.write_string_utf8("\r\n")
  buf.write_bytes(self.body)
  buf.to_bytes()
}
