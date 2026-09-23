///|
/// Conduit 文章端点。
///
///   GET    /articles                   → 200 {articles,articlesCount}（鉴权可选，支持 tag/author/favorited/offset/limit）
///   GET    /articles/feed              → 200 {articles,articlesCount}（需鉴权，仅关注的人）
///   POST   /articles                   → 201 {article} / 401 / 422 / 409
///   GET    /articles/:slug             → 200 {article} / 404（鉴权可选）
///   PUT    /articles/:slug             → 200 {article} / 401 / 403 / 404
///   DELETE /articles/:slug             → 204 / 401 / 403 / 404
///   POST   /articles/:slug/favorite    → 200 {article} / 401 / 404
///   DELETE /articles/:slug/favorite    → 200 {article} / 401 / 404

///|
/// ISO-8601 UTC 时间表达式（Conduit 要求 `2016-02-18T03:22:56.637Z`）。
const TS_CREATED : String = "to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at"

///|
const TS_UPDATED : String = "to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at"

///|
/// 文章行的统一 SELECT 前缀。约定 `$1` = 观察者用户 id（空串表示匿名）。
///
/// 列顺序：0 slug, 1 title, 2 description, 3 body, 4 created_at, 5 updated_at,
/// 6 username, 7 bio, 8 image, 9 favorited, 10 favorites_count, 11 author_following, 12 tag_list
const ARTICLE_COLS : String = "SELECT a.slug, a.title, a.description, a.body, " +
  TS_CREATED +
  ", " +
  TS_UPDATED +
  ", u.username, u.bio, u.image, " +
  "CASE WHEN $1 = '' THEN false ELSE EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = NULLIF($1, '')::int AND f.article_id = a.id) END AS favorited, " +
  "(SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count, " +
  "CASE WHEN $1 = '' THEN false ELSE EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = NULLIF($1, '')::int AND fo.following_id = a.author_id) END AS author_following, " +
  "COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM article_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.article_id = a.id), ARRAY[]::text[]) AS tag_list " +
  "FROM articles a JOIN users u ON u.id = a.author_id"

///|
/// 一行文章 → Conduit `article` JSON。
///
/// `include_body`：**列表接口不返回 `body`**（官方规范用 `not exists` 断言，
/// 即字段必须不存在，而不是 null）—— 列表只给摘要，正文要靠单篇接口取。
pub fn article_from_row(
  rows : @pgclient.QueryResult,
  row : Int,
  include_body? : Bool = true,
) -> Json {
  // tag_list 是 text[]，解码为 ArrayValue
  let tags : Array[Json] = match rows.value(row, 12) {
    @pg.Value::ArrayValue(arr) =>
      arr.map(fn(v) {
        match v {
          @pg.Value::Str(s) => Json::string(s)
          _ => Json::string("")
        }
      })
    _ => []
  }
  let base : Array[(String, Json)] = [
    ("slug", jstr(rows.text(row, 0).unwrap_or(""))),
    ("title", jstr(rows.text(row, 1).unwrap_or(""))),
    ("description", jstr(rows.text(row, 2).unwrap_or(""))),
  ]
  if include_body {
    base.push(("body", jstr(rows.text(row, 3).unwrap_or(""))))
  }
  let fields : Array[(String, Json)] = base
  fields.push(("tagList", Json::array(tags)))
  fields.push(("createdAt", jstr(rows.text(row, 4).unwrap_or(""))))
  fields.push(("updatedAt", jstr(rows.text(row, 5).unwrap_or(""))))
  fields.push(("favorited", jbool(rows.bool(row, 9).unwrap_or(false))))
  fields.push(("favoritesCount", jnum64(rows.int(row, 10).unwrap_or(0L))))
  fields.push((
    "author",
    profile_json(
      rows.text(row, 6).unwrap_or(""),
      rows.text(row, 7),
      rows.text(row, 8),
      rows.bool(row, 11).unwrap_or(false),
    ),
  ))
  jobj(fields)
}

///|
/// 单文章响应体。
fn single_article(
  rows : @pgclient.QueryResult,
  row : Int,
  status : Int,
) -> @http.Response {
  @http.Response::json(
    status,
    jobj([("article", article_from_row(rows, row))]).stringify(),
  )
}

