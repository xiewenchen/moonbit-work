# P14：Backend 深度融合

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P14-01～12 完成**；`test-backend-context` **41/0**、`verify-agent-tools` **31/0**

清单对这一段的要求是：**利用你已有的真正 MoonBit 后端技术栈，而不是再造协议**。
所以这一批没有新增任何协议/服务，只是把已经存在的后端能力**接到 IDE 与 Agent 上**。

## 做了什么

| 任务 | 做法 |
|---|---|
| P14-01 | `backend-context.js`：在 ProjectContext 上加 `backendLike / port / health / database / redis / commands` |
| P14-02～05 | 一键 Build / Run / Stop 沿用既有 `backend:*` IPC 与命令表（`project.build/run/stop`） |
| P14-06 | **新增 `backend:health`**：一键健康检查，顺手把 PG/Redis 依赖状态一起带回（P14-09/10） |
| P14-07～08 | API Debug / 日志沿用既有 `api-debug.js` 与 `backend:log` 事件流 |
| P14-09～10 | PG / Redis 状态来自 `docker ps`（`mbp-pg` / `mbp-redis`），**查不到就说查不到**（`known:false`） |
| P14-11 | Agent 调后端命令：沿用执行表（build/test/run/stop/health/apiRequest），**一律经命令表** |
| P14-12 | **新增只读工具 `backendStatus`**（第 8 个只读工具）：读健康/端口/PG/Redis |

## 两条"不猜"的原则

1. **端口推不出就是 `null`**，而且每一步都记 `portSource`（`explicit` / `runCommand` / `buildCommand` / `default` / `unknown`）。
   界面上"为什么是 8080"因此是**能回答**的。
2. **没探过活就不假定健康**：`health` 为 `null` 而不是 `{ok:true}`；依赖同理（`database`/`redis` 为 `null` 而不是 `ok`）。

顺带：**不把 `:` 当端口**。`127.0.0.1:8123` 与 `12:30` 长得太像，硬抽会把时间也当端口 ——
要拼 URL 用 `healthUrl()`，那是**从已知端口构造**，不是从文本猜。

## review 抓到的问题（都修了）

1. **两份实现漂移**（should-fix）。`backend:health` 与 Agent 的 `backendStatus` 各写了一遍编排，
   行为已经不一致：Agent 那份**不返回 `body`**、`port` 写死、而且 `latencyMs` 把 `docker ps`
   的耗时也算进去了 —— **同一个字段名，两份语义**。
   → 抽成 `backend.js` 导出的 `buildHealthReport()`，两条路径**共用唯一实现**（`latencyMs` 只计探测本身）。
2. **`hasDocker` 没有超时**：docker CLI 挂住的话上层会**无限挂住** → 加 5s 超时 + 只 resolve 一次。
3. **端口/路径没校验**：`backend:health` 的 `port`/`path` 直接透传，等于一个"对 127.0.0.1 任意端口发 GET"的探测原语
   → 加了 `0<port<65536` 与路径白名单校验。
4. 我自己引入的两个问题（都被验证抓住）：
   - 该 `require` 的 `buildHealthReport` 因批量编辑回滚**没进去** → 运行时报 `buildHealthReport is not defined`；
   - 新写了一个**空 catch**，被空 catch 门禁当场拦下。
   （顺带把 `test-agent-tools.js` 的"七个只读工具"同步成八个 —— 这个是纯 Node 全量先红才发现的。）

## 诚实边界

- **`backendHealth` 这个新 IPC 在界面侧还没有调用点**（只有 preload 暴露）—— UI 接线留待后续。
- **UI 的"一键"按钮**没有新增：Build/Run/Stop 走的是既有按钮与命令表；这次补的是 Health 与 Agent 侧。
- **本机 `moon build --target native` 是坏的（R12）**，所以一键 Build/Run 在这台机器上会**如实失败**。
  标注在这里，免得下次把它当成"P14 没做完"。
- `deps` 只覆盖 Docker 容器形态（`mbp-pg`/`mbp-redis`）；用其它方式起的 PG/Redis 会显示"未检"。

## 验证

| 项 | 结果 |
|---|---|
| `node test-backend-context.js` | **41 / 0** |
| `npx electron verify-agent-tools.js` | **31 / 0**（含"backendStatus 真的能调"与"如实报告连不上"） |
| 纯 Node 全量 | **32 个脚本全通过** |
| `verify-agent-request.js` | 41 / 0（回归） |
| 门禁 | 空 catch **93 ≤ 95**（比基线还少 2）；local-chk 通过 |
| CI | 新增 `node test-backend-context.js`（11 steps） |
