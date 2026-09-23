#!/usr/bin/env python3
"""RealWorld / Conduit API 端到端验收脚本。

覆盖全部 19 个端点，以及 401 / 403 / 404 / 409 / 422 分支。

用法：
    python conduit/e2e.py [base_url]
默认 base_url = http://127.0.0.1:8095
"""
import json
import ssl
import sys
import time
import urllib.error
import urllib.request

# 部署验证走 nginx 的 HTTPS（自签证书），跳过证书校验
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8095"
STAMP = str(int(time.time() * 1000))[-9:]
UNIQUE_TAG = "t" + STAMP
# 与 deploy 启动脚本中 MBP_CORS_ORIGINS 保持一致
CORS_OK = "https://app.example.com"

passed = 0
failed = 0
failures = []


def req(method, path, body=None, token=None, raw=False, origin=None):
    """返回 (status, parsed_body_or_text)。"""
    url = BASE + path
    data = None
    headers = {}
    if origin:
        headers["Origin"] = origin
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Token " + token
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=15, context=SSL_CTX) as resp:
            text = resp.read().decode("utf-8", "replace")
            return resp.status, (text if raw else (json.loads(text) if text else None))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, (text if raw else json.loads(text))
        except Exception:
            return e.code, text


def req_full(method, path, body=None, token=None, origin=None):
    """返回 (status, 响应头字典)。"""
    url = BASE + path
    data = None
    headers = {}
    if origin:
        headers["Origin"] = origin
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Token " + token
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=15, context=SSL_CTX) as resp:
            resp.read()
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        e.read()
        return e.code, {k.lower(): v for k, v in e.headers.items()}


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  [PASS] {name}")
    else:
        failed += 1
        failures.append(name)
        print(f"  [FAIL] {name}  {detail}")


print("=" * 74)
print(f"Conduit API 端到端验收 @ {BASE}   (stamp={STAMP})")
print("=" * 74)

alice_email = f"alice{STAMP}@example.com"
bob_email = f"bob{STAMP}@example.com"
alice_u = f"alice{STAMP}"
bob_u = f"bob{STAMP}"

# ---------------------------------------------------------------- 用户与鉴权
print("\n[1] 注册 / 登录 / 当前用户 / 更新")
st, b = req("POST", "/api/users", {"user": {"username": alice_u, "email": alice_email, "password": "password123"}})
check("注册 alice → 201", st == 201, f"got {st} {b}")
alice_tok = (b or {}).get("user", {}).get("token", "")
check("注册返回 token", bool(alice_tok))
check("注册返回 email 正确", (b or {}).get("user", {}).get("email") == alice_email)
check("注册返回 bio 字段存在(可为 null)", "bio" in (b or {}).get("user", {}))
check("注册返回 image 字段存在", "image" in (b or {}).get("user", {}))

st, b = req("POST", "/api/users", {"user": {"username": alice_u + "x", "email": alice_email, "password": "password123"}})
check("重复 email → 409", st == 409, f"got {st} {b}")

st, b = req("POST", "/api/users", {"user": {"username": alice_u + "y", "email": "not-an-email", "password": "password123"}})
check("非法 email → 422", st == 422, f"got {st} {b}")

st, b = req("POST", "/api/users", {"user": {"username": "", "email": f"z{STAMP}@e.com", "password": "password123"}})
check("空 username → 422", st == 422, f"got {st} {b}")

st, b = req("POST", "/api/users", {"user": {"username": alice_u + "z", "email": f"y{STAMP}@e.com", "password": "short"}})
check("短密码 → 422", st == 422, f"got {st} {b}")

st, b = req("POST", "/api/users/login", {"user": {"email": alice_email, "password": "password123"}})
check("登录 → 200", st == 200, f"got {st} {b}")
check("登录返回 token", bool((b or {}).get("user", {}).get("token")))

st, b = req("POST", "/api/users/login", {"user": {"email": alice_email, "password": "wrongpass"}})
check("错误密码 → 401", st == 401, f"got {st} {b}")

st, b = req("GET", "/api/user", token=alice_tok)
check("GET /api/user → 200", st == 200, f"got {st} {b}")

st, b = req("GET", "/api/user")
check("GET /api/user 无 token → 401", st == 401, f"got {st} {b}")

st, b = req("GET", "/api/user", token="garbage.token.value")
check("GET /api/user 伪造 token → 401", st == 401, f"got {st} {b}")

