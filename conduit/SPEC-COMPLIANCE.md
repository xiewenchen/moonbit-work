# 与官方规范的兼容性报告

本文件记录 **conduit 实现** 对 [RealWorld / Conduit 官方规范](https://github.com/realworld-apps/realworld) 的兼容性验证结果。

## 测试来源：第三方，不是自测自过

用的是官方仓库里的 **hurl 测试套件**（`specs/api/hurl/`，13 个文件）：

```
articles.hurl                 errors_articles.hurl          pagination.hurl
auth.hurl                     errors_auth.hurl              profiles.hurl
comments.hurl                 errors_authorization.hurl     tags.hurl
favorites.hurl                errors_comments.hurl
feed.hurl                     errors_profiles.hurl
```

`hurl` 是 Orange 开源的命令行 HTTP 测试工具（Rust 写的），由官方仓库提供运行脚本
`specs/api/run-api-tests-hurl.sh`。

> **为什么这件事重要**：在这之前我用的是自己写的 `conduit/e2e.py`（91 项）。
> 自己写的测试只能验证「我以为对的东西」，**照不到我没想到的地方**。
> 换成官方套件后，第一次跑就暴露了 **7 个真实的规范不符**。

## 结果

| 阶段 | 通过文件 | 通过率 | 请求数 |
|---|---|---|---|
| 首次运行（官方套件） | 4 / 13 | 30.8% | 69 |
| 修复后 | **13 / 13** | **100%** | 154 |

**可重复性**：换全新空库连跑 3 轮，每轮均为 **13/13（100%）**、154 个请求全绿。

```
Executed files:    13
Executed requests: 154
Succeeded files:   13 (100.0%)
Failed files:      0 (0.0%)
Duration:          925 ms
```

## 首次运行暴露的 7 个真缺陷（全部已修）

这些是我自己写的测试**完全没覆盖到**的：

| # | 症状（官方断言） | 我的实际行为 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | `$.articles[0].body` **not exists** | 返回了 body | 列表接口与单篇接口共用了同一套字段 | `article_from_row` 加 `include_body`，列表传 `false`；**字段必须不存在，不是 null** |
| 2 | `$.errors.token[0] == "is missing"` | `is missing or invalid` | 错误消息带了多余措辞 | `unauthorized()` 改为精确的 `is missing` |
| 3 | `$.errors.credentials[0] == "invalid"` | `none`（字段名不对）| 用了 `email or password` 这个字段名 | 新增 `bad_credentials()` → `credentials: ["invalid"]` |
| 4 | `$.errors.article[0] == "forbidden"` | `none` | 403 统一用 `resource` 字段 | `forbidden(resource)` 按资源类型传 `article` / `comment` |
| 5 | `PUT /user` 传 `bio: ""` → `$.user.bio == null` | 返回 `""` | 空串直接入库 | SQL 改 `NULLIF($6, '')`，空串归一为 NULL |
| 6 | `PUT /user` 传 `email: null` / `username: null` → **422** | 200 | `get_str` 把 `null` 当成「未提供该字段」**静默忽略**了 | 改用 `get_opt_str` 区分「未提供」与「显式 null」；显式 null 一律 422 |
| 7 | `DELETE /articles/unknown-slug/comments/99999` → `$.errors.article[0] == "not found"` | `none` | 一条 SQL 同时约束文章与评论，无法区分二者 | 先校验文章存在（报 `article`），再校验评论（报 `comment`）—— 客户端需要能区分 |

### 补充：同一类问题还有一处

`PUT /articles/:slug` 传 `tagList: null` 也应 **422**（缺陷 6 的同型问题），
为此新增了 `get_opt_strs`（区分「缺失 / 显式 null / 有值」的数组读取器）。

## 修复后的行为契约（官方规范要求）

错误响应统一为 `{"errors":{"<字段>":["<消息>"]}}`，字段名与消息**必须精确匹配**：

| 场景 | 字段 | 消息 |
|---|---|---|
| 未提供 token | `token` | `is missing` |
| 登录凭据错误 | `credentials` | `invalid` |
| 文章不存在 | `article` | `not found` |
| 文章越权 | `article` | `forbidden` |
| 评论不存在 | `comment` | `not found` |
| 评论越权 | `comment` | `forbidden` |
| Profile 不存在 | `profile` | `not found` |
| 必填字段为空 | 字段名 | `can't be blank` |
| email / username 重复 | 字段名 | `has already been taken` |

**列表接口不返回 `body`**（`GET /api/articles`、`/api/articles/feed`、`?favorited=` 等），
只有单篇 `GET /api/articles/:slug` 才含正文 —— 列表只给摘要。

**必填字段显式传 `null` 一律 422**，不能当成「未提供该字段」忽略；
而 `bio` / `image` 本身可空，显式 `null` 是合法输入（表示清空）。

## 如何复现

```bash
# 1) 取官方套件（已内置在 conduit/specs-hurl/，也可重新下载）
#    来源：https://github.com/realworld-apps/realworld/tree/main/specs/api/hurl

# 2) 取 hurl 工具（Windows x64 免安装）
curl -sSL -o tools/hurl.zip \
  https://github.com/Orange-OpenSource/hurl/releases/download/8.0.1/hurl-8.0.1-x86_64-pc-windows-msvc.zip
powershell -Command "Expand-Archive tools/hurl.zip -DestinationPath tools/hurl -Force"

# 3) 起一个**干净的**实例（务必用独立空库：官方套件之间共享状态）
docker exec mbp-pg psql -U mbp -d postgres -c "DROP DATABASE IF EXISTS conduithurl;"
docker exec mbp-pg psql -U mbp -d postgres -c "CREATE DATABASE conduithurl OWNER mbp;"
MBP_PORT=8110 MBP_PG_DB=conduithurl ... ./_build/native/release/build/conduit/cmd/main/main.exe &

# 4) 跑官方套件
tools/hurl/hurl.exe --test --jobs 1 \
  --variable "host=http://127.0.0.1:8110" \
  --variable "uid=$(date +%s)" \
  conduit/specs-hurl/*.hurl
```

或直接用封装脚本：`./conduit/run-hurl-tests.sh`

> **注意**：官方套件要求**干净的数据库**。它们之间有状态耦合
> （例如先建文章再验证列表计数），复用同一个库会让后跑的文件被前面的数据污染 ——
> 我最初就是这样误判了 `articles.hurl` 与 `errors_auth.hurl`（单独跑通过、连跑失败）。

## 仍未覆盖的部分

官方 hurl 套件只测 **REST API 的行为**，不覆盖：

- **并发/竞态**（如同一 username 并发注册）—— 我们的 `ON CONFLICT DO NOTHING` 是为此设计的，但官方套件不测
- **鉴权安全性**（JWT 篡改、过期、alg 混淆）—— 属于我们自己 `app/auth.mbt` 的职责
- **限流、CORS、TLS**—— 平台层能力，与 Conduit 规范无关
- **性能与容量**—— 见 `deploy/README.md` 的容量标定
- **浏览器端的 e2e**（官方另有 `specs/e2e/*.spec.ts`，是 Playwright 测前端 SPA 的，与本后端实现无关）
