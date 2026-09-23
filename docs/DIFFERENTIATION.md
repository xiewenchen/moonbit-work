# 查重与差异说明

> 全部数据来自 mooncakes.io 的 `moon view` **实测**（2026-09-23），复核命令见文末。
> 章程审核原则：「mooncakes.io 上当前不存在类似项目。」

## 一、原始材料清单与来源声明

### 1.1 参考来源（必填项）

本项目**为原创实现，非移植**。实现过程中参照的规范与文档如下：

| 部分 | 参照来源 | 性质 |
|---|---|---|
| HTTP/1.1 协议层（`http/`） | **RFC 7230 / 7231 / 7235**（报文语法、语义、认证） | 公开标准 |
| Redis 协议层（`redis/`） | **Redis 官方文档 RESP 章节**（`redis.io/docs/reference/protocol-spec`） | 公开协议文档 |
| PostgreSQL 协议层（`pg/`） | **PostgreSQL 官方文档 Chapter 55–56**（Frontend/Backend Protocol、SASL 认证） | 公开协议文档 |
| SCRAM-SHA-256 认证（`pg/sasl.mbt`） | **RFC 5802 / RFC 7677** | 公开标准 |
| JWT / HS256（`app/auth.mbt`） | **RFC 7515 / 7519**（JWS、JWT） | 公开标准 |
| HS256 的 HMAC / SHA-256 | **RFC 2104 / FIPS 180-4**（算法定义） | 公开标准 |
| 令牌桶限流（`app/guard.mbt`） | 通用算法（无特定来源） | — |
| 桌面 IDE（`desktop/`） | **Electron + Monaco Editor**（MIT）| **外部开源组件**，见 `docs/ATTRIBUTION.md` |
| 语言分析能力 | **moon-lsp**（随 MoonBit 工具链分发） | **官方组件**，见 `docs/ATTRIBUTION.md` |

**无移植代码**。所有协议实现依据上述公开标准自行编写，未复制任何开源项目的源码。
`docs/ATTRIBUTION.md` 另有完整的第三方组件清单（名称、版本、许可证、用途）。

### 1.2 本项目（发布名）

```
模块名：xiewenchen/moonbit-platform@0.1.0
仓库：  https://github.com/xiewenchen/moonbit-work
```

## 二、查重实测结果

### 2.1 单包检索命中

| 检索词 | 检出 | 下载 | 自述定位 |
|---|---|---|---|
| `redis` | `oboard/redis@0.2.0` | 51 | A modern, high performance **Redis client** for MoonBit |
| `postgres` | `Lfan-ke/moon-postgres@0.3.0` | 127 | Pure-MoonBit **PostgreSQL wire-protocol driver**（**已标记 deprecated**，迁至 `moonbitstack/moonpostgres`）|
| `pg` | `mizchi/bitx_openpgp@0.48.0` | 99 | **OpenPGP** 签名验证（与本项目方向无关）|
| `http` | `mizchi/crater-browser-http@0.19.0` | **3599** | **浏览器测试工具**（HTTP/cache/cookie sandbox helpers for crater browser）—— **下载量高但与后端实现无关** |

### 2.2 通过 `moonbitstack` 组织发现的规模化同类（**本节为原文档遗漏，特此更正**）

按组织维度核查后，发现 `moonbitstack` 已提供成体系的后端组件：

| 包 | 定位（原文意译） | 下载 |
|---|---|---|
| `moonbitstack/mooncat@0.14.4` | native **ASGI 3.0 server**（← uvicorn）| 33 |
| `moonbitstack/moonhttp@0.11.0` | HTTP/3 framing、HPACK、QPACK、WebSocket、SSE、multipart（"Bytes in, events out; no sockets"）| 239 |
| `moonbitstack/moonapi@0.13.0` | typed web framework（← FastAPI）：路由、类型提取器、OpenAPI、DI、OAuth2、CORS/gzip | 143 |
| `moonbitstack/moondb@0.2.0` | 标准数据库访问接口（← Go `database/sql`、DB-API 2.0）| 402 |
| `moonbitstack/moonpostgres@0.6.2` | PostgreSQL wire-protocol driver | 59 |

> **更正声明**：本文档早前版本称"HTTP 服务端方向未检出同类"，**该结论不成立** —— 仅按关键词检索未能覆盖以组织形式发布的系列包。现据 `moon view` 实测结果更正。