st, b = req("PUT", "/api/user", {"user": {"bio": "hello bio", "image": "http://img/x.png"}}, token=alice_tok)
check("更新用户 → 200", st == 200, f"got {st} {b}")
check("更新后 bio 生效", (b or {}).get("user", {}).get("bio") == "hello bio")

# ---------------------------------------------------------------- Profile
print("\n[2] Profile 与关注")
st, b = req("POST", "/api/users", {"user": {"username": bob_u, "email": bob_email, "password": "password123"}})
check("注册 bob → 201", st == 201, f"got {st} {b}")
bob_tok = (b or {}).get("user", {}).get("token", "")

st, b = req("GET", f"/api/profiles/{alice_u}")
check("GET profile 匿名 → 200", st == 200, f"got {st} {b}")
check("匿名时 following=false", (b or {}).get("profile", {}).get("following") is False)

st, b = req("GET", f"/api/profiles/{alice_u}", token=bob_tok)
check("GET profile 登录 → following=false（未关注）", (b or {}).get("profile", {}).get("following") is False)

st, b = req("GET", "/api/profiles/nobody_here_xyz")
check("GET 不存在 profile → 404", st == 404, f"got {st} {b}")

st, b = req("POST", f"/api/profiles/{alice_u}/follow", None, token=bob_tok)
check("关注 → 200", st == 200, f"got {st} {b}")
check("关注后 following=true", (b or {}).get("profile", {}).get("following") is True)

st, b = req("POST", f"/api/profiles/{alice_u}/follow", None)
check("关注无 token → 401", st == 401, f"got {st} {b}")

st, b = req("POST", "/api/profiles/nobody_xyz/follow", None, token=bob_tok)
check("关注不存在用户 → 404", st == 404, f"got {st} {b}")

# ---------------------------------------------------------------- 文章
print("\n[3] 文章 CRUD / 列表 / 过滤 / 分页")
st, b = req("POST", "/api/articles", {"article": {"title": "Hello World", "description": "first", "body": "the body", "tagList": [UNIQUE_TAG, "moonbit"]}}, token=alice_tok)
check("创建文章 → 201", st == 201, f"got {st} {b}")
art = (b or {}).get("article", {})
slug = art.get("slug", "")
check("slug 由标题派生", slug == "hello-world", f"got '{slug}'")
check("tagList 正确", sorted(art.get("tagList", [])) == sorted(["moonbit", UNIQUE_TAG]), f"got {art.get('tagList')}")
check("author.username 正确", art.get("author", {}).get("username") == alice_u)
check("favoritesCount=0", art.get("favoritesCount") == 0)
check("favorited=false", art.get("favorited") is False)
check("createdAt 是 ISO8601", isinstance(art.get("createdAt"), str) and "T" in art.get("createdAt", "") and art.get("createdAt", "").endswith("Z"), f"got {art.get('createdAt')}")

st, b = req("POST", "/api/articles", {"article": {"title": "", "description": "d", "body": "b"}}, token=alice_tok)
check("空标题 → 422", st == 422, f"got {st} {b}")

st, b = req("POST", "/api/articles", {"article": {"title": "T", "description": "d", "body": "b"}})
check("创建文章无 token → 401", st == 401, f"got {st} {b}")

st, b = req("POST", "/api/articles", {"article": {"title": "Hello World", "description": "dup", "body": "b"}}, token=bob_tok)
check("同标题文章 slug 去重", st == 201 and (b or {}).get("article", {}).get("slug", "") != slug, f"got {st} {(b or {}).get('article', {}).get('slug')}")
dup_slug = (b or {}).get("article", {}).get("slug", "")

st, b = req("GET", "/api/articles")
check("GET /api/articles → 200", st == 200, f"got {st} {b}")
check("文章数组字段存在", isinstance((b or {}).get("articles"), list))

# 用本轮唯一的 author 做计数断言，避免历史数据干扰
st, b = req("GET", f"/api/articles?author={alice_u}")
check("author 过滤 → alice 恰好 1 篇", (b or {}).get("articlesCount") == 1, f"got {(b or {}).get('articlesCount')}")

st, b = req("GET", f"/api/articles?author={alice_u}&limit=1")
check("limit=1 → 1 篇", len((b or {}).get("articles", [])) == 1 and (b or {}).get("articlesCount") == 1, f"got {len((b or {}).get('articles', []))}")

st, b = req("GET", f"/api/articles?author={alice_u}&offset=1&limit=1")
check("offset=1 → 越界返回空", len((b or {}).get("articles", [])) == 0, f"got {b}")

