#!/usr/bin/env python3
"""安全测试：对靶场服务（127.0.0.1:8090）做偏漏洞方向的攻击测试。

覆盖：Content-Length 整数溢出/请求走私、大小限制绕过、限流绕过、
鉴权绕过、响应头注入、SQL 注入样式输入、慢速攻击、JSON 深嵌套 DoS。
"""
import socket, json, sys, time

HOST, PORT = "127.0.0.1", 8090
RESULTS = []


def raw(payload: bytes, read_timeout=3.0, read_all=True, xff=None):
    """发原始字节，返回响应字节。

    读到「完整响应」就返回（按 Content-Length 判断），不傻等 EOF ——
    服务端 keep-alive 时不会主动关闭连接。

    xff: 若给定，则附带 `X-Forwarded-For`（用于验证限流 key 是否可伪造）。
    """
    if xff is not None:
        # 在请求头末尾插入 XFF
        head, sep, rest = payload.partition(b"\r\n\r\n")
        payload = head + b"\r\nX-Forwarded-For: " + xff.encode() + sep + rest
    s = socket.create_connection((HOST, PORT), timeout=5)
    s.settimeout(read_timeout)
    try:
        try:
            s.sendall(payload)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            return b""
        data = b""
        deadline = time.time() + read_timeout
        while time.time() < deadline:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
            # 头部完整？
            if b"\r\n\r\n" in data:
                head, _, body = data.partition(b"\r\n\r\n")
                cl = None
                for ln in head.split(b"\r\n")[1:]:
                    if ln.lower().startswith(b"content-length:"):
                        try:
                            cl = int(ln.split(b":", 1)[1].strip())
                        except ValueError:
                            cl = None
                if cl is not None and len(body) >= cl:
                    break
                if cl is None and not read_all:
                    break
        return data
    except (socket.timeout, ConnectionResetError, ConnectionAbortedError, OSError):
        return b""
    finally:
        s.close()


def parse(data: bytes):
    if not data:
        return ("(no response)", {}, b"")
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status = lines[0].decode("latin1") if lines else "?"
    headers = {}
    for ln in lines[1:]:
        if b":" in ln:
            k, _, v = ln.partition(b":")
            headers[k.strip().lower().decode("latin1")] = v.strip().decode("latin1")
    return (status, headers, body)


def check(name, ok, detail):
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}\n      {detail}")


print("=" * 70)
print("安全测试靶场攻击 —— http://127.0.0.1:8090")
print("=" * 70)

