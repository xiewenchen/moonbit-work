///|
/// HTTP 报文解析/序列化测试（纯逻辑，跨后端可测）。

///|
test "parse a simple GET request" {
  let raw = @utf8.encode(
    "GET /hello?name=moon HTTP/1.1\r\nHost: localhost\r\nUser-Agent: mbp\r\n\r\n",
  )
  let (req, next) = @http.Request::parse(raw, 0)
  assert_eq(next, raw.length())
  assert_eq(req.verb, @http.Method::Get)
  assert_eq(req.target, "/hello?name=moon")
  assert_eq(req.version, "HTTP/1.1")
  assert_eq(req.header("host"), Some("localhost"))
  assert_eq(req.header("HOST"), Some("localhost"))
  assert_eq(req.header("missing"), None)
  assert_eq(req.body.length(), 0)
}

///|
test "parse a POST request with body" {
  let raw = @utf8.encode(
    "POST /submit HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 12\r\n\r\n{\"ok\":true}\n",
  )
  let (req, next) = @http.Request::parse(raw, 0)
  assert_eq(next, raw.length())
  assert_eq(req.verb, @http.Method::Post)
  assert_eq(@utf8.decode(req.body), "{\"ok\":true}\n")
}

///|
test "parse incomplete request reports UnexpectedEof" {
  let raw = @utf8.encode("GET /x HTTP/1.1\r\nHost: h\r\n") // 缺最后的空行
  let need_more : Bool = try @http.Request::parse(raw, 0) catch {
    @http.UnexpectedEof(_) => true
    @http.Malformed(_) => false
    @http.PayloadTooLarge(_) => false
  } noraise {
    _ => false
  }
  assert_eq(need_more, true)
}

///|
test "response text round trip" {
  let resp = @http.Response::text(200, "pong")
  let bytes = resp.to_bytes()
  let (back, next) = @http.Response::parse(bytes, 0)
  assert_eq(next, bytes.length())
  assert_eq(back.status, 200)
  assert_eq(back.reason, "OK")
  assert_eq(back.header("content-type"), Some("text/plain; charset=utf-8"))
  assert_eq(@utf8.decode(back.body), "pong")
}

///|
test "response serialization includes Content-Length" {
  let resp = @http.Response::text(404, "nope")
  let text = @utf8.decode(resp.to_bytes())
  assert_true_contains(text, "HTTP/1.1 404 Not Found\r\n")
  assert_true_contains(text, "Content-Length: 4\r\n")
  assert_true_contains(text, "\r\n\r\nnope")
}

///|
fn assert_true_contains(haystack : String, needle : String) -> Unit raise {
  assert_eq(haystack.contains(needle), true)
}

///|
test "percent decode and query params" {
  let raw = @utf8.encode(
    "GET /a%20b?x=1&y=hello%20world&z=%E4%B8%AD HTTP/1.1\r\nHost: h\r\n\r\n",
  )
  let (req, _) = @http.Request::parse(raw, 0)
  assert_eq(req.path(), "/a b")
  assert_eq(req.query("x"), Some("1"))
  assert_eq(req.query("y"), Some("hello world"))
  assert_eq(req.query("z"), Some("中"))
  assert_eq(req.query("missing"), None)
}

///|
test "query plus becomes space" {
  let raw = @utf8.encode("GET /q?a=1+2&b=3 HTTP/1.1\r\nHost: h\r\n\r\n")
  let (req, _) = @http.Request::parse(raw, 0)
  assert_eq(req.query("a"), Some("1 2"))
  assert_eq(req.query("b"), Some("3"))
  assert_eq(req.query_params().length(), 2)
}

///|
test "percent decode standalone" {
  assert_eq(@http.percent_decode("a%2Bb"), "a+b")
  assert_eq(@http.percent_decode("a+b"), "a b")
  assert_eq(@http.percent_decode("a+b", plus_as_space=false), "a+b")
  assert_eq(@http.percent_decode("%"), "%") // 不完整的转义原样保留
}

///|
test "decode chunked body" {
  let raw = @utf8.encode("4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n")
  match @http.decode_chunked(raw, 0, 1024) {
    Some((body, next)) => {
      assert_eq(@utf8.decode(body), "Wikipedia")
      assert_eq(next, raw.length())
    }
    None => fail("expected a complete chunked body")
  }
}

///|
test "decode chunked with trailer" {
  let raw = @utf8.encode("3\r\nabc\r\n0\r\nX-Trailer: 1\r\n\r\n")
  match @http.decode_chunked(raw, 0, 1024) {
    Some((body, next)) => {
      assert_eq(@utf8.decode(body), "abc")
      assert_eq(next, raw.length())
    }
    None => fail("expected complete")
  }
}

///|
test "decode chunked incomplete returns None" {
  let raw = @utf8.encode("4\r\nWik")
  let is_none : Bool = @http.decode_chunked(raw, 0, 1024) is None
  assert_eq(is_none, true)
}

///|
test "decode chunked over limit raises" {
  let raw = @utf8.encode("4\r\nWiki\r\n0\r\n\r\n")
  let failed : Bool = try @http.decode_chunked(raw, 0, 2) catch {
    @http.PayloadTooLarge(_) => true
    _ => false
  } noraise {
    _ => false
  }
  assert_eq(failed, true)
}
