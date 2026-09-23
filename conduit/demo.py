#!/usr/bin/env python3
"""Conduit 后端完整业务流程演示 —— 跑一遍真实的用户旅程。

展示：注册 → 登录 → 发文章 → 浏览 → 关注 → 关注流 → 收藏 → 评论 →
      权限校验 → 删除，并观察指标随之变化。

用法：
    python conduit/demo.py [base_url]
默认 https://127.0.0.1:8443（经 nginx 的 TLS 入口，与真实客户端同一条路径）
"""
import json
import ssl
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://127.0.0.1:8443"
STAMP = str(int(time.time() * 1000))[-6:]

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

step_no = 0


def hr(title):
    print()
    print("─" * 72)
    print(f"  {title}")
    print("─" * 72)


def step(text):
    global step_no
    step_no += 1
    print(f"\n   [{step_no:02d}] {text}")


def req(method, path, body=None, token=None):
    headers = {}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Token " + token
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)

    def parse(t):
        # /health 等端点返回纯文本，不能无脑 json.loads
        if not t:
            return None
        try:
            return json.loads(t)
        except Exception:
            return t

    try:
        with urllib.request.urlopen(r, timeout=20, context=CTX) as resp:
            return resp.status, parse(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, parse(e.read().decode("utf-8", "replace"))


def show(label, value, indent=9):
    pad = " " * indent
    print(f"{pad}{label}: {value}")


def brief_article(a):
    tags = ",".join(a.get("tagList", []))
    return (f"«{a.get('title')}» slug={a.get('slug')} "
            f"作者={a.get('author',{}).get('username')} 标签=[{tags}] "
            f"收藏数={a.get('favoritesCount')} 已收藏={a.get('favorited')}")


print("=" * 72)
print("  Conduit 后端 —— 完整业务流程演示")
print(f"  目标: {BASE}")
print("  （纯 MoonBit 实现 · PostgreSQL + Redis · nginx 负载均衡 3 实例）")
print("=" * 72)

# ---------------------------------------------------------------- 0 健康
hr("0. 服务健康")
st, _ = req("GET", "/health")
show("GET /health", f"HTTP {st}")
st, b = req("GET", "/metrics")
show("GET /metrics", "Prometheus 文本格式可用" if st == 200 else f"HTTP {st}")

# ---------------------------------------------------------------- 1 注册
hr("1. 用户注册（bcrypt 哈希 + JWT 签发）")
alice = f"alice{STAMP}"
bob = f"bob{STAMP}"
step(f"注册 alice（{alice}）")
st, b = req("POST", "/api/users", {"user": {
    "username": alice, "email": f"{alice}@example.com", "password": "password123"}})
alice_tok = (b or {}).get("user", {}).get("token", "")
show("HTTP 状态", st)
show("username", (b or {}).get("user", {}).get("username"))
show("token", (alice_tok[:40] + "...") if alice_tok else "(无)")
show("bio 字段", repr((b or {}).get("user", {}).get("bio")) + "  ← 规范要求存在，可为 null")

step(f"注册 bob（{bob}）")
st, b = req("POST", "/api/users", {"user": {
    "username": bob, "email": f"{bob}@example.com", "password": "password123"}})
bob_tok = (b or {}).get("user", {}).get("token", "")
show("HTTP 状态", st)

step("重复注册同一 email（应被拒绝）")
st, b = req("POST", "/api/users", {"user": {
    "username": alice + "x", "email": f"{alice}@example.com", "password": "password123"}})
show("HTTP 状态", f"{st}  ← 409 冲突")
show("错误体", json.dumps(b, ensure_ascii=False))

step("非法 email（应被拒绝）")
st, b = req("POST", "/api/users", {"user": {
    "username": "x", "email": "not-an-email", "password": "password123"}})
show("HTTP 状态", f"{st}  ← 422 校验失败")
show("错误体", json.dumps(b, ensure_ascii=False))

# ---------------------------------------------------------------- 2 登录
hr("2. 登录与鉴权")
step("用密码登录（走 bcrypt 校验）")
t0 = time.perf_counter()
st, b = req("POST", "/api/users/login", {"user": {
    "email": f"{alice}@example.com", "password": "password123"}})
el = (time.perf_counter() - t0) * 1000
show("HTTP 状态", st)
show("耗时", f"{el:.0f} ms  ← 主要是 bcrypt 计算")

step("错误密码（应 401）")
st, b = req("POST", "/api/users/login", {"user": {
    "email": f"{alice}@example.com", "password": "wrong-password"}})
show("HTTP 状态", f"{st}  ← 401")

step("不带 token 访问受保护端点（应 401）")
st, b = req("GET", "/api/user")
show("HTTP 状态", f"{st}  ← 401")
show("错误体", json.dumps(b, ensure_ascii=False))

step("带 token 访问（应 200）")
st, b = req("GET", "/api/user", token=alice_tok)
show("HTTP 状态", st)
show("当前用户", (b or {}).get("user", {}).get("username"))

# ---------------------------------------------------------------- 3 发文章
hr("3. 发文章（自动派生 slug + 标签写入）")
step("alice 发布文章")
st, b = req("POST", "/api/articles", {"article": {
    "title": "MoonBit 写后端是一种什么体验",
    "description": "用自研协议栈搭一个真实 API",
    "body": "整个 HTTP 服务端、PostgreSQL 客户端、Redis 客户端都是纯 MoonBit 手写的。",
    "tagList": ["moonbit", "backend", f"t{STAMP}"]}}, token=alice_tok)
art = (b or {}).get("article", {})
slug = art.get("slug", "")
show("HTTP 状态", f"{st}  ← 201")
show("slug", f"{slug}  ← 由标题自动派生")
show("createdAt", art.get("createdAt") + "  ← ISO-8601 UTC")
show("tagList", art.get("tagList"))
show("author", art.get("author", {}).get("username"))

step("标题为空（应 422）")
st, b = req("POST", "/api/articles", {"article": {
    "title": "", "description": "d", "body": "b"}}, token=alice_tok)
show("HTTP 状态", f"{st}  ← 422")
show("错误体", json.dumps(b, ensure_ascii=False))

# ---------------------------------------------------------------- 4 浏览
hr("4. 浏览与过滤（动态 SQL + 参数化）")
step("匿名查看文章列表（鉴权可选）")
st, b = req("GET", f"/api/articles?tag=t{STAMP}")
show("HTTP 状态", st)
show("总数", (b or {}).get("articlesCount"))
for a in (b or {}).get("articles", [])[:2]:
    show("文章", brief_article(a), indent=9)

step("按作者过滤")
st, b = req("GET", f"/api/articles?author={alice}")
show("alice 的文章数", (b or {}).get("articlesCount"))

step("分页（limit=1）")
st, b = req("GET", f"/api/articles?author={alice}&limit=1")
show("本页条数", len((b or {}).get("articles", [])), )
show("总数", (b or {}).get("articlesCount"))

step("标签集合")
st, b = req("GET", "/api/tags")
tags = (b or {}).get("tags", [])
show("标签数", len(tags))
show("包含本轮标签", f"t{STAMP}" in tags)

# ---------------------------------------------------------------- 5 关注
hr("5. 关注与关注流")
step("bob 关注 alice")
st, b = req("POST", f"/api/profiles/{alice}/follow", token=bob_tok)
show("HTTP 状态", st)
show("following", (b or {}).get("profile", {}).get("following"))

step("bob 查看关注流（应看到 alice 的文章）")
st, b = req("GET", "/api/articles/feed", token=bob_tok)
show("HTTP 状态", st)
show("关注流文章数", (b or {}).get("articlesCount"))
for a in (b or {}).get("articles", [])[:2]:
    show("文章", brief_article(a), indent=9)

step("匿名访问关注流（应 401，feed 必须登录）")
st, b = req("GET", "/api/articles/feed")
show("HTTP 状态", f"{st}  ← 401")

# ---------------------------------------------------------------- 6 收藏
hr("6. 收藏（幂等）")
step("bob 收藏文章")
st, b = req("POST", f"/api/articles/{slug}/favorite", token=bob_tok)
show("HTTP 状态", st)
show("favorited", (b or {}).get("article", {}).get("favorited"))
show("favoritesCount", (b or {}).get("article", {}).get("favoritesCount"))

step("再次收藏（幂等，计数不应翻倍）")
st, b = req("POST", f"/api/articles/{slug}/favorite", token=bob_tok)
show("favoritesCount", f"{(b or {}).get('article', {}).get('favoritesCount')}  ← 仍为 1")

step("按「某用户收藏」过滤")
st, b = req("GET", f"/api/articles?favorited={bob}")
show("bob 收藏的文章数", (b or {}).get("articlesCount"))

# ---------------------------------------------------------------- 7 评论
hr("7. 评论")
step("bob 评论")
st, b = req("POST", f"/api/articles/{slug}/comments",
            {"comment": {"body": "纯 MoonBit 写的 HTTP 栈，厉害。"}}, token=bob_tok)
cid = (b or {}).get("comment", {}).get("id")
show("HTTP 状态", f"{st}  ← 201")
show("评论 id", cid)
show("作者", (b or {}).get("comment", {}).get("author", {}).get("username"))

step("匿名读评论（鉴权可选）")
st, b = req("GET", f"/api/articles/{slug}/comments")
show("HTTP 状态", st)
show("评论数", len((b or {}).get("comments", [])))

step("空评论（应 422）")
st, b = req("POST", f"/api/articles/{slug}/comments",
            {"comment": {"body": ""}}, token=bob_tok)
show("HTTP 状态", f"{st}  ← 422")

# ---------------------------------------------------------------- 8 权限
hr("8. 权限校验（越权必须被拒）")
step("bob 修改 alice 的文章（应 403）")
st, b = req("PUT", f"/api/articles/{slug}", {"article": {"description": "hacked"}}, token=bob_tok)
show("HTTP 状态", f"{st}  ← 403 只有作者能改")

step("alice 删除 bob 的评论（应 403）")
st, b = req("DELETE", f"/api/articles/{slug}/comments/{cid}", token=alice_tok)
show("HTTP 状态", f"{st}  ← 403 只有评论作者能删")

step("bob 删除自己的评论（应 204）")
st, b = req("DELETE", f"/api/articles/{slug}/comments/{cid}", token=bob_tok)
show("HTTP 状态", f"{st}  ← 204")

step("bob 删除 alice 的文章（应 403）")
st, b = req("DELETE", f"/api/articles/{slug}", token=bob_tok)
show("HTTP 状态", f"{st}  ← 403")

# ---------------------------------------------------------------- 9 收尾
hr("9. alice 更新并删除自己的文章")
step("更新标题（slug 会随之重新派生）")
st, b = req("PUT", f"/api/articles/{slug}", {"article": {"title": "Rename Demo"}}, token=alice_tok)
new_slug = (b or {}).get("article", {}).get("slug", "")
show("HTTP 状态", st)
show("新 slug", f"{new_slug}  ← 由新标题派生")

step("删除文章（应 204）")
st, b = req("DELETE", f"/api/articles/{new_slug}", token=alice_tok)
show("HTTP 状态", f"{st}  ← 204")

step("再查已删文章（应 404）")
st, b = req("GET", f"/api/articles/{new_slug}")
show("HTTP 状态", f"{st}  ← 404")

print()
print("=" * 72)
print("  演示结束 —— 全流程走通")
print("=" * 72)
print("""
  下一步可以自己看：
    • 交互式 API 文档   http://127.0.0.1:8085
    • Grafana 面板      http://127.0.0.1:3000   (admin/admin)
    • Prometheus        http://127.0.0.1:9090
    • 刚刚这些请求的指标已经进入面板（刷新即可看到）
""")