# ---------- 0. 健康基线 ----------
d = raw(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
st, hd, bd = parse(d)
check("基线 /health 可访问", "200" in st, f"{st} body={bd[:40]!r}")

# ---------- 1. Content-Length 整数溢出 → 请求走私 ----------
# 2**32 + 4 = 4294967300；若 32 位 Int 溢出，可能变成 4（只读 4 字节 body）
smuggle = (
    b"POST /api/echo HTTP/1.1\r\nHost: x\r\n"
    b"Content-Length: 4294967300\r\n\r\n"
    b"AAAA"
    b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n"
)
# 该请求无 token，预期 401；关键看：溢出的 CL 是否让服务端把后半段当成第二个请求
d = raw(smuggle, read_timeout=4.0)
st, hd, bd = parse(d)
n_resp = d.count(b"HTTP/1.1 ")
check(
    "Content-Length 溢出(2^32+4) 不产生第二个响应（无走私）",
    n_resp <= 1,
    f"响应数={n_resp} status={st} CL头={hd.get('content-length')}",
)

# ---------- 2. 超大 Content-Length ----------
big = (
    b"POST /api/echo HTTP/1.1\r\nHost: x\r\n"
    b"Content-Length: 99999999999999\r\n\r\nAAAA"
)
d = raw(big, read_timeout=4.0)
st, hd, bd = parse(d)
check(
    "超大 Content-Length 被拒（413/400）而非接受",
    ("413" in st) or ("400" in st),
    f"{st} body={bd[:60]!r}",
)

# ---------- 2b. 溢出绕过大小限制（2^32+100 → 若溢出则变成 100）----------
# 声明 4294967396，若被截断成 100 就会「接受」并只读 100 字节 → 走私
ovf = (
    b"POST /api/echo HTTP/1.1\r\nHost: x\r\n"
    b"Content-Length: 4294967396\r\n\r\n"
    + b"A" * 100
    + b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n"
)
d = raw(ovf, read_timeout=3.5)
n_resp = d.count(b"HTTP/1.1 ")
check(
    "溢出后的 Content-Length 未绕过限制/未产生走私响应",
    n_resp <= 1,
    f"响应数={n_resp} 首行={d.split(b'\r\n')[0][:50]!r}",
)

# ---------- 3. 负数 Content-Length ----------
neg = (
    b"POST /api/echo HTTP/1.1\r\nHost: x\r\n"
    b"Content-Length: -1\r\n\r\nAAAA"
)
d = raw(neg, read_timeout=3.0)
st, hd, bd = parse(d)
check("负数 Content-Length 被拒", ("400" in st) or ("413" in st), f"{st}")

# ---------- 4. 超大请求头 → 431 ----------
huge = b"GET /health HTTP/1.1\r\nHost: x\r\nX-Big: " + b"A" * 200000 + b"\r\n\r\n"
d = raw(huge, read_timeout=4.0)
st, hd, bd = parse(d)
check("超大请求头被拒(431/400)", ("431" in st) or ("400" in st), f"{st}")

# ---------- 5. 超大 body（超过 max_body_bytes 8MiB）----------
# 只声明、不真发，观察是否立刻被拒
d = raw(
    b"POST /api/echo HTTP/1.1\r\nHost: x\r\nContent-Length: 20971520\r\n\r\n",
    read_timeout=4.0,
)
st, hd, bd = parse(d)
check("超大 body(20MiB) 被拒", "413" in st, f"{st} body={bd[:60]!r}")

# ---------- 6. chunked 无上限？ ----------
# 声明一个巨大的 chunk，但只给一部分；观察是否立刻 413 或等待
ch = (
    b"POST /api/echo HTTP/1.1\r\nHost: x\r\n"
    b"Transfer-Encoding: chunked\r\n\r\n"
    b"FFFFFF00\r\n"  # ~4GiB chunk size
)
d = raw(ch, read_timeout=4.0)
st, hd, bd = parse(d)
check("超大 chunk 声明被拒(413/400)", ("413" in st) or ("400" in st), f"{st} body={bd[:60]!r}")

# ---------- 7. 鉴权绕过：无 token / 篡改 JWT / alg=none ----------
d = raw(b"GET /api/echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
st, hd, bd = parse(d)
check("无 token 访问受保护端点 → 401", "401" in st, f"{st}")

# 手工构造 alg=none 的 token
import base64


def b64u(x: bytes) -> str:
    return base64.urlsafe_b64encode(x).decode().rstrip("=")


hdr_none = b64u(b'{"alg":"none","typ":"JWT"}')
pl = b64u(b'{"sub":"admin"}')
tok_none = f"{hdr_none}.{pl}."  # 空签名
d = raw(
    f"GET /api/echo HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {tok_none}\r\nConnection: close\r\n\r\n".encode()
)
st, hd, bd = parse(d)
check("alg=none 伪造 token 被拒 → 401", "401" in st, f"{st} body={bd[:60]!r}")

# 篡改 payload（签名不匹配）
hdr_hs = b64u(b'{"alg":"HS256","typ":"JWT"}')
pl2 = b64u(b'{"sub":"admin","role":"root"}')
tok_bad = f"{hdr_hs}.{pl2}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
d = raw(
    f"GET /api/echo HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {tok_bad}\r\nConnection: close\r\n\r\n".encode()
)
st, hd, bd = parse(d)
check("篡改 payload 的 token 被拒 → 401", ("401" in st) or ("429" in st), f"{st}")

# ---------- 8. 鉴权白名单绕过尝试 ----------
for p in [b"/health/../api/echo", b"/health%2f../api/echo", b"/Health", b"/health?x=1"]:
    d = raw(b"GET " + p + b" HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    st, hd, bd = parse(d)
    leaked = b"ok" == bd.strip()
    check(
        f"白名单绕过 {p.decode()} 未泄露 /health 内容",
        not leaked,
        f"{st} body={bd[:40]!r}",
    )

# ---------- 9. 响应头注入（X-Request-Id 回显）----------
inj = b"GET /health HTTP/1.1\r\nHost: x\r\nX-Request-Id: aaa\rbbb\r\nConnection: close\r\n\r\n"
d = raw(inj, read_timeout=3.0)
st, hd, bd = parse(d)
raw_rid = None
for ln in d.split(b"\r\n"):
    if ln.lower().startswith(b"x-request-id:"):
        raw_rid = ln
check(
    "X-Request-Id 回显不含裸 CR/LF（防响应拆分）",
    raw_rid is not None and b"\r" not in raw_rid.split(b":", 1)[1],
    f"原始响应头行={raw_rid!r}",
)

# ---------- 10. SQL 注入样式输入（走路由参数，应参数化） ----------
for evil in ["1 OR 1=1", "1;DROP TABLE notes--", "1' UNION SELECT NULL--"]:
    from urllib.parse import quote

    pth = "/api/notes/" + quote(evil)
    d = raw(f"GET {pth} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".encode())
    st, hd, bd = parse(d)
    check(
        f"注入样式路径参数被安全处理: {evil[:20]}",
        ("401" in st) or ("429" in st) or ("400" in st),
        f"{st} body={bd[:40]!r}",
    )

# ---------- 11. 慢速攻击：只发一半请求头，验证 idle timeout ----------
s = socket.create_connection((HOST, PORT), timeout=5)
s.settimeout(40)
t0 = time.time()
s.sendall(b"GET /health HTTP/1.1\r\nHost: x\r\n")  # 不发结尾空行
closed = False
try:
    while True:
        c = s.recv(4096)
        if not c:
            closed = True
            break
        if time.time() - t0 > 35:
            break
except socket.timeout:
    pass
elapsed = time.time() - t0
s.close()
check(
    "慢速半开请求被超时关闭（idle timeout ≤ ~35s）",
    closed and elapsed < 35,
    f"closed={closed} elapsed={elapsed:.1f}s",
)

# ---------- 12. JSON 深嵌套 DoS ----------
deep = "[" * 100000 + "]" * 100000
body = deep.encode()
req = (
    b"GET /api/echo HTTP/1.1\r\nHost: x\r\n"
    b"Authorization: Bearer x\r\n"
    b"Content-Type: application/json\r\n"
    b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
)
t0 = time.time()
d = raw(req, read_timeout=6.0)
el = time.time() - t0
st, hd, bd = parse(d)
check("超深嵌套 JSON 未导致服务崩溃/卡死", el < 6 and st != "(no response)", f"{st} 用时{el:.2f}s")

print("\n" + "=" * 70)
print("=== 限流绕过验证（client_key 取自 X-Forwarded-For）===")
# 同一个 XFF 连发 6 次 → 桶容量 3，应出现 429
codes_same = []
for i in range(6):
    d = raw(b"GET /api/echo HTTP/1.1\r\nHost: x\r\n\r\n", xff="9.9.9.9")
    code = d.split(b"\r\n")[0].decode("latin1").split(" ")[1] if d else "none"
    codes_same.append(code)
# 每次换一个 XFF → 若被绕过，则全部不是 429
codes_diff = []
for i in range(6):
    d = raw(b"GET /api/echo HTTP/1.1\r\nHost: x\r\n\r\n", xff=f"1.2.3.{i}")
    code = d.split(b"\r\n")[0].decode("latin1").split(" ")[1] if d else "none"
    codes_diff.append(code)
print(f"  同一 XFF  : {codes_same}")
print(f"  不同 XFF  : {codes_diff}")
rate_limited_same = codes_same.count("429")
rate_limited_diff = codes_diff.count("429")
check(
    "限流对同一来源生效",
    rate_limited_same > 0,
    f"同 XFF 中 429 次数={rate_limited_same}/{len(codes_same)}",
)
# 修复后：client_key 用真实远端地址，伪造 XFF 不应绕过
check(
    "[已修复] 伪造 X-Forwarded-For 无法绕过限流",
    rate_limited_diff > 0,
    f"换 XFF 后 429 次数={rate_limited_diff}/{len(codes_diff)}（>0 表示确实没被绕过）",
)

print("\n" + "=" * 70)
fails = [r for r in RESULTS if not r[1]]
print(f"合计 {len(RESULTS)} 项：PASS {len(RESULTS)-len(fails)}，FAIL {len(fails)}")
for n, _, d in fails:
    print(f"  ✗ {n}: {d}")
print("=" * 70)
sys.exit(1 if fails else 0)
