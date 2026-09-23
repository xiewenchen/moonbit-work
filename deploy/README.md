# Conduit 部署指南

用 **moonbit-platform** 实现并部署 GitHub 上最标准的跨语言后端基准项目
[**RealWorld / Conduit**](https://github.com/gothinkster/realworld)（MIT 许可）。

本目录提供**本机多实例 + 容器化 PG/Redis/Nginx** 的完整部署方案。

---

## 1. 目标项目

| 项目 | 说明 |
|---|---|
| 上游规范 | [`gothinkster/realworld`](https://github.com/gothinkster/realworld) 的 `specs/api/openapi.yml` |
| 端点 | **19 个**（用户/鉴权、Profile/关注、文章、评论、收藏、标签） |
| 鉴权 | JWT，`Authorization: Token <jwt>` |
| 数据 | PostgreSQL 7 张表 |
| 实现 | 纯 MoonBit，基于本平台的 `app` 框架（路由 / JWT / 限流 / 指标 / PG / Redis） |

> 说明：平台的运行时只执行 MoonBit 代码，因此"用本平台部署这个开源项目"
> 的含义是**按它的 API 规范实现它，再把它部署起来**——这正是本目录的产物。

---

## 2. 架构

```
   客户端 ──:8090──▶ ┌──────────────────────────────┐
   (HTTP 301 跳转)   │  nginx (Docker 容器)          │
   客户端 ──:8443──▶ │  TLS 终止 + 轮询负载均衡       │
                     └──────────────┬───────────────┘
                                   │ host.docker.internal
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
      ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
      │ conduit :8101│    │ conduit :8102│    │ conduit :8103│   3 个 native 进程
      │  (~10 MB)    │    │  (~10 MB)    │    │  (~10 MB)    │   共享同一份后端
      └───────┬──────┘    └───────┬──────┘    └───────┬──────┘
              └────────────────────┼────────────────────┘
                                   ▼
                 ┌─────────────────────────────────────┐
                 │ PostgreSQL :55432 (conduitdb)        │  Docker 容器
                 │ Redis      :6379                     │
                 └─────────────────────────────────────┘
                          ▲
                          │ 每 5s 抓取 /metrics
                 ┌────────┴────────────┐        ┌─────────────────────┐
                 │ Prometheus :9090    │───────▶│ Alertmanager :9093 │──▶ 通知渠道
                 │ + 10 条告警规则      │  告警   │ 路由/分组/抑制       │   (webhook/邮件/IM)
                 └─────────────────────┘        └─────────────────────┘
                          ▲
                          │ 面板查询
                 ┌────────┴────────────┐        ┌─────────────────────┐
                 │ Grafana :3000       │        │ Swagger UI :8085    │
                 │ 面板/数据源自动挂载  │        │ 交互式 API 文档      │
                 └─────────────────────┘        └─────────────────────┘
```

**为什么用多进程而不是多线程**：平台的服务端是单线程协作式调度，
且 Windows/IOCP 下 `accept()` 不响应任务取消（已在源码注释标注）。
横向扩展用**多进程 + 反向代理**是当前工程现实下正确的做法。

---

## 3. 快速开始

### 3.0 一键启动（推荐）

```bash
./deploy/demo-up.sh          # 幂等：拉起全部组件并自检
python conduit/demo.py       # 跑一遍完整业务流程
```

`demo-up.sh` 会拉起：3 个后端实例、nginx(TLS)、PG、Redis、Prometheus、
Alertmanager、Grafana、Swagger UI、告警接收端，最后逐项自检并打印访问入口。

以下是分步说明。

### 3.1 前置

- MoonBit 工具链（`moon`）
- Docker（用于 PG / Redis / Nginx）
- 本机需要能访问镜像仓库；若拉取超时，见 [§6 踩坑](#6-部署踩坑与解法)

### 3.2 准备后端容器

```bash
# PostgreSQL（本机 5432 可能已被占用，这里用 55432）
docker run -d --name mbp-pg -p 55432:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_USER=mbp -e POSTGRES_PASSWORD=mbp -e POSTGRES_DB=mbptest \
  postgres:16-alpine

# Redis
docker run -d --name mbp-redis -p 6379:6379 redis:7-alpine
```

> **必须为 Conduit 建独立数据库**，不要复用其他服务的库：
> ```bash
> docker exec mbp-pg psql -U mbp -d mbptest -c "CREATE DATABASE conduitdb OWNER mbp;"
> ```
> 原因见 [§6.2](#62-同名表冲突让迁移静默失效)。

### 3.3 构建并启动实例

```bash
# 编译 release 二进制
moon build --target native --release

# 启动 3 个实例（端口 8101/8102/8103）
MBP_JWT_SECRET='请改成足够长的随机串' ./deploy/start-cluster.sh
```

### 3.4 启动 nginx 负载均衡

```bash
docker rm -f mbp-nginx 2>/dev/null
docker run -d --name mbp-nginx -p 8090:8090 \
  -v "$(pwd)/deploy/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx:alpine
```

Linux 上还需让容器能访问宿主机端口：

```bash
docker run -d --name mbp-nginx -p 8090:8090 \
  --add-host=host.docker.internal:host-gateway \
  -v "$(pwd)/deploy/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx:alpine
```

### 3.5 验收

```bash
# 完整 API 验收（86 项断言，走 nginx —— 与真实客户端同一条路径）
python conduit/e2e.py http://127.0.0.1:8090

# 压测
python deploy/loadtest.py http://127.0.0.1:8090 6000 48

# 停止
./deploy/stop-cluster.sh && docker rm -f mbp-nginx
```

---

## 4. 环境变量

沿用平台的 `MBP_` 前缀。

| 变量 | 默认 | 说明 |
|---|---|---|
| `MBP_HOST` / `MBP_PORT` | `0.0.0.0` / `8080` | 监听地址 |
| `MBP_PG_HOST` / `MBP_PG_PORT` | `127.0.0.1` / `5432` | PostgreSQL |
| `MBP_PG_USER` / `MBP_PG_PASSWORD` / `MBP_PG_DB` | — / — / — | **`MBP_PG_DB` 必须指向专用库**（如 `conduitdb`） |
| `MBP_REDIS_HOST` / `MBP_REDIS_PORT` | `127.0.0.1` / `6379` | Redis |
| `MBP_JWT_SECRET` | 开发默认值 | **生产必须设置**；未设置时启动会告警 |
| `MBP_JWT_TTL_SEC` | `604800` | token 有效期（7 天） |
| `MBP_RATE_LIMIT` | `50` | 每秒令牌数（压测时可调大） |
| `MBP_TRUST_PROXY` | `0` | 置 `1` 时按 `X-Forwarded-For` 限流。**仅在确实位于可信代理之后才可开启**，否则攻击者可伪造该头绕过限流 |
| `MBP_CORS_ORIGINS` | 空（**不开放跨域**） | 允许的跨域来源，逗号分隔，如 `https://app.example.com,https://admin.example.com`；`*` 表示放开所有来源 |
| `MBP_BCRYPT_COST` | `6` | bcrypt 成本因子，自动夹到 `[4, 14]` |
| `MBP_MAX_CONNECTIONS` | `64` | 并发连接上限，超出直接关闭。默认值来自容量标定（见 §5.8） |

---

## 5. 实测结果

### 5.1 API 验收（HTTPS）

经 nginx 的 TLS 端口执行 `conduit/e2e.py`：

```
结果：91 通过, 0 失败 / 共 91 项
```

覆盖全部 19 个端点与 `401 / 403 / 404 / 409 / 422` 分支、CORS 白名单、`/health`、`/metrics`。

### 5.2 TLS 终止

| 验证 | 结果 |
|---|---|
| HTTP `:8090` | `301` → `https://127.0.0.1:8443/...` |
| HTTPS `:8443` | `/health` → `ok`；`/api/tags` → JSON |
| 协商协议 | **TLSv1.3**，套件 `TLS_AES_256_GCM_SHA384` |
| 安全响应头 | `Strict-Transport-Security` / `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` |

### 5.3 CORS 白名单

配置 `MBP_CORS_ORIGINS=https://app.example.com,https://admin.example.com` 后：

| 场景 | 结果 |
|---|---|
| 白名单来源的预检 | `204` + 回显 `Access-Control-Allow-Origin` |
| **非白名单来源的预检** | `204` 但**不下发** CORS 头（浏览器自行拦截） |
| 白名单来源的实际请求 | 带 `Access-Control-Allow-Origin` + `Vary: Origin` |
| **非白名单来源的实际请求** | **不带** CORS 头 |

> 此前实现无条件返回 `*`，等于任意网站都能用受害者浏览器调用本 API —— 已改为默认不开放。

### 5.4 Prometheus 采集

3 个实例各作为一个 target 被采集（聚合交给 PromQL，而非在应用内跨进程合并）：

```
host.docker.internal:8101  health=up
host.docker.internal:8102  health=up
host.docker.internal:8103  health=up
```

实际查询验证（`/api/v1/query`）：

| 查询 | 结果 |
|---|---|
| `sum by(instance)(http_requests_count)` | 8101→31，8102→33，8103→33 |
| `sum(http_requests_count)` | 97（跨实例聚合） |
| `sum by(status)(http_requests_total)` | 200→63，401→7，404→8，409→1，422→5 |
| 时间序列总数 | 40 条 |

### 5.5 负载均衡验证

通过 nginx 发 30 个请求，读取各实例自己的 `/metrics` 计数：

```
:8101  +10   :8102  +12   :8103  +11    → 3/3 实例均分到流量
```

### 5.6 长稳压测

3 轮 × 6000 请求 @ 48 并发，经 nginx：

| 轮次 | 成功/失败 | 吞吐 | p50 | p95 | p99 | 实例内存 |
|---|---|---|---|---|---|---|
| 1 | 6000 / **0** | 903 req/s | 45.9 ms | 88.7 ms | 126.5 ms | 9.6 / 10.5 / 9.7 MB |
| 2 | 6000 / **0** | 916 req/s | 46.8 ms | 84.0 ms | 103.4 ms | 9.7 / 10.6 / 9.7 MB |
| 3 | 6000 / **0** | 969 req/s | 44.1 ms | 77.7 ms | 104.4 ms | 9.7 / 10.6 / 9.7 MB |

**累计 18000 请求零失败；内存波动 < 100 KB，无泄漏迹象。**

### 5.7 bcrypt 对事件循环的阻塞（实测）

平台的 async 是**单线程协作式**，而 bcrypt 是纯 CPU 工作，哈希期间整个事件循环被占用。

| 场景 | 结果 |
|---|---|
| 空闲时 `/health` | p50 13.9 ms |
| 单次登录（走 bcrypt） | **37 ms** |
| 8 并发登录墙钟 | 114 ms（平均 14.3 ms/个） |
| 20 并发登录风暴期间的 `/health` | p50 14.3 ms / **p95 53.1 ms / max 121.5 ms** |

**结论**：登录风暴会把其他请求的 p95 抬大约 4–5 倍（但未超时）。
单线程下无法根治，因此采取：**成本可配置**（`MBP_BCRYPT_COST`，夹到 `[4, 14]`）+ **多实例横向扩展**。
彻底方案（CPU 密集任务移出事件循环，如子进程哈希池）列为未来工作。

### 5.8 单实例容量标定（限流与并发上限的依据）

`deploy/capacity.py` 对**单实例**逐级加压（每档 2000 请求，零失败）：

| 并发 | QPS | p50 | p95 | p99 |
|---|---|---|---|---|
| 1 | 87 | 5.4 ms | 27.6 ms | 29.2 ms |
| 8 | 960 | 5.1 ms | 25.1 ms | 29.0 ms |
| **32** | **1225** ← 峰值 | 25.4 ms | 32.3 ms | 37.5 ms |
| 64 | 1201 | 53.0 ms | 59.7 ms | 61.4 ms |
| 128 | 1155 | 107.8 ms | 122.6 ms | 124.1 ms |

**拐点在并发 32**：再往上 QPS 反降、延迟线性上升 —— 说明多进来的请求只在排队。

据此确定两个**不同性质**的限制（此前混淆，已分开）：

| 机制 | 作用 | 取值依据 | 配置 |
|---|---|---|---|
| **按客户端限流** | 防单个客户端滥用 | 业务合理峰值（与服务器容量无关） | `MBP_RATE_LIMIT` |
| **并发连接上限** | 防服务器过载（排队导致尾延迟雪崩） | 容量标定的拐点 | `MBP_MAX_CONNECTIONS`（默认 64 = 拐点 32 的 2 倍缓冲） |

> 修复记录：`max_connections` 原先**硬编码为 1024** —— 远高于实测拐点 32，
> 意味着允许大量连接排队、把尾延迟拖垮，且部署方无法调整。现已提为可配置项。

限流机制本身也已验证：`MBP_RATE_LIMIT=2` 下 12 个突发请求 →
**3×200 + 9×429**，且 429 带 `Retry-After: 1`。

### 5.9 Prometheus 告警规则

`deploy/alerting_rules.yml` 共 **10 条**规则 / 4 组：

| 组 | 规则 |
|---|---|
| availability | `InstanceDown`、`AllInstancesDown`、`CapacityReduced` |
| errors | `High5xxRate`(>2%)、`Any5xx` |
| latency | `HighP95Latency`(>500ms)、`HighP99Latency`(>1000ms)、`SlowRequests` |
| traffic | `RateLimitTriggered`、`TrafficDropped` |

延迟告警一律走 `histogram_quantile`（**不用平均值** —— 平均值会被长尾掩盖）。

**告警生命周期实测**（故意停掉全部实例）：

```
停实例后   → ConduitInstanceDown ×3 (pending) + AllInstancesDown (pending)
达到 for   → ConduitAllInstancesDown → firing
恢复实例后 → 告警自动消除
```

> 修复记录：原先 `/metrics` **只有 `_sum` 和 `_count`，没有直方图桶**，
> 导致 `histogram_quantile` 不可用、延迟告警只能靠平均值。
> 已补齐标准直方图（`_bucket{le=...}`），实测可算出 p50/p95/p99。

### 5.10 Grafana 面板

`deploy/grafana/` 通过 provisioning 自动挂载数据源与面板（无需手工配置）。

**实测**：Grafana v13.2.2，数据源 `Prometheus → http://host.docker.internal:9090` 自动就绪，
面板「Conduit 服务概览」(uid=`conduit-overview`) 自动加载；
经 Grafana 数据源代理查询验证：总吞吐 1.327 req/s、p95 4.114 ms、3 个实例可达性均为 1。

面板含：请求速率（按实例）、延迟分位（p50/p95/p99）、5xx 错误率、
状态码分布、实例可达性、总吞吐。

### 5.11 备份 / 恢复演练

`deploy/backup-restore-drill.sh` —— **真的 DROP 一张表再恢复**，而不是只写备份命令：

| 步骤 | 结果 |
|---|---|
| 备份前指纹 | `users=20 articles=6 comments=0 tags=6 tables=8` |
| `pg_dump` | 16311 字节 |
| `DROP TABLE comments CASCADE` | API `/articles/:slug/comments` → **404**（破坏生效）|
| 从备份恢复 | `psql < dump` |
| 恢复后指纹 | `users=20 articles=6 comments=0 tags=6 tables=8` —— **完全一致** |
| 业务恢复 | `/api/tags` → **200** |

### 5.12 Alertmanager 告警投递（端到端验证）

配置：`deploy/alertmanager.yml` —— 按 severity 分级路由、按 `alertname+instance` 分组、
三条抑制规则；接收器为 webhook（便于本机验证，生产替换为真实通道）。

**验证方法**：启动 `deploy/alert-receiver.py` 作为接收端，然后**故意停掉全部实例**，
观察告警是否真的被推送出来（而不是只看 UI）。

接收端实际收到的内容：

```
[20:44:58] TEST      共 0 条                           ← 连通性测试
[20:46:53] FIRING    共 1 条  group=ConduitAllInstancesDown
           - ConduitAllInstancesDown  severity=critical
             Conduit 全部实例不可用
[20:51:53] RESOLVED  共 1 条  group=ConduitAllInstancesDown
           - ConduitAllInstancesDown  severity=critical
             Conduit 全部实例不可用
```

| 观察点 | 说明 |
|---|---|
| FIRING → 投递耗时 | 约 75s（含 `for: 30s` + 评估周期 + `group_wait: 5s`） |
| RESOLVED → 投递耗时 | 约 140s（受 `group_interval: 5m` 约束） |
| FIRING 与 RESOLVED 间隔 | **恰好 5 分钟** = 配置的 `group_interval` |
| **只投递 1 条而非 4 条** | **抑制规则生效** —— 3 条 `ConduitInstanceDown` 被 `AllInstancesDown` 抑制 |

最后一点是关键：一个根因故障往往衍生出一堆告警，不抑制的话值班人会被淹没。
这里 `AllInstancesDown`（根因）成功抑制了 3 条 `InstanceDown`（衍生）。

**未做**：真实通知渠道（邮件/IM）未接入，`receivers` 里只有 webhook；
没有静默（silence）的运维流程演练。

### 5.13 API 文档（OpenAPI）

`conduit/openapi.yml` —— **12 条路径 / 19 个操作**（delete 4、get 7、post 6、put 2），
与 `app.mbt` 里实际注册的路由**逐一对齐**，不是一份漂亮的空文档。

已校验：`openapi` 版本、`servers`、`securitySchemes` 齐全；
全部 `$ref` 指向的 schema 均有定义（无悬空引用）。

### 5.14 中文标题的 slug（一个被演示揪出来的真缺陷）

跑完整业务流程演示时发现：中文标题的 slug 严重退化。

| 标题 | 修复前 slug | 修复后 slug |
|---|---|---|
| 纯中文标题没有任何英文 | **`article`**（硬编码兜底）| `纯中文标题没有任何英文` |
| MoonBit 写后端是一种什么体验 | `moonbit`（信息基本丢失）| `moonbit-写后端是一种什么体验` |
| 重构：把协议层从业务里剥出来 | `article` | `重构-把协议层从业务里剥出来` |

原因：`slugify` 只保留 ASCII，中文全被当分隔符丢弃。

**修复涉及两处**（第二处才是致命的）：

1. `slugify` 保留非 ASCII 字符（并排除 CJK/全角标点、限制长度 60）；
2. **`Router::dispatch` 对路径段做 percent-decode** ——
   否则 `GET /api/articles/%E5%86%99...` 拿到的参数是**编码形式**，
   与数据库里存的原始中文对不上，**中文 slug 会 100% 返回 404**。

> 注意 `plus_as_space=false`：路径里 `+` 是字面加号，只有 query string 里 `+` 才是空格。

修复后实测：5 个中文/特殊字符标题的 slug **往返全部成功**（`GET` 回读标题一致）。
单测见 `conduit/slugs_test.mbt`（4 个用例，含中文保留、标点排除、长度上限）。

### 5.15 一键启动与演示脚本

| 脚本 | 作用 |
|---|---|
| `deploy/demo-up.sh` | 幂等拉起全部组件 + 逐项自检 + 打印访问入口 |
| `conduit/demo.py` | 完整业务流程：注册 → 登录 → 发文章 → 浏览 → 关注 → 关注流 → 收藏 → 评论 → 权限校验 → 更新/删除（30 步） |
| `conduit/e2e.py` | 91 项验收断言 |
| `deploy/loadtest.py` / `capacity.py` | 压测 / 容量标定 |
| `deploy/backup-restore-drill.sh` | 备份恢复演练 |
| `deploy/alert-receiver.py` | 告警接收端（验证投递） |

## 6. 部署踩坑与解法

这些是本次部署中**真实遇到并修复**的问题，记录下来避免重复踩。

### 6.1 nginx 镜像拉不动

`docker.io` 直连被拒（`connectex: No connection could be made... actively refused`）。

**解法**：改用可用镜像源并重打标签。

```bash
docker pull docker.m.daocloud.io/library/nginx:alpine
docker tag docker.m.daocloud.io/library/nginx:alpine nginx:alpine
```

### 6.2 同名表冲突让迁移静默失效

`CREATE TABLE IF NOT EXISTS users` 遇到库里**已存在但结构不同**的 `users` 表时
会**静默跳过**，随后所有查询 500，报错却是
`column "email" of relation "users" does not exist` —— 极难定位。

**解法（两层）**：

1. **每个服务用独立数据库**（本次从 `mbptest` 切到 `conduitdb`）；
2. 启动时做 **schema 自检**（`conduit/schema.mbt`）：逐列核对
   `information_schema.columns`，缺失则打印明确原因并退出，而不是让每个请求都 500。

### 6.3 `$1` 占位符数量不匹配

列表端点的计数查询 `SELECT count(*) ...` 本身用不到 viewer 参数，
但只要参数数组里带了它，PostgreSQL 就要求语句里出现 `$1`，否则报
`bind message supplies 1 parameters, but prepared statement requires 0`。

**解法**：在 WHERE 里显式引用 `$1`，给一个恒真且类型明确的比较
（`WHERE ($1::text = $1::text)`），同时便于后续过滤从 `$2` 编号。

### 6.4 异常被静默吞掉导致无法排障

`Router::dispatch` 原先用 `catch { _ => 500 }` 丢弃了异常信息，
线上只看到 500 却无从下手。

**解法**：改为打印异常后再返回 500（`http/server/server.mbt`）。
这是**可观测性**问题，不是功能问题，但排查成本极高。

### 6.5 Windows 下 `nohup` 重定向失效

在 Git Bash 下 `nohup app.exe > log 2>&1 &` 的日志文件可能为空，
无法靠日志判断实例状态。

**解法**：改用实例自身的 **`/metrics` 端点**做验证
（既确认实例存活，又验证了流量分发）。

---

## 7. 生产环境注意事项

以下条目**未在本机验证**，上线前请自行确认：

- **JWT 密钥**：`MBP_JWT_SECRET` 必须设置为足够长的随机串；当前默认值是开发用的。
- **证书**：`deploy/certs/` 里是**自签证书**，仅用于本机验证。
  生产必须换成受信任证书（如 Let's Encrypt），并补 `ssl_trusted_certificate` 与 OCSP stapling。
- **密码哈希**：默认 `cost=6`（纯 MoonBit 实现比原生慢约 10 倍）。
  生产建议换原生 bcrypt/argon2 并把成本提到 10+，同时把 CPU 密集任务移出事件循环。
- **告警渠道**：Alertmanager 已接入并验证端到端投递，但接收器是**webhook**
  （本机验证用）。生产需换成真实渠道（邮件 / Slack / 钉钉 / PagerDuty），
  并配置值班轮值与静默（silence）流程。
- **备份**：演练证明「dump+恢复」可用，但**没有自动定时备份**、没有异地留存、
  没有保留策略。生产需接入 `pg_dump` 定时任务 + 对象存储。
- **数据库备份 / 连接池容量**：未做容量规划与备份演练。
- **限流阈值**：当前 `MBP_RATE_LIMIT=50`，未按真实流量压测标定。
- **长稳**：本机 3 轮 × 6000 请求已验证；**数天级**的长稳未做。

---

## 8. 文件说明

| 文件 | 作用 |
|---|---|
| `deploy/nginx.conf` | nginx 负载均衡配置（upstream + 转发真实 IP） |
| `deploy/start-cluster.sh` | 启动多实例并等待就绪 |
| `deploy/stop-cluster.sh` | 停止全部实例 |
| `deploy/loadtest.py` | 混合读写压测（吞吐/延迟/失败率） |
| `conduit/` | Conduit API 实现（19 端点） |
| `conduit/migrations/0001_conduit.sql` | 7 张表的数据模型 |
| `conduit/e2e.py` | 86 项端到端验收脚本 |
| `Dockerfile` | 应用镜像（多阶段构建 + 非 root 运行） |
