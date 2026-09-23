# MoonBit 一站式后端开发平台 — 路线图

> 决策基线（已与用户确认）：
> - **形态**：桌面 IDE（Electron/Tauri 壳 + MoonBit 内核）
> - **"兼容"含义**：用**纯 MoonBit 从零重实现**协议/引擎（不依赖 C 绑定为默认路线）
> - **首个切入点**：数据与通信（PostgreSQL + Redis + REST/HTTP）

---

## 1. 必须先知道的现实约束

这些是调研得出的硬事实，直接决定技术选型：

| 约束 | 内容 | 影响 |
|---|---|---|
| **native 后端是网络/DB 的唯一可行路径** | MoonBit 的网络栈在 `moonbitlang/async`（socket/TLS/HTTP/WebSocket），**主要支持 native 后端**；JS 后端只有 fetch 客户端，wasm-gc 无 socket | 平台的网络/DB 能力**必须**在 native 后端落地 |
| **Windows native 需要 MSVC** | `moon` 在 Windows 找 `cl.exe`/`clang-cl.exe`，**不支持 MinGW**。已装 VS 2022 Build Tools（MSVC 14.44.35207），`moon` 自动探测成功，无需手动 vcvars | ✅ 已解决 |
| **`moonbitlang/async` 标注 experimental** | API 会变动，不保证稳定 | 自研层要做适配隔离，避免大面积重写 |
| **单线程协作式运行时** | 无挂起点即原子；CPU 密集/阻塞调用会卡死全进程；用户代码单核 | 需用多进程/`spawn` 扩展吞吐 |
| **编译器许可非宽松开源** | MoonBit Public License（relaxed SSPL）：**产物可自由授权**，但修改编译器仅限非商业 | 平台建立在**编译器二进制**之上，我们自己写的全部代码独立授权，无冲突 |
| **JS 后端 IO 能力弱** | 仅 task group/timeout + fetch 客户端 | 桌面壳里跑 MoonBit 逻辑没问题，"连数据库"要交给 native 侧 |

## 2. 已有生态（避免重复造轮子 / 竞品参照）

| 领域 | 已有项目 | 备注 |
|---|---|---|
| PostgreSQL | `moonbit-community/postgres.mbt`（含连接池 pgpool、TLS） | 我们自研路线的参照物 |
| Redis | `oboard/moonbit-redis`、`Metalymph/valkey` | RESP 已有他人实现 |
| HTTP 框架 | `mizchi/mars`（Hono 风格）、`oboard/mocket` | 中间件/路由参照 |
| Web UI / SSR | `moonbit-community/rabbita`（129★，生产在用） | 桌面壳前端可选 |
| 桌面壳 | `moonbit-community/proton`（CEF 基，三平台打包） | 可替代 Tauri/Electron |
| Protobuf | `moonbitlang/protoc-gen-mbt`（官方） | gRPC 可复用 |

> 结论：**gRPC、HTML 模板引擎、MySQL 驱动、成熟 MQ 客户端、生产级框架**仍是空白，是差异化机会。

## 3. 分层架构

```
┌─────────────────────────────────────────────┐
│  UI 层（桌面壳：Tauri/Electron 或 proton）    │
│  编辑器（Monaco/CodeMirror）+ 面板             │
├─────────────────────────────────────────────┤
│  平台内核（MoonBit，本次重点）                 │
│  · 工程模型 / 构建编排（封装 moon）            │
│  · 语言服务客户端（消费 moon ide 的 JSON）     │
│  · AI/Agent 逻辑                              │
├─────────────────────────────────────────────┤
│  兼容层 / 自研引擎（MoonBit）                  │
│  · mbp/redis  · mbp/pg  · mbp/http  · ...     │
├─────────────────────────────────────────────┤
│  基础运行时                                   │
│  moonbitlang/async（socket/TLS/HTTP）+ core    │
└─────────────────────────────────────────────┘
```

## 4. 兼容层矩阵（每个方向选两个最主流）

| 方向 | 首选 | 次选 | 我们的模块名 |
|---|---|---|---|
| 数据缓存 | Redis | Valkey | `mbp/redis` |
| 关系型数据库 | PostgreSQL | MySQL | `mbp/pg` |
| API 风格 | RESTful/HTTP | gRPC | `mbp/http` |
| 消息队列 | Kafka | RabbitMQ | `mbp/mq` |
| 对象存储 | S3 兼容 | MinIO | `mbp/objstore` |
| 可观测 | Prometheus | — | `mbp/metrics` |

（首批只做 Redis + PostgreSQL + HTTP，其余按需。）