st, b = req("GET", f"/api/articles/{slug}")
check("GET 单篇 → 200", st == 200, f"got {st} {b}")
check("单篇 body 正确", (b or {}).get("article", {}).get("body") == "the body")

st, b = req("GET", "/api/articles/no-such-slug")
check("GET 不存在文章 → 404", st == 404, f"got {st} {b}")

st, b = req("GET", f"/api/articles?tag={UNIQUE_TAG}")
check("按 tag 过滤 → 1 篇", (b or {}).get("articlesCount") == 1, f"got {(b or {}).get('articlesCount')}")

st, b = req("GET", f"/api/articles?author={alice_u}")
check("按 author 过滤 → 1 篇", (b or {}).get("articlesCount") == 1, f"got {(b or {}).get('articlesCount')}")

st, b = req("GET", "/api/articles?tag=nonexistent")
check("不存在的 tag → 0 篇", (b or {}).get("articlesCount") == 0, f"got {(b or {}).get('articlesCount')}")

st, b = req("GET", "/api/tags")
check("GET /api/tags → 200", st == 200, f"got {st} {b}")
check("tags 含本轮唯一 tag", UNIQUE_TAG in (b or {}).get("tags", []), f"got {b}")

# ---------------------------------------------------------------- feed
print("\n[4] Feed（关注流）")
st, b = req("GET", "/api/articles/feed", token=bob_tok)
check("bob feed → 200", st == 200, f"got {st} {b}")
check("feed 含 alice 的 1 篇", (b or {}).get("articlesCount") == 1, f"got {(b or {}).get('articlesCount')}")

st, b = req("GET", "/api/articles/feed")
check("feed 无 token → 401", st == 401, f"got {st} {b}")

st, b = req("DELETE", f"/api/profiles/{alice_u}/follow", None, token=bob_tok)
check("取关 → 200", st == 200, f"got {st} {b}")
check("取关后 following=false", (b or {}).get("profile", {}).get("following") is False)
st, b = req("GET", "/api/articles/feed", token=bob_tok)
check("取关后 feed 为空", (b or {}).get("articlesCount") == 0, f"got {(b or {}).get('articlesCount')}")

# ---------------------------------------------------------------- 收藏
print("\n[5] 收藏")
st, b = req("POST", f"/api/articles/{slug}/favorite", None, token=bob_tok)
check("收藏 → 200", st == 200, f"got {st} {b}")
check("收藏后 favorited=true", (b or {}).get("article", {}).get("favorited") is True)
check("收藏后 favoritesCount=1", (b or {}).get("article", {}).get("favoritesCount") == 1, f"got {(b or {}).get('article', {}).get('favoritesCount')}")

st, b = req("POST", f"/api/articles/{slug}/favorite", None, token=bob_tok)
check("重复收藏幂等（仍 1）", (b or {}).get("article", {}).get("favoritesCount") == 1, f"got {(b or {}).get('article', {}).get('favoritesCount')}")

st, b = req("GET", "/api/articles", token=bob_tok)
check("列表里对 bob 显示 favorited=true", (b or {}).get("articles", [{}])[0].get("favorited") is True or any(a.get("favorited") for a in (b or {}).get("articles", [])), f"got {b}")

st, b = req("GET", f"/api/articles?favorited={bob_u}")
check("按 favorited 过滤 → 1 篇", (b or {}).get("articlesCount") == 1, f"got {(b or {}).get('articlesCount')}")

st, b = req("DELETE", f"/api/articles/{slug}/favorite", None, token=bob_tok)
check("取消收藏 → 200", st == 200, f"got {st} {b}")
check("取消后 favoritesCount=0", (b or {}).get("article", {}).get("favoritesCount") == 0, f"got {(b or {}).get('article', {}).get('favoritesCount')}")

st, b = req("POST", "/api/articles/no-such/favorite", None, token=bob_tok)
check("收藏不存在文章 → 404", st == 404, f"got {st} {b}")

# ---------------------------------------------------------------- 评论
print("\n[6] 评论")
st, b = req("POST", f"/api/articles/{slug}/comments", {"comment": {"body": "nice post"}}, token=bob_tok)
check("发评论 → 201", st == 201, f"got {st} {b}")
cid = (b or {}).get("comment", {}).get("id")
check("评论返回 id", isinstance(cid, int), f"got {cid}")
check("评论作者正确", (b or {}).get("comment", {}).get("author", {}).get("username") == bob_u)

st, b = req("POST", f"/api/articles/{slug}/comments", {"comment": {"body": ""}}, token=bob_tok)
check("空评论 → 422", st == 422, f"got {st} {b}")

