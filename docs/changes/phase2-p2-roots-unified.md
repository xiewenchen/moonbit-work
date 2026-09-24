# Phase 2 / P2-10 ～ P2-14：取根统一（主进程侧）

> 对应任务：**MBW-P2-10 ～ P2-14**（LSP / Terminal / API Debugger / Problems / Agent）
> 规则：RULE-01 / RULE-02 / RULE-04
> 执行时间：2026-09-24（+08:00）
> **本批只做主进程侧**：让这些模块**接受** ProjectContext；renderer 改传 ctx 属下一批（见 §五）。

## 一、改了什么：13 处重复取根 → 1 个共享入口

P2-01 盘点出来的重复，这一批一次清掉：

| 文件 | 之前 | 处数 |
|---|---|---|
| `main.js` | `cwd && cwd.length > 0 ? cwd : DEFAULT_CWD` | **8** |
| `project-detect.js` | 同 | 1 |
| `backend.js` | 同 ×2 + `cwd: DEFAULT_CWD`（硬编码）×1 | 3 |
| `api-debug.js` | **写死 `DEFAULT_CWD`，完全忽略传入路径** | 1 |
| `agent.js` | `cwd \|\| process.cwd()` | 1 |

统一后：

```js
// project-context.js（唯一来源）
function rootOfInput(arg) {          // 字符串｜ProjectContext｜{ctx} → 根；认不出给空串
  …
}

// main.js（一次定义，8 处复用）
const rootOr = (input) => rootOfInput(input) || DEFAULT_CWD
```

`runners.js` 保留 `rootOfInput` 的 **re-export**（旧引用不破，测试里有断言）。

## 二、顺手修掉的两处真问题

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `api-debug.js` | **端点清单写死 `DEFAULT_CWD`，完全忽略传入路径** → 打开别的项目时，接口面板仍列**本仓库**的端点 | `specPath(input)` 改为走 `rootOfInput`；handler 接受参数 |
| 2 | `backend.js:backend:build` | 这个 handler **连 cwd 参数都没有**（`async () =>`），只能硬编码 `DEFAULT_CWD` | 签名改为 `async (_e, input)`，`cwd: rootOfInput(input) \|\| DEFAULT_CWD` |

两处都保留了"没传就回退 `DEFAULT_CWD`"的旧行为 —— 所以**当前行为零变化**，只是能力就位。

## 三、验证（RULE-01）

| 验证 | 结果 |
|---|---|
| `node test-project-context.js` | **43 / 0**（从 36 扩到 43：新增 7 项 `rootOfInput`，含「`runners.js` 仍 re-export」）|
| 纯 Node 全量 | 25 / 12 / 25 / 29 / 48 / **43** / 51 —— 全 0 失败 |
| 语法检查 | `main.js` / `project-detect.js` / `backend.js` / `api-debug.js` / `agent.js` / `runners.js` 全部 `node --check` 通过 |
| 旧写法残留 | **0**（只剩注释里的引用）|
| `check-empty-catch --ci` | 94 ≤ 基线 95 |
| `verify-run-url` | **5 / 0** |
| **`npm run verify:demo`** | **7 步通过 / 0 步失败**（运行项目 / 顶栏分派 / 中转站 / Agent / 体检 23 项）|

> `main.js` 一次动了 8 处取根，所以 `verify:demo` 是本批的关键回归 —— 它覆盖了运行、分派、
> 中转站、Agent、体检五条链路，全部通过说明"取根"这次重构没有改变任何既有行为。

## 四、边界（诚实）

- 本批是**纯基础设施重构 + 2 处缺陷修复**，**行为零变化** ——
  因为 renderer 仍然传 `cwdInput.value`（字符串），各 handler 走的还是"字符串 → 根"这条旧路径。
- 也就是说：这些模块**现在能接受** ProjectContext，但**还没人传**。

## 五、未做（下一批）

| 任务 | 说明 |
|---|---|
| renderer 侧接线 | `ensureLsp()` / `termCreate()` / `apiEndpoints()` / `runCheck()`（Problems）/ `agentRun()` 改为传 `projectCtx` |
| preload 签名 | `apiEndpoints()` → `apiEndpoints(ctx)`（加参数，向后兼容）|
| 回归 | 多项目切换（A→B→A）时确认 LSP / Terminal / API / Problems / Agent 都跟着换根 |
| P2-15 | 逐个废弃 `rootDir` / `projectInfoCache` / `lspRoot` |
| P2-16 ～ P2-18 | 无项目态 / 多项目切换 / 关闭项目 的完整验证 |
