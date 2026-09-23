# MoonBit 后端开发平台 — 申报书

**项目方向**：新生态项目建设
**通用性说明**：协议层（HTTP / Redis / PostgreSQL）与 JWT、令牌桶限流属于跨语言通用技术栈 —— 本项目的实现方式、测试组织方法（协议层零依赖、`wasm-gc` 目标可测）、安全审计流程（四轮加固 + fuzz）**不绑定 MoonBit**，可迁移到其他语言的协议实现；应用框架层的设计（路由、中间件、限流）同样与语言无关。
**模块**：`xiewenchen/moonbit-platform@0.1.0`（mooncakes.io 已发布）
**仓库**：https://github.com/xiewenchen/moonbit-work　**许可证**：Apache-2.0

## 一、项目概述

用纯 MoonBit 从零实现一套后端开发平台：**Redis / PostgreSQL 协议驱动 + HTTP/1.1 服务端 + 应用框架层 + 工具链**，共 28 个包、约 1.1 万行 MoonBit 源码。分层：协议层（零依赖，`wasm-gc` 可测）→ 连接层（native）→ 应用框架层 → 工具链。

## 二、原创性声明（章程必填项）

本项目为**原创实现，非移植**，未复制任何开源项目的源码。

实现过程参照的公开标准与文档：

| 部分 | 参考来源 |
|---|---|
| HTTP/1.1（`http/`）| RFC 7230 / 7231 / 7235 |
| Redis 协议（`redis/`）| Redis 官方 RESP 协议文档 |
| PostgreSQL 协议（`pg/`）| PostgreSQL 官方文档 Ch.55–56 |
| SCRAM-SHA-256（`pg/sasl.mbt`）| RFC 5802 / 7677 |
| JWT HS256（`app/auth.mbt`）| RFC 7515 / 7519 / 2104 |

**第三方组件**：桌面配套工具使用 Electron + Monaco Editor（外部开源组件），语言分析能力通过**进程间通信调用**官方 `moon-lsp` 可执行文件（stdio + LSP 帧，编解码为自行实现），**未嵌入或复制其代码**。完整清单（名称、版本、许可证、用途）见 `docs/ATTRIBUTION.md`；参考来源全文见 `docs/DIFFERENTIATION.md` §1.1。

## 三、三个应用场景

**1. 想理解 HTTP 服务端实现的人。** 他手上有 RFC 7230 和现成框架，却看不到字节怎么变成请求对象。打开 `http/http.mbt`，他逐行对照 RFC，运行自带测试，看 `Content-Length` 如何解析、chunked 边界如何防溢出。**得到的是一个能拆开看的协议实现，不是黑盒。**

**2. 做内部工具的后端开发者。** 需要「HTTP 服务 + 缓存 + 数据库」，又不想为一个小服务引入 C 依赖（跨平台编译麻烦）。他用本项目起服务、连 Redis 与 PG，用 `db/migrate.mbt` 管表结构，用 `bench/` 压测。**得到的是一套无 C 依赖、单模块可交付的小型后端。**

**3. 刚写完第一版协议栈的安全工程师。** 他想知道"手写 HTTP 容易踩哪些坑"。读 `docs/VULNERABILITIES.md` 的 41 条记录，对照 `sec/` 靶场逐个复现（整数溢出致远程拒绝服务、头部注入、chunked 溢出、限流绕过）。**得到的是一本真实失败案例集，而不是教科书。**

## 四、与已有项目的差异

经 mooncakes.io 实测检索，Redis、PostgreSQL、HTTP 服务端方向**均已存在同类项目**，且 `moonbitstack` 系列在功能覆盖上更多（`mooncat` 含 HTTP/2、HTTP/3、WebSocket；`moonapi` 含 OpenAPI、依赖注入、OAuth2）。本项目不具备这些能力，**不声称填补空白**。

**那为什么还要做？——用途不同，不是"更小的 moonbitstack"。**

- **它面向生产级服务端**，追求协议与功能完备；
- **本项目面向可读、可测、可审计的教学与安全场景**：每一层拆成能独立运行、能逐行讲解的模块，并附带 41 个真实缺陷的修复记录与靶场。

可复核的支撑事实：

- **单模块整体交付**：1 个 `moon.mod` 含 28 个包，未拆分为多个独立模块；
- **协议层零依赖、`wasm-gc` 目标可测**（19 个包）；
- **四轮系统性安全加固**，修复 41 个缺陷（含 fuzz 测试），记录可查；
- **通过 RealWorld 官方规范套件**：hurl 13 套件 / 154 请求 / 100% 通过，3 轮可重复。

完整对比与复核命令见 `docs/DIFFERENTIATION.md`。

## 五、可复核的工程记录

| 项 | 数值 | 复核命令 |
|---|---|---|
| 有效 commits | **21** | `git log --oneline \| wc -l` |
| 自动化测试 | 156 通过 / 0 失败（native）| `moon test --target native` |
| 编译检查 | 无警告 | `moon check --deny-warn` |
| CI | GitHub Actions | 仓库 `.github/workflows/ci.yml` |
| 许可证 | Apache-2.0 | `LICENSE` |
| 设计文档 | 9 份（架构 / 安全 / 漏洞记录 / 验证 / 查重 / 归属 / 语言层 / 路线图 / 申报）| `docs/` |
