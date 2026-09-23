///|
/// Conduit 服务装配：把全部端点挂到 App 上。
///
/// 端点前缀 `/api`（与 RealWorld 规范的 `servers: /api` 一致）。
///
/// ## 注册顺序很重要
///
/// 路由器按注册顺序匹配，`/api/articles/feed` 必须**先于** `/api/articles/:slug`
/// 注册，否则 `feed` 会被当成 slug。

///|
/// 把 Conduit 的全部路由挂到 `app` 上。
///
/// - `secret`：JWT 签名密钥
/// - `ttl_sec`：token 有效期（秒）
/// - `bcrypt_cost`：密码哈希成本（会被夹到 [4, 14]）
pub fn use_conduit(
  app : @app.App,
  secret : String,
  ttl_sec : UInt64,
  bcrypt_cost? : Int = 6,
) -> Unit {
  let a = app
  let auth : AuthConfig = {
    secret,
    ttl_sec,
    bcrypt_cost: clamp_bcrypt_cost(bcrypt_cost),
  }
  a.post("/api/users", async fn(req) { handle_register(a, auth, req) })
  a.post("/api/users/login", async fn(req) { handle_login(a, auth, req) })
  a.get("/api/user", async fn(req) { handle_current_user(a, auth, req) })
  a.put("/api/user", async fn(req) { handle_update_user(a, auth, req) })
  a.get("/api/profiles/:username", async fn(req) {
    handle_get_profile(a, auth, req)
  })
  a.post("/api/profiles/:username/follow", async fn(req) {
    handle_follow(a, auth, req)
  })
  a.delete("/api/profiles/:username/follow", async fn(req) {
    handle_unfollow(a, auth, req)
  })
  // feed 必须在 :slug 之前
  a.get("/api/articles/feed", async fn(req) { handle_feed(a, auth, req) })
  a.get("/api/articles", async fn(req) { handle_list_articles(a, auth, req) })
  a.post("/api/articles", async fn(req) { handle_create_article(a, auth, req) })
  a.get("/api/articles/:slug", async fn(req) {
    handle_get_article(a, auth, req)
  })
  a.put("/api/articles/:slug", async fn(req) {
    handle_update_article(a, auth, req)
  })
  a.delete("/api/articles/:slug", async fn(req) {
    handle_delete_article(a, auth, req)
  })
  a.get("/api/articles/:slug/comments", async fn(req) {
    handle_list_comments(a, auth, req)
  })
  a.post("/api/articles/:slug/comments", async fn(req) {
    handle_create_comment(a, auth, req)
  })
  a.delete("/api/articles/:slug/comments/:id", async fn(req) {
    handle_delete_comment(a, auth, req)
  })
  a.post("/api/articles/:slug/favorite", async fn(req) {
    handle_favorite(a, auth, req)
  })
  a.delete("/api/articles/:slug/favorite", async fn(req) {
    handle_unfavorite(a, auth, req)
  })
  a.get("/api/tags", async fn(req) { handle_tags(a, auth, req) })
}