## 5. 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** 环境 | native 后端打通（装 MSVC）；`moon test --target native` 可跑 | ✅ **已完成** |
| **M1a** Redis 协议 | RESP2 编解码（纯逻辑，wasm-gc 可测） | ✅ **已完成**（11 tests） |
| **M1b** Redis 连接 | 基于 `async/socket` 的连接、发命令、收响应 | ✅ **已完成**（真连 Docker Redis，集成测试通过） |
| **M1c** Redis 命令层 | `GET/SET/DEL/EXPIRE` 等类型化 API + 连接池 | ✅ **已完成** |
| **M2** HTTP/REST | HTTP/1.1 协议 + 服务端路由（:param/中间件）+ 客户端 | ✅ **已完成** |
| **M3** PostgreSQL | v3 协议 + trust/cleartext/MD5/SCRAM 认证 + 简单/扩展查询 + 类型化解码 | ✅ **已完成** |
| **M4** 平台内核 | 工程模型 + `moon` 编排 + `moon ide` 客户端 | ✅ **已完成（雏形）** |
| **M6** 应用框架层 | `Config`/`App`/`Group`：路由+连接池+DB/缓存便捷+健康检查；附 notes 示例服务 | ✅ **已完成** |
| **M5** 桌面壳 | Electron + Monaco（窗口/编辑器/运行 moon 命令） | ✅ **已完成（骨架）** |

## 6. 当前进度（代码资产）

```
moonbit-platform/            # 模块 mbp/platform
├── redis/                   # 纯协议层（零依赖，wasm-gc 可测）
│   ├── resp.mbt             # RESP2 编解码（enum Resp + encode/decode）
│   ├── resp_test.mbt        # 11 个测试
│   └── moon.pkg
├── redis/client/            # 连接层（依赖 async，仅 native）
│   ├── client.mbt           # Client::connect/command/ping/set/get/del + RESP 收发
│   ├── commands.mbt         # exists/expire/ttl/incr/hset/hget/hgetall/lpush/lrange/keys
│   ├── pool.mbt             # 连接池（Semaphore 限流 + 空闲复用 + run 助手）
│   ├── *_test.mbt           # 8 个集成测试（连 Docker Redis）
│   └── moon.pkg             # supported_targets = "native"
├── http/                    # 纯协议层（零依赖，wasm-gc 可测）
│   ├── http.mbt             # HTTP/1.1 解析/序列化 + Method/状态码 + param()/json()
│   └── http_test.mbt        # 5 个测试
├── http/server/             # 服务端 + 路由（仅 native）
│   ├── server.mbt           # Router（:param 路由 + 中间件）+ serve / serve_connection
│   ├── server_test.mbt      # 3 个集成测试（含 socket echo 冒烟）
│   └── route_test.mbt       # 2 个路由参数/中间件测试
├── http/client/             # 客户端（仅 native，keep-alive 复用）
│   ├── client.mbt           # Client::connect/get/post/send
│   └── client_test.mbt      # 1 个集成测试（连自研 server）
├── pg/                      # 纯协议层（零依赖，wasm-gc 可测）
│   ├── message.mbt          # v3 前端消息（startup/query/parse/bind/execute）+ 后端消息解析
│   ├── sasl.mbt             # SCRAM-SHA-256 / MD5 认证算法（PBKDF2/HMAC/SHA-256）
│   ├── types.mbt            # 文本值按类型 OID 解码（bool/int/float/text/...）
│   ├── message_test.mbt     # 15 个测试
│   ├── sasl_test.mbt        # 4 个测试（RFC 7677 官方向量）
│   └── types_test.mbt       # 4 个测试
├── pg/client/               # 客户端（仅 native）
│   ├── pg_client.mbt        # connect（trust/cleartext/md5/scram）/ query / query_params / exec
│   ├── client_test.mbt      # 7 个集成测试（连 Docker PG）
│   ├── auth_test.mbt        # 3 个认证集成测试（scram/md5/错误密码）
│   └── typed_test.mbt       # 1 个类型化取值测试
├── kernel/                  # 平台内核雏形（仅 native）
│   ├── kernel.mbt           # find_module + moon 编排（check/build/test/fmt）+ moon ide 客户端
│   └── kernel_test.mbt      # 4 个集成测试
├── demo/                    # 集成示例：HTTP + Redis + PostgreSQL 串成一个服务
│   ├── app.mbt              # /health /visits(Redis INCR) /users(PG) 路由
│   ├── demo_test.mbt        # 1 个端到端测试
│   └── cmd/main/            # executable 入口（监听 127.0.0.1:8080）
├── app/                     # 应用框架层（仅 native）：把兼容层封装成「写后端更省事」的一层
│   └── app.mbt              # Config(from_env) / App / Group：路由注册+中间件+PG/Redis 连接池+健康检查
├── notes/                   # 用框架写的示例后端服务
│   ├── app.mbt              # /notes CRUD（PG）+ /stats（Redis 计数）
│   ├── notes_test.mbt       # 1 个端到端测试
│   └── cmd/main/            # executable 入口
├── desktop/                 # 桌面 IDE 壳（Electron + Monaco，Node 项目，非 moon 包）
│   ├── main.js / preload.js / index.html / renderer.js
│   └── package.json
└── cmd/main/                # 骨架 main
```

