# Phase 2 / P4-10 与接线：问题面板改从统一 Store 渲染

> 承接上一批（Problem Model 已建好、46 项单测通过）。本批让它**真的接上界面**。
> 规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）

## 一、接了什么

`renderProblems` 之前是**手工拼接**两个来源：

```js
for (const d of lastDiags) rows.push({ ...d, kind: 'compile' })   // 诊断
for (const r of runtimeLocs) rows.push({ ... })                   // 运行时
```

改成**统一从 Store 出**：

```js
store.replaceSource(P.PROBLEM_SOURCE.LSP, P.fromLspDiagnostics(lastDiags || []))
store.replaceSource(P.PROBLEM_SOURCE.RUNTIME, P.fromRuntimeLocs(runtimeLocs || []))
rows = store.list().map(...)          // 排序 / 去重 / 过滤都由 Store 负责
```

外加三处必要的加固：

| 位置 | 加固 |
|---|---|
| `renderProgressRows` | 统一模型后会出现**没有文件位置**的问题（测试 / API / Agent 类）→ 别再 `d.file.split()` 抛错；无位置的行不给 `onclick` |
| `window.moonbitIDE.problems` | 新增 `list / stats / refresh / report` —— 只读查询给 P6（Agent 要读问题），`report` 就是 P4-08「Agent 发现 → Problem」的入口 |
| 模块加载 | `problem-model.js` / `lsp-parse.js` 走 `<script>` + 全局（preload 是 sandbox，不能 require 本地文件）|

**P4-10（点击跳转）本来就已满足** —— `renderProgressRows` 里早有 `row.onclick → openFile + jumpToLine`；
本批只是保证它在新模型下仍然成立（并对无位置的项关掉）。

## 二、接线时踩到的两个真问题（都只在浏览器里暴露）

### 问题 1：加载顺序 —— renderer 先于这些模块

`index.html` 里 `renderer.js`(1167) 在 `problem-model.js`(1171) **之前**加载。
我一开始在 renderer **模块顶层**写：

```js
const problemStore = window.MoonbitProblems ? window.MoonbitProblems.createProblemStore() : null   // ✗ 永远是 null
```

→ 拿到永远 `undefined`，功能静默退化成旧行为（不会报错，最难查的那种）。

**修法**：延迟创建（`getProblemStore()` 首次真正用它时才建）。

### 问题 2：三个文件顶层都写了 `const API` → 浏览器里直接抛

```
Uncaught SyntaxError: Identifier 'API' has already been declared
→ lsp-parse.js / problem-model.js 双双加载失败 → window.MoonbitProblems 是 undefined
```

**为什么单测看不见**：Node 里每个文件都是**独立模块作用域**，重名合法；
只有把它们放进**同一个全局作用域**（浏览器就是这样）才会冲突。
我第一次跑 `verify-problems.js` 得到 `window.MoonbitProblems = undefined`，才顺着查到这。

**修法**：三个文件（`project-context.js` / `lsp-parse.js` / `problem-model.js`）的导出统一用 IIFE 包起来，
顶层不再有裸的 `const API`。

**更重要的是**：这种问题**不能只靠"下次小心"**。所以补了一个测试：

`desktop/test-renderer-globals.js`（14 项，已挂 CI）——用 `vm` 在**同一个 context** 里按真实顺序加载这些脚本：

| 断言 |
|---|
| 三个脚本在同一全局作用域下都能加载（**专门防 const 重名这类冲突**）|
| 各自的全局都挂上了（`moonbitProjectContext` / `MoonbitLspParse` / `MoonbitProblems`）|
| **顺序无关**（倒序加载同样成功）|
| 浏览器里不该泄漏 `module` |
| `index.html` 真的引入了它们（防"忘了加进转译列表"）|
| renderer.js 确实在它们之前加载（**提醒"必须延迟使用"**）|

## 三、验证（RULE-01）

| 验证 | 结果 |
|---|---|
| `node test-renderer-globals.js`（新）| **14 / 0** |
| `node test-problem-model.js` | 46 / 0 |
| 纯 Node 全量（10 个脚本）| 25/12/25/29/48/43/44/46/**14**/51 —— 全 0 失败 |
| **`npm run verify:problems`（新）** | **14 / 0** —— 模块加载、初始为空、**写入一条「Agent 发现」后面板真的出现该行**、去重、`stats`、**点击跳到 main.mbt** |
| **`npm run verify:demo`** | **7 步通过 / 0 步失败**（含"问题面板"体检项）|
| `check-empty-catch --ci` | 94 ≤ 95 |
| `index.html` 变化量 | `+2 −0`（正好两个 script）|

## 四、P4 完成度

| 任务 | 状态 |
|---|---|
| P4-01～P4-09、P4-11、P4-12（模型 + Store + 适配器）| ✅ |
| **P4-10 点击跳转** | ✅（原有能力，已在新模型下验证）|
| **Gate P4：五类问题统一可见** | ✅ —— 诊断 / 运行时已进同一 Store；测试 / API / Agent 的适配器已就位并有写入入口（`problems.report`）|

> 仍未接的两类：**测试结果**（`fromTestResult` 已就位，等 P7 的 Agent 跑测试时接）与
> **API 结果**（`fromApiResult` 已就位，等接口面板接线时接）。它们**不影响** Gate P4 ——
> 模型与入口都在，缺的只是"谁来喂"。
