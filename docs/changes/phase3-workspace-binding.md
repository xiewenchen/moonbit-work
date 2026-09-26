# PH3-WS-03～10：把各子系统**真正**绑到同一个 Workspace

- 日期：2026-09-26
- 新增：`verify-workspace.js`（端到端 **35/0**）；`workspace.js` 补 `bindingsFrom` 与双环境导出
- 回归：`verify-workbench` 23/0、`verify-session-memory-ui` 17/0（见下"一次真回归"）

## 一条关键决策：**不改任何存储键**

已有数据是用 `root`（workbench.json）/`projectRoot`（sessions、office-links）存的。
**改键 = 让用户丢数据**。所以这一批做的是**读时规范化 + 一致性自检**，
而不是"统一成一个新键"。

## 摸现状时发现我上一批写错了键名

上一批建 `workspace.js` 时，我按印象把 workbench 的键写成 `projectRoot` ——
**实际 `workbench.json` 用的是 `root`**。键名写错的后果是**一致性检查永远报 missing**，
也就是等于没检查。已按真实数据修正，并在表里加了 `path`（读取路径）与 `scope`（存在哪）。

## ★ 端到端验证暴露的一个真问题：**跨环境身份不一致**

`verify-workspace.js` 第一次跑就红了：renderer 里算出的 ID 是 `ws:c:/Users/me/Proj`
（**没小写**），而主进程算出的是 `ws:c:/users/me/proj`。

原因：`normalizeRoot` 默认分支读 `process.platform` —— **renderer 是浏览器环境，没有 `process`**，
于是它 fallback 到"大小写敏感"。**同一台机器上主进程与 renderer 会给同一个目录两个身份**，
"按项目隔离"就彻底失效了。

修法：平台要**推出来**（先 `process`，再 `navigator.userAgent`）。
这与"不能直接写 `module.exports`"是同一类**宿主对象问题**。

## 那次真回归：两个面板坏了，根因是**全局 const 撞名**

把 `workspace.js` 插进 `index.html` 后，`verify-workbench` 从 23/0 变 22/1、
`verify-session-memory-ui` 从 17/0 变 16/1，而且**可复现**。

根因：`workspace.js` 被当**全局脚本**加载，顶层的 `const SUBSYSTEMS` / `normalizeRoot` / `joinPath`
**污染了全局作用域**，与别的脚本撞名后**静默改变了行为**（不抛错，只是结果不对）。

> 这正是 `project-context.js` 当年改用 **IIFE** 的原因。已把 `workspace.js` 整个包进 IIFE，
> 对外只留 `window.moonbitWorkspace`（浏览器）与 `module.exports`（Node）。

**这次是靠"改完跑全量回归"抓到的** —— 单看 diff（+22 行 / +1 行 script）完全看不出问题。
