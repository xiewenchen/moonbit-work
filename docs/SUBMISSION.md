# MoonBit 后端开发平台 — 申报书

**赛题方向**：新生态项目建设
**模块**：`xiewenchen/moonbit-platform@0.1.0`（mooncakes.io 已发布）
**仓库**：https://github.com/xiewenchen/moonbit-work
**许可证**：Apache-2.0

## 一、项目概述

用纯 MoonBit 从零实现一套后端开发平台：**Redis / PostgreSQL 协议驱动 + HTTP/1.1 服务端 + 应用框架层 + 工具链**，共 28 个包、约 1.1 万行 MoonBit 源码。

分层：协议层（零依赖，`wasm-gc` 可测）→ 连接层（native）→ 应用框架层 → 工具链。

## 二、原创性声明（章程必填项）

本项目为**原创实现，非移植**，未复制任何开源项目的源码。

实现过程参照的公开标准与文档：

| 部分 | 参考来源 | 性质 |
|---|---|---|
| HTTP/1.1（`http/`）| RFC 7230 / 7231 / 7235 | 公开标准 |
| Redis 协议（`redis/`）| Redis 官方 RESP 协议文档 | 公开协议文档 |
| PostgreSQL 协议（`pg/`）| PostgreSQL 官方文档 Ch.55–56 | 公开协议文档 |
| SCRAM-SHA-256（`pg/sasl.mbt`）| RFC 5802 / 7677 | 公开标准 |
| JWT HS256（`app/auth.mbt`）| RFC 7515 / 7519 / 2104 | 公开标准 |

**第三方组件**（含桌面配套工具）的名称、版本、许可证与参考范围，见 `docs/ATTRIBUTION.md`；完整参考来源见 `docs/DIFFERENTIATION.md` §1.1。

## 三、三个应用场景

**1. 协议实现的教学与学习。** 对想弄清"HTTP 服务器、数据库驱动到底怎么从字节流实现出来"的人，本项目把每一层拆成可独立运行、带测试的模块（`redis/resp.mbt`、`http/http.mbt`、`pg/message.mbt`），而不是一个不可读的黑盒。

**2. 无 C 依赖的小型后端。** 需要「HTTP 服务 + 缓存 + 数据库」这一组合、又不希望引入 C 依赖的场合，可直接使用本项目，并附迁移工具、压测工具与多进程启动器。

**3. 协议实现的安全案例集。** `sec/` 提供越界与注入靶场，`docs/VULNERABILITIES.md` 记录了四轮审计中修复的 41 个真实缺陷（整数溢出致远程拒绝服务、头部注入、限流绕过、文件描述符泄漏等）及修复方式，可作为"手写协议栈常见陷阱"的案例集。

## 四、与已有项目的差异

经 mooncakes.io 实测检索，Redis、PostgreSQL、HTTP 服务端方向**均已存在同类项目**：`moonbitstack` 系列的 `mooncat`（native ASGI 服务端，含 HTTP/1.1、HTTP/2、WebSocket、HTTP/3）与 `moonapi`（类型化 web 框架，含 OpenAPI、依赖注入、OAuth2）在**功能覆盖上超过本项目**。本项目**不声称填补空白**，也**不具备** HTTP/2、HTTP/3、WebSocket、SSE、OpenAPI 等能力。

本项目可复核的差异在于**集成形态与工程验证**：

- **单模块整体交付**：1 个 `moon.mod` 含 28 个包，未按组织拆分为多个独立模块；
- **协议层零依赖且 `wasm-gc` 目标可测**（19 个包）；
- **四轮系统性安全加固**，累计修复 41 个缺陷，含 fuzz 测试；
- **通过 RealWorld 官方规范套件验证**：hurl 13 个套件 / 154 请求 / 100% 通过，3 轮可重复；
- **端到端演示**：19 个 API 端点、91 项 e2e 检查。

完整对比与复核命令见 `docs/DIFFERENTIATION.md`。

## 五、可复核的工程记录

| 项 | 数值 | 复核方式 |
|---|---|---|
| 有效 commits | 20 | `git log --oneline` |
| 自动化测试 | 156 通过 / 0 失败（native）| `moon test --target native` |
| 编译检查 | 无警告 | `moon check --deny-warn` |
| CI | GitHub Actions | 仓库 `.github/workflows/ci.yml` |
| 许可证 | Apache-2.0 | `LICENSE` |
| 设计文档 | 8 份（架构 / 安全 / 漏洞记录 / 验证 / 查重 / 归属 / 语言层 / 路线图）| `docs/` |
