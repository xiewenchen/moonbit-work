# 查重与差异说明

> 依据：mooncakes.io 的 `moon search` **实测结果**（可复核，命令见文末）。
> 章程审核原则：「mooncakes.io 上当前不存在类似项目。」

## 一、查重实测结果

| 检索词 | 检出模块 | 下载量 | 它的自我介绍（原文意译） | 判定 |
|---|---|---|---|---|
| `redis` | `oboard/redis@0.2.0` | 51 | A modern, high performance **Redis client** for MoonBit | **部分重合** |
| `postgres` | `Lfan-ke/moon-postgres@0.3.0` | 127 | Pure-MoonBit **PostgreSQL wire-protocol driver** implementing `@moondb.AsyncDriver` — no C | **部分重合** |
| `http` | `mizchi/crater-browser-http@0.19.0` | 3599 | **HTTP, cache, cookie and request sandbox helpers for crater browser** | 不重合（浏览器侧工具） |
| `pg` | `mizchi/bitx_openpgp@0.48.0` | 99 | Native **OpenPGP** signature verification | 不重合（无关） |

**结论**：Redis / PostgreSQL 方向**已有同类项目**，必须逐项说明差异（下文第二节）；
**HTTP 方向未检出同类**（检出的 `crater-browser-http` 是浏览器测试工具，不是服务端实现）。

## 二、逐项差异

### 2.1 与 `oboard/redis` 的差异

| 维度 | `oboard/redis` | 本项目（`mbp/platform`） |
|---|---|---|
| 定位 | Redis **客户端库** | **三协议一体的平台**：Redis + PostgreSQL + **HTTP 服务端** |
| 协议层 | 面向使用者的 API | **独立可测的 RESP 协议层**（含嵌套深度上限、安全字节访问） |
| 之上有什么 | 无 | **应用框架层**（路由 / 中间件 / JWT / 限流）+ 工具链（迁移、压测、多进程） |

即：**它是「一个 Redis 客户端」，本项目是「包含 Redis 客户端能力在内的后端平台」。**
不是同一层的替代关系。

### 2.2 与 `Lfan-ke/moon-postgres` 的差异

| 维度 | `Lfan-ke/moon-postgres` | 本项目 |
|---|---|---|
| 抽象接口 | 实现 `@moondb.AsyncDriver` —— 面向**统一驱动接口** | 直接实现 **PostgreSQL v3 线协议**，不绑定任何 driver 抽象 |
| 认证 | 未在简介中声称 | **SCRAM-SHA-256 + MD5**（`pg/sasl.mbt`），且**迭代次数上限**防恶意服务端 CPU 挂死 |
| 类型系统 | — | `pg/types.mbt`：`Numeric(String)` **精确十进制**（金额场景不用 Double）、数组、UUID、JSON 等 |
| 事务 | — | `begin/commit/rollback/with_transaction` |
| 传输安全 | 未声称 | **SSL 请求握手**（`ssl_request()`）+ TLS 连接实测 |
| 与 Redis 的关系 | 独立驱动 | **同一平台内与 Redis 协同**（连接池共享、`with_db` / `with_redis`） |

注：`Lfan-ke/moon-postgres` 的项目名与设备声称的"pure-MoonBit, no C"方向与本项目**在精神上一致**，
但在**协议实现范围、认证覆盖、类型精度、以及"是否作为平台一部分"**上定位不同。

### 2.3 本项目独有（查重未检出的部分）

| 独有能力 | 说明 |
|---|---|
| **HTTP/1.1 服务端** | 检出的 HTTP 项目均为**客户端/浏览器侧**；本项目的 HTTP 是**服务端**：路由（含 percent-decode）、中间件链、keep-alive、超时/限额、TLS |
| **应用框架层** | `Config`(env 覆盖/校验) + `App`/`Group` + 中间件 + JWT(HS256, 手写) + 令牌桶限流 + 统一错误处理 |
| **协议层零依赖** | 协议层不依赖 native，**`wasm-gc` 目标可测**（19 个包） |
| **工具链** | SQL 迁移（幂等，按文件名升序）、压测（含 p50/p95/max）、多进程启动器 |
| **桌面 IDE** | Electron + Monaco，含 LSP 客户端、集成终端、主题系统、文件中转站 |

## 三、结论

1. Redis / PostgreSQL 方向**存在同类**，但均为**单点客户端/驱动**；本项目是**多协议平台**，
   且在这些方向上**协议实现更完整**（认证、类型精度、事务、TLS、协同）。
2. HTTP 服务端方向**未检出同类**。
3. 本项目**不与既有项目构成同层替代**：它们各自解决"如何连上某个服务"，
   本项目解决"如何用纯 MoonBit 从零搭一套后端"。

## 四、复核方式

```bash
export PATH="$HOME/.moon/bin:$PATH"
moon search redis
moon search postgres
moon search http
moon search pg
```
