# Phase 2 / P6 接线：把只读工具接到真实数据

> 承接上一批（工具与沙箱已建好、39 项单测通过）。本批让它们**真的能读到这个工程**。
> 规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）

## 一、接了什么

新增 `desktop/agent-tools-main.js` —— 只做两件事：**注入真实实现** + **暴露 IPC**。

| 工具 | 真实实现 |
|---|---|
| `readFile` / `listDir` | `fsops.readTextFile` / `fsops.listDir` |
| `search` | `search.searchInDir`（maxResults 200）|
| `symbols` | `symbols.loadSymbols` + `searchSymbols`（无索引时明确说明而不是报错）|
| `getDiagnostics` | **跨进程读渲染侧的 Problem Store**（`executeJavaScript` 取 `window.moonbitIDE.problems.list()`）|
| `getRunLog` | `projectRunner.state` / `.result`（P1 的 RunResult）|
| `getProjectInfo` | `detectProject(rootOf())` |
| 符号链接复核 | `fs.realpathSync` |

两个 IPC：`agentTools:list` / `agentTools:call`（外加 `setWorkspace` / `getWorkspace` 供渲染侧用）。
`window.moonbitIDE.agentTools = { list, call, workspace }`。

### 关于 workspace 根的安全模型（关键）

```
用户打开项目  →  renderer  bootstrap  →  agentTools:setWorkspace(root)  →  主进程保存
Agent 调工具  →  agentTools:call  →  用**主进程保存的** root 做沙箱
```

**Agent 侧不暴露 `setWorkspace`**（`window.moonbitIDE.agentTools` 里没有它，有断言）。
原因：若让调用方每次传 `root`，沙箱就被绕过了 —— 传个任意路径即可。

## 二、接线时抓到的一个**真设计缺陷**

第一版把根写成：

```js
const rootOf = () => workspace || DEFAULT_CWD      // ✗
```

`DEFAULT_CWD` 是**启动目录**（= 本仓库根）。后果：**关闭项目后，Agent 仍然能读启动目录** ——
`workspace` 被清空后悄悄退到了 `DEFAULT_CWD`，而它恰好也是一个真实存在的目录。

验证脚本最后一条把它抓了出来：

```
[FAIL] 关闭后 workspace 清空（不再是刚才那个项目）  C:\...\moonbit-platform
```

**修法**：`const rootOf = () => workspace`（不兜底）→ 空串会让路径沙箱直接回
**「未打开项目」**。取向是：**宁可"没打开项目时工具全废"，也不要"默默退到某个目录"**。
并加了一条断言锁住它：**关闭项目后文件类工具必须全被拒**。

## 三、另一个值得记的坑：两种 `chk` 语义混用

我的验证脚本里 4 条断言写成：

```js
chk('绝对路径在 workspace 外 → 拒', b.ok, false)     // ✗ 把"期望值"当成了 ok 传入
```

但 `verify-*.js` 用的 `chk(name, ok, detail)` 是**布尔语义**（`if (ok) pass`），
而 `test-*.js` 里是**相等语义**（`chk(name, got, want)`）。两种风格在同一个仓库里并存，
我已经**两次**因此写出"永远为假/永远为真"的断言（另一次在 `verify-multiproject`）。

修法：本文件统一改成显式布尔比较（`b.ok === false`）。
**教训**：把"期望值"直接当条件传入时，`0` / `false` / `''` 这类假值会让断言静默反向 ——
写断言时永远做显式比较。

## 四、验证（RULE-01）

| 验证 | 结果 |
|---|---|
| **`npm run verify:agent-tools`（新）** | **19 / 0** |
| `test-agent-tools`（纯逻辑）| 39 / 0 |
| 纯 Node 全量（13 个脚本）| 12/25/25/29/48/43/44/46/14/28/48/**39**/51 —— 全 0 失败 |
| **`npm run verify:demo`** | **7 步通过 / 0 步失败**（含体检 23 项 —— 我改了 renderer 的 boot/closeProject，必须回归）|
| `check-empty-catch --ci` | 94 ≤ 95 |

`verify-agent-tools` 的 19 项里，几条最实在的：

| 断言 | 说明 |
|---|---|
| 7 个工具、**全部 read 权限**、每个都有超时与输出限额 | P6-09 审计 |
| **没有写/执行工具** | Gate P6 的结构保证在真实接线后仍成立 |
| `workspace = 打开的项目` + **Agent 侧没有 setWorkspace 入口** | 沙箱不被绕过 |
| 在**真实文件**上跑通 readFile / listDir / search / symbols / getProjectInfo / getRunLog / getDiagnostics | 接线成功 |
| `../secret.txt`、`C:/Windows/...`、`../../..` **全部被拒** | 沙箱在真实路径下生效 |
| **关闭项目后文件类工具全被拒** | §二 那个缺陷的回归 |

## 五、P6 完成度

| 任务 | 状态 |
|---|---|
| P6-01 ～ P6-10（工具 + 统一结果 + 审计 + 只读保证）| ✅ |
| **接到真实数据** | ✅ |
| 喂给 Agent（prompt / 工具调用协议）| ❌ 未做 —— 属 P7 的范围（那条会同时引入执行工具）|
