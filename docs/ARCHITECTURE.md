# 架构说明

本项目（MoonBit 后端一站式开发平台）有**两条并存的技术路径**。
理解这个区分，才能看懂代码布局。

---

## ⭐ 演示路径（Demo 当天走这条）

```
双击桌面「MoonBit IDE」
   → 底部面板「后端」→ 点「▶ 启动后端」
   → 底部面板「接口」→ 选端点 → 发送 → 看响应
   → 底部面板「输出」→ 跑 moon build / test（流式输出）
   → 底部面板「问题」→ 点诊断条目 → 跳到源码行
```

**走的是路径 A（native）**：真跑的是 `conduit` 那个 native 后端，配合 Electron IDE 的
文件树 / 编辑器 / 终端 / 面板 / 接口调试器。

**为什么演示走 A**：它是**完整且久经验证**的一条 ——
官方 hurl 套件 13/13、91 项自测、TLS/多实例/告警/备份全都跑通过。
演示要的是"稳"，不是"新"。

## 另一条路径的定位

**路径 B（MoonBit 编译到 JS + FFI）**：**技术亮点 / 未来方向**，**不作为演示主线**。

- 定位：证明"**用 MoonBit 写 IDE 后端**"这条架构成立（手册 0.1–0.4 的诉求）
- 现状：**已跑通并验证**（`ping`/`readFile`/`listDir`/`task.run` 全部正确）
- 差距：WebSocket 待装 `ws`；**未替换**现有 Electron 主进程
- 什么时候用：讲"技术纵深"时提一句 —— 同一个平台里既有 native 后端，
  也有编译到 JS 的后端，两者共用同一套 MoonBit 语言与工具链

---

## 路径 A：平台本体（native）

这是最初的目标：**用纯 MoonBit 从零重实现主流后端技术栈**，并在此之上做应用框架。

```
                     ┌────────────────────────────────────────────┐
   桌面 IDE（Electron）│  desktop/  —— 编辑器/文件树/终端/面板/调试器  │
                     └───────────────┬────────────────────────────┘
                                     │ Electron IPC
                                     ▼
                     ┌────────────────────────────────────────────┐
                     │  moon CLI（构建 / 运行 / 诊断 / 格式化）      │
                     └───────────────┬────────────────────────────┘
                                     │
     ┌───────────────────────────────┼───────────────────────────────┐
     ▼                               ▼                               ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│  http/   │  │  pg/     │  │  redis/  │  │  db/     │  │  app/    │
│ 协议+服务 │  │ v3 协议  │  │ RESP 协议 │  │ 迁移工具  │  │ 应用框架  │
└──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
     │                               │
     │        全部为 native 后端（编译成原生可执行文件）
     ▼                               ▼
┌────────────────────────────────────────────────────────────────┐
│  conduit/  —— 用上面的框架写的真实后端（RealWorld/Conduit 规范）  │
│  19 端点 · 91 项自测 · 官方 hurl 套件 13/13 · TLS/告警/备份       │
└────────────────────────────────────────────────────────────────┘
```

**特点**：`moon build --target native` → 原生二进制 → 部署在三实例 + nginx 之后。
**"用 MoonBit 写"体现在**：HTTP 服务端、PG 客户端、Redis 客户端、JWT、bcrypt 全部是自研纯 MoonBit 实现，不依赖任何第三方后端框架。

---

## 路径 B：IDE 后端（MoonBit 编译到 JS）

对应黑客松手册 0.1–0.4 的思路：**后端逻辑用 MoonBit 写，通过 FFI 调 Node.js**。

```
   ┌──────────────────────────────────────────────────────────┐
   │  ide-backend/  —— MoonBit 源码                            │
   │    ffi.mbt   extern "js" FFI → Node 的 child_process / fs │
   │    rpc.mbt   JSON-RPC 2.0 分发（纯 MoonBit 逻辑）          │
   │    demo/     预置演示项目（HTTP 服务 + 故意留的语法错误）    │
   └───────────────────────────┬──────────────────────────────┘
                               │  moon build --target js
                               ▼
                    _build/js/debug/build/ide-backend/**/*.js
                               │  node 运行
                               ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Node.js 运行时                                            │
   │    http 服务 ← FFI 起的；请求交给 MoonBit 的 handle_line  │
   │    fs / child_process ← 被 MoonBit 经 FFI 调用            │
   └──────────────────────────────────────────────────────────┘
```

**关键形态**：**逻辑留在 MoonBit**（路由、参数校验、响应组装、JSON-RPC 语义），
**只有真正碰系统的动作下到 Node**（读文件、跑命令、监听端口）。
`serve_http(port, @backend.handle_line)` 就是这种"把 MoonBit 函数回调给 Node"的写法。

**已实测**：`ping` → `pong`；`workspace.readFile` 读到真实文件；`listDir` 列出真实目录；
`task.run` 执行命令并回传 `{code, stdout, stderr}`；非法方法回 `-32601`。

### 为什么单独一个包，而不是改根 `moon.mod` 的 `preferred-target`

手册让在根 `moon.mod.json` 里加 `preferred-target: "js"`。但本模块（`mbp/platform`）
**主体是 native 的**（平台库 + conduit 后端全是 native），改了根配置会**影响现有构建**。
所以做法是：**单独建 `ide-backend/` 包并声明 `supported_targets = "js"`**，
构建时显式指定 target：`moon build ide-backend/cmd/main --target js`。目的相同、风险更低。

### 与手册的差异（如实记录）

| 手册 | 本项目 | 说明 |
|---|---|---|
| 0.4 WebSocket | **HTTP** | WebSocket 需要 Node 的 `ws` 包（要 `npm install`）；先用 Node 内置 `http` 验证整条链路 |
| Web 版前端（Monaco + xterm 在浏览器 + vite） | **Electron 桌面版** | 编辑器/终端/文件树都在 Electron 里，不是浏览器页面 |
| 后端逻辑全部走 MoonBit JS | **两条并存** | 路径 A（native 平台）是主体；路径 B 是新增并已验证的架构路径，**未替换**现有 Electron 主进程 |

---

## 目录导航

| 目录 | 属于 | 说明 |
|---|---|---|
| `http/` `pg/` `redis/` `db/` `app/` | 路径 A | 平台库（native） |
| `conduit/` | 路径 A | 用平台框架写的真实后端 + 官方 hurl 套件 |
| `deploy/` | 路径 A | 部署：nginx TLS、多实例、Prometheus、Grafana、Alertmanager、备份演练 |
| `desktop/` | 两条都用 | Electron IDE 壳 |
| `ide-backend/` | **路径 B** | 手册 0.1–0.4 的 MoonBit JS 后端 + 预置 demo |
| `kernel/` `bench/` `cluster/` | 路径 A | 工程模型 / 压测 / 多进程 |