///|
/// 把标签数组写入 tags / article_tags（幂等）。
async fn set_article_tags(
  a : @app.App,
  article_id : Int,
  tags : Array[String],
) -> Unit {
  // 先清空再写入，支持「替换」语义
  let _ = a.query("DELETE FROM article_tags WHERE article_id = $1::int", [
    Some(article_id.to_string()),
  ])
  for name in tags {
    let trimmed = name.trim().to_owned()
    if trimmed == "" {
      continue
    }
    let _ = a.query(
      "INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
      [Some(trimmed)],
    )
    let _ = a.query(
      "INSERT INTO article_tags (article_id, tag_id) SELECT $1::int, id FROM tags WHERE name = $2 ON CONFLICT DO NOTHING",
      [Some(article_id.to_string()), Some(trimmed)],
    )
  }
}

///|
/// 生成唯一 slug：先试 `slugify(title)`，冲突则加哈希后缀。
async fn unique_slug(a : @app.App, title : String) -> String {
  let base = slugify(title)
  let hit = a.query("SELECT 1 FROM articles WHERE slug = $1", [Some(base)])
  if hit.rows.length() == 0 {
    return base
  }
  // 加基于标题+时间的后缀，最多试 5 次
  let seed_base = base + @env.now().to_string()
  for i = 0; i < 5; i = i + 1 {
    let cand = slug_with_suffix(base, short_salt(seed_base + i.to_string()))
    let hit2 = a.query("SELECT 1 FROM articles WHERE slug = $1", [Some(cand)])
    if hit2.rows.length() == 0 {
      return cand
    }
  }
  slug_with_suffix(base, short_salt(seed_base + "last"))
}

///|
/// 分页参数：offset（默认 0）、limit（默认 20，上限 100）。
fn page_params(req : @http.Request) -> (Int, Int) {
  let offset = match req.query("offset") {
    Some(s) => parse_nonneg_int(s).unwrap_or(0)
    None => 0
  }
  let limit = match req.query("limit") {
    Some(s) =>
      match parse_nonneg_int(s) {
        Some(n) => if n > 100 { 100 } else if n == 0 { 20 } else { n }
        None => 20
      }
    None => 20
  }
  (offset, limit)
}

///|
/// 列表查询：`/articles` 与 `/articles/feed` 共用。
///
/// `feed_only` 为 true 时只返回关注作者的文章（需登录）。
async fn list_articles(
  a : @app.App,
  viewer : String,
  req : @http.Request,
  feed_only : Bool,
) -> @http.Response {
  let (offset, limit) = page_params(req)
  // 参数从 $2 开始（$1 固定为 viewer）
  let params : Array[String?] = [Some(viewer)]
  // JOIN 子句与 WHERE 片段按需拼接；全部走参数化占位符，无字符串拼接注入
  let mut joins = ""
  // 注意：这里必须显式引用 `$1`。
  // 计数查询（`SELECT count(*) ...`）本身不需要 viewer，但只要参数数组里带了它，
  // PostgreSQL 就会要求语句里出现 $1 —— 否则报
  // 「bind message supplies 1 parameters, but prepared statement requires 0」
  // 或「could not determine data type of parameter $1」。
  // 加一个恒真且类型明确的比较，既满足占位符要求又便于后续过滤从 $2 编号。
  let mut cond = " WHERE ($1::text = $1::text)"
  if feed_only {
    joins = joins +
      " JOIN follows fo ON fo.following_id = a.author_id AND fo.follower_id = $2::int"
    params.push(Some(viewer))
    cond = cond + ""
  } else {
    // tag 过滤
    match req.query("tag") {
      Some(tag) =>
        if tag != "" {
          let n = params.length() + 1
          cond = cond +
            " AND a.id IN (SELECT at3.article_id FROM article_tags at3 JOIN tags t3 ON t3.id = at3.tag_id WHERE t3.name = $" +
            n.to_string() +
            ")"
          params.push(Some(tag))
        }
      None => ()
    }
    // author 过滤
    match req.query("author") {
      Some(author) =>
        if author != "" {
          let n = params.length() + 1
          cond = cond + " AND u.username = $" + n.to_string()
          params.push(Some(author))
        }
      None => ()
    }
    // favorited 过滤（某用户收藏的文章）
    match req.query("favorited") {
      Some(fav) =>
        if fav != "" {
          let n = params.length() + 1
          cond = cond +
            " AND a.id IN (SELECT f2.article_id FROM favorites f2 JOIN users u2 ON u2.id = f2.user_id WHERE u2.username = $" +
            n.to_string() +
            ")"
          params.push(Some(fav))
        }
      None => ()
    }
  }
  // 计数
  let count_sql = "SELECT count(*) FROM articles a JOIN users u ON u.id = a.author_id" +
    joins +
    cond
  let total = a.query(count_sql, params)
  let count = total.int(0, 0).unwrap_or(0L).to_int()
  // 取数据
  let n_limit = params.length() + 1
  let n_offset = params.length() + 2
  let data_sql = ARTICLE_COLS +
    joins +
    cond +
    " ORDER BY a.created_at DESC, a.id DESC LIMIT $" +
    n_limit.to_string() +
    " OFFSET $" +
    n_offset.to_string()
  let page_params_push : Array[String?] = []
  for p in params {
    page_params_push.push(p)
  }
  page_params_push.push(Some(limit.to_string()))
  page_params_push.push(Some(offset.to_string()))
  let rows = a.query(data_sql, page_params_push)
  let items : Array[Json] = []
  for i = 0; i < rows.rows.length(); i = i + 1 {
    // 列表不返回 body（官方规范用 `not exists` 断言，字段必须不存在）
    items.push(article_from_row(rows, i, include_body=false))
  }
  @http.Response::json(
    200,
    jobj([("articles", Json::array(items)), ("articlesCount", jnum(count))]).stringify(),
  )
}

