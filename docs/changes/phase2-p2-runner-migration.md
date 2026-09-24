# Phase 2 / P2-08 ～ P2-09：Runner 迁移到 ProjectContext

> 对应任务：**MBW-P2-08 / P2-09**｜规则：RULE-01 / RULE-04
> 执行时间：2026-09-24（+08:00）

## 一、改了什么

| 位置 | 之前 | 现在 |
|---|---|---|
| `runners.js` | `runner:list` 直接 `findRunners(root \|\| process.cwd())` | 新增 `rootOfInput(input)` 归一化后再用 |
| `renderer.js:686` | `runnerList(cwdInput.value \|\| '')` | `runnerList(projectCtx \|\| cwdInput.value \|\| '')` —— **优先交上下文** |

### `rootOfInput()`：容忍新旧两种调用（零破坏迁移）

```js
function rootOfInput(arg) {
  if (typeof arg === 'string') return arg.trim()                       // 旧调用（verify-*.js 仍这样传）
  if (arg && typeof arg === 'object') {
    if (typeof arg.rootDir === 'string') return arg.rootDir.trim()      // ProjectContext（新）
    if (arg.ctx && …) return arg.ctx.rootDir.trim()                     // { ctx } 包装
  }
  return ''                                                            // 认不出来 → 空串
}
```

**为什么返回空串、而不是在这里默默回退 `process.cwd()`**：
P2-01 的盘点已经指出，正是 `cwd || DEFAULT_CWD` 这种"各自默默兜底"被复制了近十处，
才让「当前项目是什么」这件事没法收敛。归一化函数只负责**翻译输入**，
"没有就兜底"这个决定留给调用方（IPC 层仍然 `|| process.cwd()`，职责清晰）。

## 二、验证（RULE-01）

| 验证 | 结果 |
|---|---|
| `node test-runner-detect.js` | **25 / 0**（从 18 扩到 25，新增 7 项 `rootOfInput` 断言）|
| 其中跨模块契约 | 用**真实**的 `createProjectContext()` 造上下文喂进去 → 取到它的 `rootDir` ✓ |
| **旧路径**：`verify-run-url.js`（传字符串） | **5 / 0** —— 迁移没有破坏既有调用 |
| **新路径**：`npm run verify:demo`（Renderer 传 ProjectContext）| **7 步通过 / 0 步失败**（"运行项目"7.8s、"顶栏按类型分派"43.5s、体检 23 项）|
| 纯 Node 全量 | 25 / 12 / 25 / 29 / 48 / 36 / 51 —— 全 0 失败 |

## 三、未做

- `runner:run` 的 `spec.cwd` 仍来自 `findRunners()` 的产物（每个入口自带 `cwd`），本批**未改** —— 它本来就不"自己找根"。
- P2-10 ～ P2-14：LSP / Terminal / API Debugger / Problems / Agent 的迁移。
- P2-15：逐个废弃 `rootDir` / `projectInfoCache` / `lspRoot`。

## 四、边界

本批只动 `runners.js` 与 `renderer.js` 各一处 + 测试；
`main.js` 里那近十处 `cwd || DEFAULT_CWD` **仍未收敛** —— 它们属于 P2-10～P2-14 的迁移范围
（那批会逐个把 handler 的取根改成"从上下文来"）。
