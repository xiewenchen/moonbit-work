# Phase 2 / P5.5：Agent 安全门

> 对应任务：**MBW-P5.5-01 ～ P5.5-11**｜规则：RULE-01 / RULE-02｜执行时间：2026-09-24（+08:00）
>
> 清单 Gate P5.5：**没有通过 Path Sandbox / Command Sandbox / Timeout / Output Limit / IPC Review，
> 禁止进入 Agent Execute / Modify。**

## 一、P5.5-01 权限盘点：现状有多松

先把"Agent 现在能碰到什么"数清楚，不然门不知道该关在哪。

| 面 | 现状 | 判断 |
|---|---|---|
| **IPC** | preload 暴露 **82 个方法**（`fs:write` / `term:*` / `moon:*` / `relay:*` / `lsp:*` / `agent:*` …）| 能力面很宽 |
| **文件** | `preload.writeFile(path, content)` → 主进程 `fs:write` 接受**任意绝对路径** | ⚠️ 高 |
| **Shell** | `agent.js` 用 `spawn(opencode …)`，**cwd 来自输入**（任意目录）| ⚠️ 中 |
| **配置写入** | `agent.js` 能 `fs.writeFileSync(CFG_FILE)` → **workspace 外**（`~/.config/opencode/…`）| ⚠️ 中 |
| **进程** | `termCreate` 起真 PTY shell；`relayDelete` 删备份 | 中（用户驱动）|
| **网络** | `apiSend`（主进程发请求）、Agent 子进程自身可联网 | 中 |
| **数据库** | `backend:*`（启停本项目后端）、`adminGet` | 低（只读+固定目标）|

**结论：当前 Agent 面没有沙箱。** 这一批是"**补上**"，不是"加固"。

## 二、产出：`desktop/agent-sandbox.js`（纯逻辑 + 依赖注入）

| 任务 | 内容 |
|---|---|
| P5.5-02 | `PERMISSION` = `read / execute / write`（与 Command Registry 同名，便于对照）|
| P5.5-03 | `createToolManifest`：**必须**声明 `name / permission / timeoutMs / maxOutputBytes`；缺一个就报错（**不允许默认宽松**）|
| P5.5-04 | `isInsideWorkspace` + `resolveInsideWorkspace`（含 **realpath** 复核）|
| P5.5-05 | `checkCommand`：白名单 + 禁用命令 + 破坏性参数 |
| P5.5-06/07 | `runTool`：**强制**超时与输出限额（stdout/stderr 各自截断并标记 `clipped`）|
| P5.5-08 | `createBudget`：最大调用次数 + 最大总时长，**执行前**拒绝（不是跑完再说）|
| P5.5-09 | `isDestructiveTarget`：**目标 = workspace 根** → 绝不允许 |

### 默认收紧（关键取向）

```js
workspaceOnly: spec.workspaceOnly !== false   // 不写就是 true —— 要放宽必须显式声明
network:       spec.network === true          // 不写就是 false
danger:        'low'                          // 不写就是低危
```

## 三、逃逸用例（安全测试的重点）

| 用例 | 期望 | 为什么它会逃逸 |
|---|---|---|
| `../secret` | 拒 | 最朴素的越界 |
| `a/../../b` | 拒 | 多次回退绕过 |
| 绝对路径在 workspace 外 | 拒 | 直接给绝对路径 |
| **`<ws>-other/x`** | 拒 | **`startsWith('<ws>')` 会误判它在 workspace 里** —— 所以实现用 `path.relative` 而不是前缀比较 |
| **workspace 内指向外部的符号链接** | 拒 | **字符串判断看不出来**，必须先 `realpath` 再判 |
| 新建文件（目标还不存在）| 允许 | `realpath` 会抛 `ENOENT` → 退而校验**父目录** |
| 空 target / 未打开项目 | 拒 | 不给"空路径=当前目录"这种默认 |

命令侧的逃逸用例：`rm` / `del` / `format` / `shutdown`（禁用表）、白名单外的 `curl`、以及
**白名单内但带破坏性参数**（`git clean --force`、`node -rf /`）。

## 四、P5.5-10 IPC 审查（逐项）

