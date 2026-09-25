# P17 修复：依赖锁定 + `fs:write` 收窄

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P17-02 收窄 DONE** + **P17-11 依赖锁定 DONE**；`verify-write-guard` **13/0**
- 审计高危 **1 → 0**；浮动依赖 **6 → 0**

## ① `fs:write`：从"任意绝对路径"收窄到"只能写工作区"

审计把它列为**唯一的高危项**。收窄前先查了实际用途（RULE-03）：

```
grep writeFile → 渲染侧只有一处调用：
  renderer.js:305   writeFile(t.path, editor.getValue())   ← 保存编辑器里的文件
```

而 Agent 改文件走的是 `agent-patch`（自己注入 `writeFile`、另有危险表），**不经这条**。
所以可以安全地限制成：

1. **受保护文件先过关**（`agent-rules.md`，P11 的守卫仍然在前面）；
2. **只能写当前工作区内**的文件；**没打开项目就拒绝**。

验证（13 项）把两面都盯住了：**工作区内能写**（保存文件这条路径没被误伤，内容也对得上）、
**工作区外被拒且文件根本没被创建**、`../` 穿越被拒、`agent-rules.md` 仍被"受保护"而非
"工作区"拦下、关项目后拒绝。

## ② 依赖：6 个浮动 → 6 个精确版本

原状是全部 `^`（`@xterm/xterm@^5.5.0`、`electron@^44.4.2`…）—— 每次 `npm i` 都可能拿到新版本。
对一个"要让别人能复现构建"的项目，这是实打实的风险。

钉的是**实际安装的版本**（从 `node_modules/<pkg>/package.json` 读出来的），不是随手填一个：

```
@xterm/addon-fit 0.10.0 ｜ @xterm/xterm 5.5.0 ｜ node-pty 1.1.0
electron 44.4.2 ｜ electron-builder 26.15.3 ｜ monaco-editor 0.56.0
```

> 其中 `node-pty` 声明的是 `^1.0.0` 而实装 **1.1.0** —— 钉版本时正好把这个偏差暴露出来了。

## ③ 顺带：审计规则本身也改了一处

`fs:write` 原来只匹配 `ipcMain.handle('fs:write'` —— **收窄之后它还会一直报高危**。
而**一条永远红的规则等于没有规则**（人会开始忽略报告）。改成单独查
「handler 里有没有路径守卫」，并正面报告 `fs:write 守卫：已限定在工作区内`。

## 仍未修（如实标注）

审计里还剩 **4 项 MEDIUM**：`spawn-util.js` 的 `shell: true`（命令注入面）。
P1 已经修过它引起的"孤儿进程"（`killTree`），但**参数拼接的注入面**没动 ——
要收窄它得改 spawn 的取参方式，风险比这次两条大，单独排。

## 验证

| 项 | 结果 |
|---|---|
| `npx electron verify-write-guard.js` | **13 / 0** |
| `verify-welcome.js` | 通过（回归：它要保存文件） |
| `verify-agent-patch.js` | 28 / 0 |
| `verify-relay.js` | 42 / 0 |
| `node tools/audit-desktop-security.js --ci` | 高危 **0** ／ 浮动依赖 **0** ／ ✓ 没有新增高危项 |
| 纯 Node 全量 | 35 个脚本全通过 |
| 门禁 | 空 catch 93 ≤ 95 |
