# Phase 2 / P2-10 ～ P2-14（接线）：renderer 真正把上下文交给主进程

> 承接上一批（主进程侧已能接受 ProjectContext），本批让**调用方真的传**。
> 规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）

## 一、核心设计：`projectRootInput()` 的**一致性检查**

```js
function projectRootInput() {
  const root = (cwdInput.value || '').trim()
  if (projectCtx && projectCtx.rootDir === root) return projectCtx   // 一致才认上下文
  return root                                                        // 否则退回字符串
}
```

**为什么必须有这个检查**：如果无条件把 `projectCtx` 传下去，就可能出现
「用户手改了地址栏、但还没重新打开项目」→ 拿一个**过期上下文**去调 IPC，
行为和显示不一致，而且**很难查**。加上一致性检查后：

- 上下文与地址栏一致 → 走单一来源（新路径）；
- 不一致（或还没打开项目）→ 退回字符串（**与迁移前行为完全一致**）。

坏情况不可能发生 → 可以放心一次性接四处调用点。

## 二、一个必须先修的语义问题

P2-06 时我把上下文建在 `loadTree(dir)` 里，而 `dir` 可能是 `findModule` 找到的**模块根**
（用户选的是子目录时两者不同）→ 那样 `projectCtx.rootDir ≠ cwdInput.value`，
上面的一致性检查会**永远失败**，整个迁移等于白做。

**修法**：把上下文的创建移到 `boot()`，`rootDir` 用 **`target`（用户意图的目录）**：

```js
const target = dir || cwdInput.value
cwdInput.value = target
projectCtx = target ? create({ root: target, …识别结果 }) : null
```

顺带确认：其它会改地址栏的地方（`chooseFolder` / 新建项目 / 欢迎页打开）
都是 `cwdInput.value = dir; await boot(dir)` —— **紧跟 boot**，所以自动同步，不用逐个改。

## 三、接通的调用点（12 处）

| 用途 | 调用 |
|---|---|
| 格式化保存 | `formatFile(projectRootInput(), t.path)` |
| moon 流式命令 | `runMoonStream(args, projectRootInput())` |
| 顶栏按类型分派 | `const cwd = projectRootInput()` |
| 集成终端 | `termCreate(projectRootInput())` |
| Problems（`moon check`）| `runCheck(projectRootInput())` |
| 跨文件搜索 | `searchFiles(projectRootInput(), …)` |
| 符号索引 | `loadSymbols(projectRootInput(), …)` |
| **LSP** | `const root = projectRootPath()`（要字符串，且用于 `lspRoot` 比较）|
| 运行入口 | `runnerList(projectRootInput())` |
| 后端面板 | `backendStatus(projectRootInput(), …)` / `backendStart(projectRootInput(), …)` |
| 项目识别 | `projectInfo(projectRootPath())` —— **故意用字符串**，避免「用识别结果造上下文、再用上下文去识别」的循环 |

新增两个 helper：`projectRootInput()`（可能返回上下文）与 `projectRootPath()`（一定返回字符串）。

## 四、验证（RULE-01）

| 验证 | 结果 |
|---|---|
| `node --check renderer.js` | 语法 OK |
| 纯 Node 全量 | 25 / 12 / 25 / 29 / 48 / 43 / 51 —— **全 0 失败** |
| `verify-run-url` | **5 / 0** |
| **`npm run verify:demo`** | **7 步通过 / 0 步失败**（运行项目 / 顶栏分派 / 中转站 / Agent / 体检 23 项）|

> `verify:demo` 里的「顶栏按钮按类型分派」正是走 `projectRootInput()` 的那条路径，
> 它通过说明"按项目类型分派"在上下文接线下仍然正确。

## 五、未做（下一批）

| 任务 | 说明 |
|---|---|
| **P2-15** | 逐个废弃旧变量：`rootDir`（现在只剩 `loadTree` 里赋值 + 1 处读取）、`projectInfoCache`、`lspRoot` —— 一次删一个 + 回归 |
| **P2-16** | 无项目态验证：Home / Workbench / Agent / Settings 可用，Project-only UI 禁用 |
| **P2-17** | **多项目切换 A→B→A**：需要先给 renderer 加一个受控的「打开项目」入口（`window.moonbitIDE.openProject`）供自动化调用 —— 现有路径只有系统文件夹对话框，脚本点不到。这个入口同时是 P3（Command Registry）的雏形 |
| **P2-18** | 关闭项目后上下文清空 |

> 说明为什么 P2-17 要额外设计：目前"打开项目"只能经由**系统对话框**，自动化验证够不到；
> 需要一个显式的、可被脚本与未来 Agent 复用的入口，这本身就是一件独立的小任务。
