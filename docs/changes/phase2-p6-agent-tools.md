# Phase 2 / P6-01 ～ P6-10：Agent 只读工具

> 对应任务：**MBW-P6-01 ～ P6-10**｜规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）
>
> Gate P6：**Agent 可以「理解项目」，但不能修改、不能执行。**

## 一、把"只读"做成结构保证，而不是约定

上一批（P5.5）建好了安全原语，这一批把它们**装到工具层**。核心取向：

```js
function register(spec, impl) {
  const manifest = createToolManifest(spec)          // 超时/输出限额必填
  // ★ Gate P6 的结构性保证：只读注册表**不接受**任何非 read 权限的工具
  if (manifest.permission !== PERMISSION.READ) {
    throw new Error('只读注册表不允许 ' + manifest.permission + ' 权限的工具：' + manifest.name)
  }
  …
}
```

于是「Agent 不会写文件 / 不会跑命令」**不需要靠代码评审发现** —— 它压根没有那样的工具可调。
测试里专门验了这一条（注册一个 `write` / `execute` 工具**必须抛错**）。

安全原语**全部复用** `agent-sandbox.js`（`createToolManifest` + `resolveInsideWorkspace`），不另写一套。

## 二、产出：`desktop/agent-tools.js`

| 任务 | 工具 | 权限 | 超时 | 输出限额 | 能碰哪里 |
|---|---|---|---|---|---|
| P6-01 | `readFile` | read | 5s | 64 KiB | workspace 内 |
| P6-02 | `listDir` | read | 5s | 32 KiB | workspace 内 |
| P6-03 | `search` | read | 10s | 64 KiB | workspace 内 |
| P6-04 | `symbols` | read | 5s | 64 KiB | workspace 内（复用现有符号索引）|
| P6-05 | `getDiagnostics` | read | 2s | 32 KiB | 内存（P4 的统一 Problem Store）|
| P6-06 | `getRunLog` | read | 2s | 32 KiB | 内存（最近一次 RunResult）|
| P6-07 | `getProjectInfo` | read | 2s | 16 KiB | 内存（P2 的 ProjectContext）|

**P6-08 统一结果**：`{ ok, data, error, truncated }` —— 所有工具一个形状，
实现抛错会被转成 `ok:false`（**不冒泡**），调用方只有一条处理路径。

**P6-09 审计**：超时与输出限额不是文档约定，是 `createToolManifest` 的**必填字段**（缺一个就报错）；
`list()` 把这张表原样暴露出来，供审计随时核对。

## 三、验证（RULE-01）

```bash
cd desktop && node test-agent-tools.js
```

**结果：39 通过 / 0 失败**

| 组 | 关键断言 |
|---|---|
| P6-08 | 结果形状统一；`data` 缺省是 `null`；`truncated` 只认 `true` |
| P6-09 | 七个工具齐备、**全部 read 权限**、每个都有正的 `timeoutMs` 与 `maxOutputBytes`、文件类声明 `workspaceOnly` |
| **P6-10 结构性** | **注册 `write`/`execute` 工具 → 抛错**；表里不存在写/执行工具；调用表外工具被拒 |
| P6-01 | 正常读；`../secret` / 绝对路径在外部 / 空路径 **全部拒**；超长内容截断并标 `truncated` |
| P6-02/03 | 目录不存在 → 明确失败；`listDir` 同样受沙箱约束；`search` 缺 `query` → 失败 |
| P6-04～07 | 四个内存类工具正常返回 |
| 错误处理 | 能力未注入 → **明确报错**（不是静默成功）；实现抛错 → 转 `ok:false`；未打开项目时文件类全拒、内存类仍可用 |
| **P6-10 场景** | ① 读项目信息 ② 查符号（带文件/行号）③ 读错误位置 ④ 读源码去解释 ⑤ **越界读被拒 / 无写能力 / 无执行能力** |

**回归**：纯 Node 全量 **13 个脚本** —— 12/25/25/29/48/43/44/46/14/28/48/**39**/51，全 0 失败；
`check-empty-catch --ci` **94 ≤ 基线 95**；CI YAML OK（已挂进桌面纯逻辑段）。

## 四、Gate P6 状态

| 判据 | 状态 |
|---|---|
| Agent 可以**理解项目** | ✅ 七个只读工具（项目信息 / 文件 / 目录 / 搜索 / 符号 / 问题 / 运行日志）|
| Agent **不能修改** | ✅ 注册表不含 write 工具，且**注册即拒**（有断言）|
| Agent **不能执行** | ✅ 注册表不含 execute 工具（有断言）|

**GATE P6 通过。**

## 五、未做（下一批）

| 任务 | 说明 |
|---|---|
| 接到真实数据 | 把 `readFile/listDir/search/symbols/problems/runLog/projectInfo` 接上真实实现（主进程 fs / symbols 索引 / P4 Store / runner 结果）|
| 接到 Agent | 把这批工具的描述喂给 `agent.js`（**只读调用**），并按 P5 的 `AgentContext` 组装上下文 |
| P7 Execute | 届时才允许 `build/test/run/stop/apiRequest` —— 且同样走 `agent-sandbox` 的原语 |
| P8 Modify | 更远：Patch + 用户确认 + 备份 |