///|
/// GET /articles
pub async fn handle_list_articles(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let viewer = match user_id_of(auth, req) {
    Some(id) => id.to_string()
    None => ""
  }
  list_articles(a, viewer, req, false)
}

///|
/// GET /articles/feed（需登录）
pub async fn handle_feed(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  list_articles(a, me.to_string(), req, true)
}

///|
/// POST /articles
pub async fn handle_create_article(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let body = unwrap_obj(req.text(), "article")
  // 必填字段显式传 null 一律 422（不能当成"未提供"）
  for f in ["title", "description", "body"] {
    match get_opt_str(body, f) {
      Some(None) => return unprocessable(f, "can't be null")
      _ => ()
    }
  }
  let title = get_str(body, "title").unwrap_or("")
  let description = get_str(body, "description").unwrap_or("")
  let content = get_str(body, "body").unwrap_or("")
  let tags = get_strs(body, "tagList").unwrap_or([])
  if title == "" {
    return unprocessable("title", "can't be blank")
  }
  if description == "" {
    return unprocessable("description", "can't be blank")
  }
  if content == "" {
    return unprocessable("body", "can't be blank")
  }
  let slug = unique_slug(a, title)
  let ins = a.query(
    "INSERT INTO articles (slug, title, description, body, author_id) VALUES ($1, $2, $3, $4, $5::int) RETURNING id",
    [
      Some(slug),
      Some(title),
      Some(description),
      Some(content),
      Some(me.to_string()),
    ],
  )
  if ins.rows.length() == 0 {
    return err_resp(500, "could not create article")
  }
  let article_id = ins.int(0, 0).unwrap_or(0L).to_int()
  set_article_tags(a, article_id, tags)
  let rows = a.query(ARTICLE_COLS + " WHERE a.slug = $2", [
    Some(me.to_string()),
    Some(slug),
  ])
  single_article(rows, 0, 201)
}

///|
/// GET /articles/:slug
pub async fn handle_get_article(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let slug = match req.param("slug") {
    Some(s) => s
    None => return not_found("article")
  }
  let viewer = match user_id_of(auth, req) {
    Some(id) => id.to_string()
    None => ""
  }
  let rows = a.query(ARTICLE_COLS + " WHERE a.slug = $2", [
    Some(viewer),
    Some(slug),
  ])
  if rows.rows.length() == 0 {
    return not_found("article")
  }
  single_article(rows, 0, 200)
}

///|
/// 取文章的 id 与作者 id（用于权限判断）。
async fn article_owner(a : @app.App, slug : String) -> (Int, Int)? {
  let rows = a.query("SELECT id, author_id FROM articles WHERE slug = $1", [
    Some(slug),
  ])
  if rows.rows.length() == 0 {
    return None
  }
  Some(
    (
      rows.int(0, 0).unwrap_or(0L).to_int(),
      rows.int(0, 1).unwrap_or(0L).to_int(),
    ),
  )
}

