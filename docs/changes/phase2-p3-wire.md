# Phase 2 / P3-09 ～ P3-12：UI 改走命令（接线）

> 承接上一批（命令层已建好、44 项单测通过）。本批让**渲染侧真的走命令**。
> 规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）

## 一、接线（P3-09 ～ P3-11）

| 位置 | 之前 | 现在 |
|---|---|---|
| `renderer.startRunner(spec)` | `window.moonAPI.runnerRun(spec)` | **`commandExecute('project.run', { spec })`** |
| `main.js` | `registerRunnerIpc(...)` 丢弃返回值 | 接住 runner 实例交给命令表 |
| `preload.js` | — | `commandList()` / `commandExecute(name, args, opts)` |
| `window.moonbitIDE` | — | 加 `commands: { list, execute }` |

**P3-10（菜单改走命令）自然满足**：命令面板里的「MoonBit: 运行当前项目」→ `runProject()`
→ `startRunner()` → 命令表 —— 与 UI 按钮**同一条路**。

**P3-11（快捷键）如实说明**：当前唯一的快捷键是 `Ctrl+Shift+P`（打开命令面板），
它触发的动作已经走命令；**没有**专门的"运行项目"快捷键，本轮**没有新增** ——
因为 `Ctrl+R` / `F5` 与 Electron 内置的 reload 冲突，加它属于"新增功能"而不是"改走命令"，
需要单独设计（避免和默认快捷键打架）。

### 接线时必须先修的一个问题（否则输出流会断）

命令表的 `project.run` 一开始写的是 `runner.start(spec, {})` —— **handlers 是空的**：

```js
// runner:run IPC 里
runner.start(spec, { onData, onUrl, onEnd, … })
// 命令表里（错）
runner.start(spec, {})          // ← 进程起来了，但输出/URL 事件根本不会推给界面
```

修法：把 handlers 的构造提取成 `makeRunnerHandlers(send)`，**两条路径共用同一套**：

```js
function makeRunnerHandlers(send) { return { onStart, onData, onUrl, onBrowserOpen, onEnd } }
```

同理，`registerRunnerIpc` 现在**返回 runner 实例**交给命令表 ——
**同一时刻只能有一个运行实例**，若命令表另建一个，「停止」会停错进程。

## 二、P3-12（Terminal 调用命令）：未做，且无现成基础

清单要求"Terminal 调用 Command"。现状：IDE 的集成终端是 **xterm.js + 真 PTY**（真 shell），
里面跑的是用户自己的命令行，**没有任何"在终端里触发 IDE 命令"的机制**（如 `:run` 前缀）。

要实现它需要：解析终端输入、识别命令前缀、调用命令表、把结果回写到终端 ——
这是一件独立的功能（且要小心不要抢用户的正常输入）。本轮**不做**，如实记在这里。

## 三、验证（RULE-01）

| 验证 | 结果 |
|---|---|
| `node --check`（main / runners / commands / preload / renderer）| 全部 OK |
| 纯 Node 回归 | `test-commands` **44/0**、`test-runner-detect` 25/0、`test-run-state` 48/0、`test-project-context` 43/0 |
| **`verify-run-url`** | **5 / 0** —— 关键：`startRunner` 改走命令后，**输出流与 URL 检测仍正常**（证明 handlers 共用是对的）|
| **`verify-multiproject`** | **22 / 0**（17 → 22，新增 5 项命令表断言）|
| **`npm run verify:demo`** | **7 步通过 / 0 步失败**（含"运行项目"9.4s、体检 23 项）|

新增的 5 项命令表断言（写在 `verify-multiproject.js` ⑥ 组）：

| 断言 |
|---|
| `commands.list()` 返回 6 个项目命令 |
| 危险命令带 `danger` 标记（2 个）|
| `execute('project.open', {dir})` 正常且返回 `rootDir` |
| **未知命令 → `ok:false`（不抛）** —— 契约"永不抛错"生效 |
| 缺参数 → `ok:false` |

## 四、Gate P3 对照

| 判据 | 状态 |
|---|---|
| 同一动作（UI / Menu / Shortcut / Agent）走同一 Command | ✅ —— UI 按钮与命令面板的「运行项目」都进 `startRunner` → `project.run`；Agent 侧要等 P7 才接（现在 `window.moonbitIDE.commands` 已就位）|
| **Agent 只建立调用接口，不允许自动执行** | ✅ 本轮**没有**给 Agent 任何执行入口；`commands.execute` 只是暴露给渲染侧的接口 |
| P3-12（Terminal 调命令）| ❌ 未做（无现成基础，见 §二）|
