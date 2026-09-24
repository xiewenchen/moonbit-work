# Phase 2 / P2-06 ～ P2-07：Renderer 迁移到 ProjectContext

> 对应任务：**MBW-P2-06 / P2-07**｜规则：RULE-01 / RULE-04（先建接口，**迁移一个调用点**，验证，再继续）
> 执行时间：2026-09-24（+08:00）

## 一、迁移了什么（只动一个调用点）

按 RULE-04，第一批只迁移**「无项目态」这一个判据**，不一次性铺开：

| 位置 | 之前 | 现在 |
|---|---|---|
| `renderer.js:83`（`initActivityBar`）| `const noProject = !rootDir` | `const noProject = !window.moonbitProjectContext.hasProject(projectCtx)` |
| `renderer.js:372`（`loadTree`）| `rootDir = dir` | 同一时刻再建上下文：`projectCtx = …create({root: dir, …识别结果})` |
| `renderer.js:2052`（`refreshProjectInfo`）| — | 用识别结果补齐上下文的 `kind/label/features` |

**语义等价性是刻意的**：`projectCtx` 与 `rootDir` 在 `loadTree` 里**同一时刻**设置，
所以判据切换不会改变行为（这也是为什么敢只迁一处就回归）。

一个细节值得记：`refreshProjectInfo` 里**不能**直接用主进程返回的 `info.root` ——
主进程在 cwd 为空时会回退 `DEFAULT_CWD`，那样「无项目」会变成「有项目」。
所以上下文里的 `rootDir` 始终以「实际打开的目录」为准。

## 二、三个踩坑（都写下来，避免重复）

### 坑 1：`sandbox: true` 的 preload **不能 require 本地文件** ⚠️ 最严重

第一版我让 preload `require('./project-context')` 并过桥暴露 —— 结果：

```
window.moonAPI 变成 undefined
→ 所有 Electron 测试崩溃（Cannot read properties of undefined (reading 'runnerList')）
```

`main.js:94` 是 `sandbox: true`，sandboxed preload **只能 require('electron') 与少数内置模块**，
require 本地文件会**让整个 preload 挂掉**（不是局部失败）。

**改法**：走本项目既有惯例 —— `index.html` 的 `<script>` + `window` 全局。
`project-context.js` 改成双环境导出（Node 走 CommonJS / 浏览器挂 `window.moonbitProjectContext`），
并在 `translate-strapi.js` 的注入列表里加一行，重跑转译（`index.html` 只多了 1 行，`+1 −0`）。

> **教训**：改 preload 之前先确认 `sandbox`。它失败的方式是"整块消失"，不是报错。

### 坑 2：写探针时 `loadFile` 是相对 **app path** 的

我用 `npx electron /tmp/probe.js` 写探针去查 `window.moonbitProjectContext`，
得到 `href: "chrome-error://chromewebdata/"`、`document.scripts.length === 0` —— 差点据此断定"页面坏了"。

真相：`win.loadFile('index.html')` 相对的是 **app path**，用 `/tmp` 下的脚本启动时 app path 就是 `/tmp`，
根本找不到 `index.html`。**探针必须放在 `desktop/` 里跑**，换到 desktop 下立刻拿到 `ctx: "object"`（11 个 key）。

### 坑 3：直接 `npx electron e2e-features.js "<路径>"` 会误报

这样调用时功能体检报 **20/23**（文件树 0 节点），看起来像回归；
改用 `npm run verify:demo`（它按 `verify-demo.js:30` 的方式传 `path.join(DIR,'..')`）后是 **23/23**。

差别在 `e2e-features.js:208` 的 argv 解析会被 npx/electron 的额外参数干扰。
**结论：别绕过 npm script 直调交互层脚本。**

## 三、验证（RULE-01）

| 验证 | 结果 |
|---|---|
| `node test-project-context.js` | **36 / 0**（改了导出方式与 `normalizeRoot`，必须回归）|
| CI YAML / 纯 Node 全量 | 依次通过；`check-empty-catch` 未新增 |
| `verify-welcome`（无项目态 3 场景）| **全 ✅**（exit 0）—— 判据迁移的核心验证 |
| `verify-run-url` | **5 / 0** |
| **`npm run verify:demo`** | **7 步通过 / 0 步失败**，含「功能体检 **23 项**」|
| `index.html` 变化量 | `+1 −0`（只有新增的 script 行 —— 转译是确定性的）|

## 四、未做（留给后续批次）

| 任务 | 说明 |
|---|---|
| P2-08 / P2-09 | 迁移 Runner（接受 ProjectContext，不再自己找根）+ 回归 |
| P2-10 ～ P2-14 | 迁移 LSP / Terminal / API Debugger / Problems / Agent |
| P2-15 | **逐个**废弃旧变量（`rootDir` / `projectInfoCache` / `lspRoot`），一次删一个 + 回归 |
| P2-16 / P2-17 / P2-18 | 无项目态 / 多项目切换 / 关闭项目 的完整验证 |

> 本批**只迁移了一个调用点**，`rootDir` 等旧变量都还在原地 —— 这正是 RULE-04 要求的节奏。