///|
/// PUT /articles/:slug
pub async fn handle_update_article(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let slug = match req.param("slug") {
    Some(s) => s
    None => return not_found("article")
  }
  let (article_id, author_id) = match article_owner(a, slug) {
    Some(v) => v
    None => return not_found("article")
  }
  if author_id != me {
    return forbidden("article")
  }
  let body = unwrap_obj(req.text(), "article")
  let new_title = get_str(body, "title")
  let new_desc = get_str(body, "description")
  let new_body = get_str(body, "body")
  // tagList 显式传 null 要 422（官方测试专门覆盖）
  let new_tags : Array[String]? = match get_opt_strs(body, "tagList") {
    Some(Some(arr)) => Some(arr)
    Some(None) => return unprocessable("tagList", "can't be null")
    None => None
  }
  // title 变了就要重算 slug（Conduit 语义）
  let new_slug = match new_title {
    Some(t) =>
      if t == "" {
        return unprocessable("title", "can't be blank")
      } else {
        let s = unique_slug(a, t)
        Some(s)
      }
    None => None
  }
  let upd = a.query(
    "UPDATE articles SET " +
    "slug = COALESCE($2, slug), " +
    "title = COALESCE($3, title), " +
    "description = COALESCE($4, description), " +
    "body = COALESCE($5, body), " +
    "updated_at = now() " +
    "WHERE id = $1::int RETURNING id",
    [Some(article_id.to_string()), new_slug, new_title, new_desc, new_body],
  )
  if upd.rows.length() == 0 {
    return not_found("article")
  }
  match new_tags {
    Some(ts) => set_article_tags(a, article_id, ts)
    None => ()
  }
  // 重新查（slug 可能已变）
  let final_slug = match new_slug {
    Some(s) => s
    None => slug
  }
  let rows = a.query(ARTICLE_COLS + " WHERE a.slug = $2", [
    Some(me.to_string()),
    Some(final_slug),
  ])
  single_article(rows, 0, 200)
}

///|
/// DELETE /articles/:slug
pub async fn handle_delete_article(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let slug = match req.param("slug") {
    Some(s) => s
    None => return not_found("article")
  }
  let (article_id, author_id) = match article_owner(a, slug) {
    Some(v) => v
    None => return not_found("article")
  }
  if author_id != me {
    return forbidden("article")
  }
  let _ = a.query("DELETE FROM articles WHERE id = $1::int", [
    Some(article_id.to_string()),
  ])
  no_content()
}

///|
/// 收藏 / 取消收藏的公共实现。
async fn set_favorite(
  a : @app.App,
  me : Int,
  slug : String,
  on : Bool,
) -> @http.Response {
  let (article_id, _author) = match article_owner(a, slug) {
    Some(v) => v
    None => return not_found("article")
  }
  if on {
    let _ = a.query(
      "INSERT INTO favorites (user_id, article_id) VALUES ($1::int, $2::int) ON CONFLICT DO NOTHING",
      [Some(me.to_string()), Some(article_id.to_string())],
    )
  } else {
    let _ = a.query(
      "DELETE FROM favorites WHERE user_id = $1::int AND article_id = $2::int",
      [Some(me.to_string()), Some(article_id.to_string())],
    )
  }
  let rows = a.query(ARTICLE_COLS + " WHERE a.slug = $2", [
    Some(me.to_string()),
    Some(slug),
  ])
  if rows.rows.length() == 0 {
    return not_found("article")
  }
  single_article(rows, 0, 200)
}

///|
/// POST /articles/:slug/favorite
pub async fn handle_favorite(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let slug = match req.param("slug") {
    Some(s) => s
    None => return not_found("article")
  }
  set_favorite(a, me, slug, true)
}

///|
/// DELETE /articles/:slug/favorite
pub async fn handle_unfavorite(
  a : @app.App,
  auth : AuthConfig,
  req : @http.Request,
) -> @http.Response {
  let me = match require_user_id(auth, req) {
    Ok(v) => v
    Err(r) => return r
  }
  let slug = match req.param("slug") {
    Some(s) => s
    None => return not_found("article")
  }
  set_favorite(a, me, slug, false)
}