## 三、差异说明（只陈述本项目实现范围，不评价他人）

### 3.1 实现范围对照

| 能力 | 本项目 | 说明 |
|---|---|---|
| HTTP/1.1 服务端 | ✅ `http/server/` | 路由、中间件链、keep-alive、超时与限额、TLS |
| HTTP/2 · HTTP/3 · WebSocket · SSE · multipart | ❌ **未实现** | 见 3.2 |
| Redis RESP 协议 | ✅ `redis/` | 协议解析 + 连接池 + 命令层 |
| PostgreSQL v3 协议 | ✅ `pg/` | 含 SCRAM-SHA-256 / MD5 认证、SSL 请求握手、类型系统、事务 |
| 应用框架 | ✅ `app/` | Config、路由、中间件、JWT(HS256)、令牌桶限流、统一错误处理、Prometheus 指标 |
| OpenAPI / 依赖注入 / OAuth2 | ❌ **未实现** | 见 3.2 |
| 数据库迁移工具 | ✅ `db/migrate.mbt` | 按文件名升序、事务包裹、幂等 |
| 压测工具 | ✅ `bench/` | 含 p50 / p95 / max |
| 多进程启动器 | ✅ `cluster/` | `@process.run` 派生 |
| 桌面 IDE | ⚠️ `desktop/` | **Electron + JS 实现，非 MoonBit 交付物**，属配套开发工具 |

### 3.2 本项目未覆盖的能力（如实列出）

相对于 `moonbitstack` 系列，本项目**不具备**：HTTP/2、HTTP/3、QUIC、WebSocket、SSE、multipart、HPACK/QPACK、OpenAPI 文档生成、依赖注入、OAuth2、数据库访问抽象层（driver↔query 契约）。

**不声称这些方向存在空白。**

### 3.3 本项目的可验证特征

以下为本项目自身特征，均有实测记录可复核：

| 特征 | 依据 |
|---|---|
| **单模块整体交付**（1 个 `moon.mod` 含 28 个包），未经组织拆分为多个独立模块 | `moon.mod` + `moon.pkg` 结构 |
| **协议层零依赖且 `wasm-gc` 目标可测**（19 个包）| `moon test --target wasm-gc` 实测通过 |
| **已完成系统性安全审计**：累计修复 41 个缺陷（含整数溢出致远程 DoS、头部注入、限流绕过、fd 泄漏）/ **四轮加固**，含 fuzz 测试 | `docs/VULNERABILITIES.md`、`SECURITY.md` |
| **通过 RealWorld 官方规范套件验证**：hurl 13 个套件 / 154 请求 / 100% 通过，3 轮可重复 | `conduit/SPEC-COMPLIANCE.md` |
| **真实端到端演示**：19 端点、91 项 e2e、30 步演示脚本 | `conduit/` |

### 3.4 下载量观察（事实陈述）

截至 2026-09-23，上述同类项目下载量为：`oboard/redis` 51、`moonbitstack/moonpostgres` 59、`Lfan-ke/moon-postgres` 127、`moonbitstack/moonapi` 143、`moonbitstack/moonhttp` 239、`moonbitstack/mooncat` 33。

（`mizchi/crater-browser-http` 为 3599，但其定位是**浏览器测试工具**，与后端服务端实现不构成同类比较。）

## 四、结论

1. **本方向已存在成体系的同类项目**（`moonbitstack` 系列），其中 `mooncat`（ASGI 服务端）与 `moonapi`（web 框架）在功能覆盖上**超过本项目**。本项目**不声称填补空白**。
2. 本项目的差异在于**集成形态与工程验证**：单模块整体交付、`wasm-gc` 可测的协议层、四轮安全加固（41 缺陷修复记录）、RealWorld 官方套件 100% 通过。这些是**可复核的工程记录**，而非功能覆盖的优势。
3. 若评审认为上述差异不足以构成独立选题价值，**本项目接受该判断** —— 选材重合是事实，不宜以措辞掩盖。

## 五、复核方式

```bash
export PATH="$HOME/.moon/bin:$PATH"
moon search redis ; moon search postgres ; moon search http ; moon search pg
moon view oboard/redis
moon view moonbitstack/mooncat
moon view moonbitstack/moonhttp
moon view moonbitstack/moonapi
moon view moonbitstack/moondb
moon view moonbitstack/moonpostgres
moon view xiewenchen/moonbit-platform
```