验证命令：
```bash
moon test  --target wasm-gc     # 协议层，跨后端可测（39/39）
moon test  --target native      # 含真实 Redis/PG/HTTP/内核 + demo/notes 端到端（70/70）
moon check --deny-warn

# 集成测试需要本机 Redis 与 PostgreSQL：
docker run -d --name mbp-redis -p 6379:6379 redis:7-alpine
docker run -d --name mbp-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=mbptest -e POSTGRES_USER=mbp -p 55432:5432 postgres:16-alpine
# 认证测试用（SCRAM / MD5）：
docker run -d --name mbp-pg-scram -e POSTGRES_PASSWORD=secret \
  -e POSTGRES_DB=mbptest -e POSTGRES_USER=mbp -p 55434:5432 postgres:16-alpine
docker run -d --name mbp-pg-md5 -e POSTGRES_HOST_AUTH_METHOD=md5 \
  -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=mbptest -e POSTGRES_USER=mbp \
  -p 55433:5432 postgres:16-alpine

# 运行集成 demo 服务（HTTP + Redis + PG）：
moon run --target native demo/cmd/main   # 监听 127.0.0.1:8080

# 运行「用框架写的」示例服务（notes）：
moon run --target native notes/cmd/main  # 监听 127.0.0.1:8080（MBP_PORT 可改）

# 启动桌面 IDE 壳：
cd desktop && npm install && npm start
```

## 7. 主要风险

1. **native 工具链缺失**（M0）：Windows 上不装 MSVC 就跑不了任何网络/DB 代码。
2. **async API 不稳定**：需在兼容层内做薄适配，隔离上游变更。
3. **单线程模型**：高并发场景要设计多进程/`spawn` 方案。
4. **重造轮子成本**：Redis/PG 已有社区实现，自研的价值在于"可控 + 一体化 + 教学/可扩展"，需明确边界。
5. **平台层工作量巨大**：IDE 内核 + 桌面壳是另一个量级，建议内核与兼容层解耦推进。

---

## 生产加固（阶段 1–6，全部完成）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 网络层 | 读/空闲超时、请求头/体上限（431/413）、URL percent-decode + query、chunked 请求体、优雅关闭（SIGINT/SIGTERM） | ✅（优雅关闭受 Windows `accept` 不可取消限制） |
| 2 传输安全 | HTTPS 服务端（Windows schannel / 其他 OpenSSL）、PG `SSLRequest`（实测 `ssl='t'`）、Redis TLS | ✅ |
| 3 数据层 | PG 事务（begin/commit/rollback/with_transaction）、连接健康检查 + 失效重连 + 查询超时、类型解码（numeric 精确十进制 / 时间 / uuid / json / 数组） | ✅ |
| 4 框架件套 | 结构化 JSON 日志 + `X-Request-Id`、Prometheus 指标端点、JWT 鉴权 + bcrypt 密码哈希、令牌桶限流 + 输入校验 + 统一错误处理 | ✅ |
| 5 运维 | 配置校验、`/ready` 就绪探针（探测 PG/Redis）、Dockerfile + GitHub Actions CI、SQL 迁移工具、并发压测 | ✅（Docker/CI 未在本机验证——本机 apt 源超时） |
| 6 并发 | 多进程 `spawn_workers`、单进程多监听 `serve_ports` | ✅（Windows 进程优雅退出受限） |

**新增模块**：`app/`（应用框架层）、`db/`（SQL 迁移）、`bench/`（并发压测）、`cluster/`（并发模型）。

**测试**：`moon test --target native` **112/112**；`moon test --target wasm-gc` **50/50**；`moon check --deny-warn` 干净。

**已知未验证项**：Docker 镜像构建、CI 流水线（本机网络受限，需在有外网的环境确认）。