| IPC | 现状 | 风险 | 处置 |
|---|---|---|---|
| `fs:write` | 任意绝对路径可写 | **高** | P6 起：**Agent 只能经沙箱工具写**，且强制 workspace 内 |
| `agent:run` | cwd 来自输入 | 中 | Agent 侧固定为 workspace root（接线时做）|
| `agent:open-config` / `agent:config:set` | 写 `~/.config/opencode/…` | 中 | 属**用户显式操作**，不接 Agent |
| `relayDelete` / `relayRestore` | 删/还原备份 | 中 | 只允许 `~/.moonbit-backups` 内 |
| `termCreate` / `termInput` / `termKill` | 真 PTY shell | 中 | **终端是用户驱动，不接 Agent** |
| `commandExecute` | 6 个项目命令 | **低** | ✅ 已经是最窄入口（命令固定、有超时、有权限标记）|
| `moon` / `moon:stream` / `moon:format` | 跑 moon 命令 | 低 | Agent 侧统一走 `commandExecute` |
| `apiSend` | 主进程发 HTTP | 中 | 有 body/header/timeout 限额（P7-07 会接）|

**结论**：唯一**高**风险是 `fs:write`。处置方式不是"关掉它"（UI 自己要用），
而是**让 Agent 拿不到它** —— Agent 只能经沙箱工具（下一批建）。

## 五、P5.5-11 Tool 审计表（计划中的 Agent 工具）

每个工具都要能回答四问：**谁能调用 / 能碰哪里 / 最长多久 / 能产生什么副作用**。

| 工具 | 权限 | 能碰哪里 | 超时 | 输出限额 | 副作用 |
|---|---|---|---|---|---|
| `readFile` | read | workspace 内 | 5s | 64 KiB | 无 |
| `listDir` | read | workspace 内 | 5s | 32 KiB | 无 |
| `search` | read | workspace 内 | 10s | 64 KiB | 无 |
| `symbols` | read | workspace 内 | 5s | 64 KiB | 无 |
| `getProblems` | read | 内存（Problem Store）| 2s | 32 KiB | 无 |
| `getRunLog` | read | 内存 | 2s | 32 KiB | 无 |
| `build` / `test` / `run` / `stop` | execute | workspace 内 + 外部进程 | 10min（build/test）/ 20s（run）| 256 KiB | 起进程、占资源 |
| `apiRequest` | execute + network | `127.0.0.1` 为主 | 30s | 256 KiB | 发网络请求 |
| `applyPatch` | write | workspace 内、**先备份** | 10s | 32 KiB | **改文件**（P8 才开，需用户确认）|

> 表里的"超时"与"输出限额"就是 `createToolManifest` 必填的那两个字段 —— 不是文档约定，是**代码强制**。

## 六、验证（RULE-01）

```bash
cd desktop && node test-agent-sandbox.js
```

**结果：48 通过 / 0 失败**（其中逃逸/安全类断言占了大半）

**回归**：纯 Node 全量 12 个脚本 —— 25/12/25/29/48/43/44/46/14/28/**48**/51，全 0 失败；
`check-empty-catch --ci` **94 ≤ 基线 95**；CI YAML OK（已挂进桌面纯逻辑段）。

## 七、Gate P5.5 状态

| 判据 | 状态 |
|---|---|
| Path Sandbox | ✅ 实现 + 逃逸用例（含符号链接、同前缀）|
| Command Sandbox | ✅ 白名单 + 禁用表 + 破坏性参数 |
| Timeout | ✅ Manifest 必填 + `runTool` 强制 |
| Output Limit | ✅ Manifest 必填 + 截断标记 |
| IPC Review | ✅ 逐项审查（§四），唯一高危面 `fs:write` 的处置已定 |

**结论：GATE P5.5 通过** → 允许进入后续的 Agent Execute（P7）。

> ⚠️ 但要说明**门是"建好了"，还没"装到门上"**：Agent 真正的工具执行路径（P6/P7）还没接线，
> 所以现在的实际约束仍是"Renderer 不让 Agent 拿到 `fs:write` / 不走 `agent:run` 的任意 cwd"。
> 接线那批必须**只用这里的安全原语**，不能再自己写一套。