st, b = req("POST", f"/api/articles/{slug}/comments", {"comment": {"body": "x"}})
check("无 token 发评论 → 401", st == 401, f"got {st} {b}")

st, b = req("GET", f"/api/articles/{slug}/comments")
check("匿名读评论 → 200", st == 200, f"got {st} {b}")
check("评论数 = 1", len((b or {}).get("comments", [])) == 1, f"got {b}")

st, b = req("GET", "/api/articles/no-such/comments")
check("不存在文章的评论 → 404", st == 404, f"got {st} {b}")

st, b = req("DELETE", f"/api/articles/{slug}/comments/{cid}", None, token=alice_tok)
check("非作者删评论 → 403", st == 403, f"got {st} {b}")

st, b = req("DELETE", f"/api/articles/{slug}/comments/{cid}", None, token=bob_tok)
check("作者删评论 → 204", st == 204, f"got {st} {b}")

st, b = req("DELETE", f"/api/articles/{slug}/comments/999999", None, token=bob_tok)
check("删不存在评论 → 404", st == 404, f"got {st} {b}")

# ---------------------------------------------------------------- 文章更新/删除
print("\n[7] 文章更新与删除（权限）")
st, b = req("PUT", f"/api/articles/{slug}", {"article": {"description": "updated desc"}}, token=alice_tok)
check("作者更新 → 200", st == 200, f"got {st} {b}")
check("更新生效", (b or {}).get("article", {}).get("description") == "updated desc")

st, b = req("PUT", f"/api/articles/{slug}", {"article": {"description": "hack"}}, token=bob_tok)
check("非作者更新 → 403", st == 403, f"got {st} {b}")

st, b = req("PUT", "/api/articles/no-such", {"article": {"description": "x"}}, token=alice_tok)
check("更新不存在文章 → 404", st == 404, f"got {st} {b}")

st, b = req("PUT", f"/api/articles/{slug}", {"article": {"title": "Renamed Title"}}, token=alice_tok)
new_slug = (b or {}).get("article", {}).get("slug", "")
check("改标题后 slug 随之变化", new_slug == "renamed-title", f"got '{new_slug}'")

st, b = req("DELETE", f"/api/articles/{new_slug}", None, token=bob_tok)
check("非作者删除 → 403", st == 403, f"got {st} {b}")

st, b = req("DELETE", f"/api/articles/{new_slug}", None, token=alice_tok)
check("作者删除 → 204", st == 204, f"got {st} {b}")

st, b = req("GET", f"/api/articles/{new_slug}")
check("删除后 → 404", st == 404, f"got {st} {b}")

# ---------------------------------------------------------------- CORS
print("\n[8] CORS 与基础设施")
st, b = req("OPTIONS", "/api/articles", raw=True, origin=CORS_OK)
check("OPTIONS 预检 → 204", st == 204, f"got {st}")

st, hdrs = req_full("OPTIONS", "/api/articles", origin=CORS_OK)
check("白名单来源预检回显 Allow-Origin", hdrs.get("access-control-allow-origin") == CORS_OK, f"got {hdrs.get('access-control-allow-origin')}")

st, hdrs = req_full("OPTIONS", "/api/articles", origin="https://evil.example")
check("非白名单来源预检**不**下发 CORS 头", hdrs.get("access-control-allow-origin") is None, f"got {hdrs.get('access-control-allow-origin')}")

st, hdrs = req_full("GET", "/api/tags", origin=CORS_OK)
check("白名单来源实际请求带 CORS 头", hdrs.get("access-control-allow-origin") == CORS_OK, f"got {hdrs.get('access-control-allow-origin')}")
check("带 Vary: Origin", (hdrs.get("vary") or "").lower() == "origin", f"got {hdrs.get('vary')}")

st, hdrs = req_full("GET", "/api/tags", origin="https://evil.example")
check("非白名单来源实际请求**不**带 CORS 头", hdrs.get("access-control-allow-origin") is None, f"got {hdrs.get('access-control-allow-origin')}")

st, b = req("GET", "/health", raw=True)
check("/health → 200", st == 200, f"got {st}")

st, b = req("GET", "/metrics", raw=True)
check("/metrics → 200", st == 200, f"got {st}")

print("\n" + "=" * 74)
print(f"结果：{passed} 通过, {failed} 失败 / 共 {passed + failed} 项")
if failures:
    print("失败项：")
    for f in failures:
        print("  - " + f)
print("=" * 74)
sys.exit(1 if failed else 0)
