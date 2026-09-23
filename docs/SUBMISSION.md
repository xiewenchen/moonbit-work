# MoonBit 后端开发平台 — 申报书

**项目方向**：新生态项目建设
**通用性说明**：协议层（HTTP / Redis / PostgreSQL）与 JWT、令牌桶限流属于跨语言通用技术栈 —— 本项目的实现方式、测试组织方法（协议层零依赖、`wasm-gc` 目标可测）、安全审计流程（四轮加固 + fuzz）**不绑定 MoonBit**，可迁移到其他语言的协议实现；应用框架层设计（路由、中间件、限流）同样与语言无关。
**模块**：`xiewenchen/moonbit-platform@0.1.0`（mooncakes.io 已发布）　**许可证**：Apache-2.0
**仓库**：https://github.com/xiewenchen/moonbit-work

## 一、项目简介

用纯 MoonBit 从零实现一套后端开发平台，共 28 个包、约 1.1 万行 MoonBit 源码。分层：协议层（零依赖，`wasm-gc` 可测）→ 连接层（native）→ 应用框架层 → 工具链。

## 二、拟实现的核心功能（章程必填项）

- **HTTP/1.1 服务端**：路由（含 percent-decode）、中间件链、keep-alive、超时与请求限额、TLS
- **Redis 客户端**：RESP 协议解析、连接池、命令层
- **PostgreSQL v3 线协议**：SCRAM-SHA-256 / MD5 认证、SSL 请求握手、`Numeric` 精确十进制、事务
- **应用框架层**：Config（环境变量覆盖 + 校验）、Router、JWT(HS256)、令牌桶限流、Prometheus 指标
- **工具链**：SQL 迁移（幂等、事务包裹）、压测（p50/p95/max）、多进程启动器

## 三、原创性声明（章程必填项）

本项目为**原创实现，非移植**，未复制任何开源项目的源码。实现参照的公开标准：**RFC 7230 / 7231 / 7235**（HTTP）、**Redis 官方 RESP 协议文档**、**PostgreSQL 官方文档 Ch.55–56**、**RFC 5802 / 7677**（SCRAM）、**RFC 7515 / 7519 / 2104**（JWS/JWT/HMAC）。

**第三方组件**：桌面工具使用 Electron + Monaco Editor（外部开源组件）；语言分析通过**进程间通信调用**官方 `moon-lsp` 可执行文件（编解码自行实现），**未嵌入或复制其代码**。完整清单见 `docs/ATTRIBUTION.md`，参考来源全文见 `docs/DIFFERENTIATION.md` §1.1。

## 四、三个使用场景

**1. 想理解 HTTP 服务端实现的人。** 手上有 RFC 却看不到字节如何变成请求对象；打开 `http/http.mbt` 逐行对照 RFC、运行自带测试（看 `Content-Length` 如何解析、chunked 边界如何防溢出）；**得到的是一个能拆开看的协议实现，不是黑盒。**

**2. 做内部工具的后端开发者。** 需要「HTTP 服务 + 缓存 + 数据库」又不想为小服务引入 C 依赖；起服务、连 Redis 与 PG、用 `db/migrate.mbt` 管表结构、用 `bench/` 压测；**得到的是一套无 C 依赖、单模块可交付的小型后端。**

**3. 刚写完第一版协议栈的安全工程师。** 想知道手写 HTTP 容易踩哪些坑；读 `docs/VULNERABILITIES.md` 的审计记录（含远程拒绝服务崩溃、CPU 挂死、注入、资源泄漏等逐条修复过程），再用 `sec/` 靶场与 `attack.py`（14 个小节、18 项断言，覆盖请求走私、大小限制绕过、鉴权绕过、头注入、慢速攻击、JSON 深嵌套 DoS）实测修复效果；**得到的是一本真实失败案例集，而不是教科书。**

## 五、与已有项目的差异

经 mooncakes.io 实测检索，Redis、PostgreSQL、HTTP 服务端方向**均已存在同类项目**，且 `moonbitstack` 系列覆盖更多（涵盖 HTTP/2、HTTP/3、WebSocket、OpenAPI 等）。本项目不具备这些能力，**不声称填补空白**。

**那为什么还要做？——用途不同，不是"更小的 moonbitstack"。**

- **它面向生产级服务端**，追求协议与功能完备；
- **本项目面向可读、可测、可审计的教学与安全场景**：每一层拆成能独立运行、能逐行讲解的模块，并附带四轮安全审计的完整记录与可运行的攻击靶场。

支撑事实：**协议层零依赖且 `wasm-gc` 目标可测**（19 个包）；**四轮系统性安全加固，缺陷与修复过程在 `docs/VULNERABILITIES.md` 中逐条可查**（含 fuzz）；**通过 RealWorld 官方规范套件**（hurl 13 套件 / 154 请求 / 100% 通过，3 轮可重复）。完整对比与复核命令见 `docs/DIFFERENTIATION.md`。

## 六、可复核的工程记录

| 项 | 数值 | 复核命令 |
|---|---|---|
| 有效 commits | **20 余个**（章程要求 ≥10）| `git log --oneline \| wc -l` |
| 自动化测试 | 156 通过 / 0 失败（native）| `moon test --target native` |
| 编译检查 | 无警告 | `moon check --deny-warn` |
| CI | GitHub Actions | 仓库 `.github/workflows/ci.yml` |
| 许可证 | Apache-2.0 | `LICENSE` |
| 设计文档 | **8 份**（架构 / 安全 / 漏洞记录 / 验证 / 查重 / 归属 / 语言层 / 路线图；另有本申报书）| `docs/` |
