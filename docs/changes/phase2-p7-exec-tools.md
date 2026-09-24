# Phase 2 / P7-01 ～ P7-10：Agent 执行工具

> 对应任务：**MBW-P7-01 ～ P7-10**｜规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）
>
> Gate P7：**Agent 可以 Build / Test / Run / Stop / Health / API，但仍不能修改源文件。**

## 一、"能跑但不能改"同样是结构保证

和只读表同一套思路，只是方向相反：

| 表 | 规则 |
|---|---|
| `agent-tools.js`（只读）| `register` 时**拒绝一切非 `read`** |
| `agent-exec-tools.js`（执行）| `register` 时**拒绝 `write`**，只放 `execute` |

于是「Agent 不会改源文件」不需要靠代码评审发现 —— 它压根没有那样的工具可调。
测试里专门验了：**注册一个 `write` 工具必须抛错**。

## 二、产出：`desktop/agent-exec-tools.js`

| 任务 | 工具 | 超时 | 输出限额 | 网络 | 危险 |
|---|---|---|---|---|---|
| P7-01 | `build` | 10min | 256 KiB | — | high |
| P7-02 | `test` | 10min | 256 KiB | — | high |
| P7-03 | `run` | 20s | 64 KiB | — | medium |
| P7-04 | `stop` | 15s | 32 KiB | — | low |
| P7-05 | `health` | 10s | 32 KiB | ✅ | low |
| P7-06 | `apiRequest` | 30s | 256 KiB | ✅ | medium |

### 三条写进实现（而不是写进文档）的硬要求

**P7-01 一律经命令表**：
```js
const viaCommand = (cmdName) => async (args) => deps.executeCommand(cmdName, args, {})
```
构造时**强制要求注入 `executeCommand`**，不注入直接抛错 —— 从根上杜绝"执行工具自己 spawn 一份"。
好处是复用了 P3 已建立的一切（命令级超时、权限标记、日志），也让"UI 与 Agent 走同一条路"继续成立。

**P7-08 审计日志**：每次调用留一条
`{ timestamp, session, tool, command, result, duration, error }`；
被预算拒绝的调用也记（`result: 'blocked'`）——**没发生的事也要留痕**。

**P7-09 预算**：复用 `agent-sandbox` 的 `createBudget`（默认 10 次 / 5 分钟），
在**执行前**检查 —— 超了就直接拒绝，**不会**"先跑再发现超了"。

**P7-10 失败不重试**：代码里根本没有重试路径；测试断言 `executeCommand` 在失败时**只被调用一次**。

**P7-07 API 规模限制**（实现里强制，不是文档约定）：
请求头 ≤ 64 个 / ≤ 8 KiB，请求体 ≤ 256 KiB，响应体 ≤ 256 KiB（超了截断并标 `truncated`），超时 ≤ 30s。

## 三、接线（本批一并做了）

| 层 | 内容 |
|---|---|
| `agent-tools-main.js` | 注入 `executeCommand`（P3 命令表）与一个**极简 HTTP** 实现（带响应体上限）|
| IPC | `agentTools:execList` / `execCall` / `execAudit` |
| `window.moonbitIDE.agentTools.exec` | `{ list, call, audit }` |

> `health` 不带 `url` 时**退回报告"最近一次运行状态"**，不跑任何外部命令 ——
> 所以即使本机 MoonBit 工具链坏着（R12），这条路径也能验证。

## 四、验证（RULE-01）

| 验证 | 结果 |
|---|---|
| `node test-agent-exec-tools.js` | **31 / 0** |
| **`npm run verify-agent-tools`** | **25 / 0**（19 → 25，新增 6 项执行工具断言）|
| 纯 Node 全量（14 个脚本）| 25/12/25/29/48/43/44/46/14/28/48/39/**31**/51 —— 全 0 失败 |
| **`npm run verify:demo`** | **7 步通过 / 0 步失败**（改了 main/preload/renderer，必须回归）|
| `check-empty-catch --ci` | 94 ≤ 95 |

`test-agent-exec-tools.js` 里最值钱的几条：

| 断言 | 说明 |
|---|---|
| **不注入 `executeCommand` → 构造就抛错** | P7-01 的强制 |
| 四个工具的命令名分别落到 `project.build/test/run/stop` | 确实经命令表 |
| **注册 `write` 工具 → 抛错** | Gate P7 的结构保证 |
| **预算耗尽时 `executeCommand` 调用次数不变** | 超限不真的执行 |
| **失败时 `executeCommand` 只被调用一次** | P7-10 不重试 |
| 请求头过多 / 过大、请求体过大 → 全拒 | P7-07 |

## 五、Gate P7 状态

| 判据 | 状态 |
|---|---|
| Build / Test / Run / Stop / Health / API | ✅ 六个工具（且都经命令表）|
| **仍不能修改源文件** | ✅ 执行表拒绝 `write`（有断言）；改文件要等 P8 的 Patch 流程 |
| 执行审计 | ✅ 每次调用留痕（含被拒的）|
| 执行限额 | ✅ 预算（次数+时长）+ 每工具超时/输出限额 |

**GATE P7 通过。**

## 六、未做（下一批）

| 任务 | 说明 |
|---|---|
| 喂给 Agent | 把两张工具表（只读 + 执行）与 P5 的 `AgentContext` 一起交给 `agent.js` —— 需要设计工具调用协议（让模型按 JSON 发起调用）|
| P8 Modify | Patch + 用户确认 + 备份 + 审计（**Agent 第一次获得改文件的可能**，风险最高的一批）|
| P9 Verify | Patch → Check → Test → Run → Health 的验证闭环 |
