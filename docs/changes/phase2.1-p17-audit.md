# P17 安全第二轮：把安全审计做成可复现的检查

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**审计部分 DONE**（P17-05 / P17-10 / P17-11 及其它审计项）；**收窄与修复未做**（如实标注）
- 新增 `tools/audit-desktop-security.js`，已挂 CI（12 steps）

## 为什么要做成脚本

清单里 P17 的写法是"**按是否影响 Agent/桌面真实使用排序，而不是全部一起清**"。
而靠"读代码时留意一下"是审计不出东西的：123 个 IPC、几十个模块，人眼扫不过来，
**而且下次改动时没人会再扫一遍**。

所以把它做成可重复执行的检查：结论能复现，新增的高危入口会被当场发现（`--ci` 与基线比较）。

## 审计了什么（`node tools/audit-desktop-security.js`）

| 项 | 结论 |
|---|---|
| ① preload IPC 清单（P17-05） | **123 个**，按 WRITE / AGENT / EXTERNAL / STORAGE / READ / LOCAL / EVENT 分类；**WRITE 只有 1 个**（`fs:write`） |
| ② 危险入口（P17-02/06 的重点） | 高危 **1 项**：`fs:write` 接受任意绝对路径；中危 4 项：`spawn-util` 的 `shell:true` |
| ③ 渲染侧（P17-06） | **3 处**非空 `innerHTML`（`dash.js`×2、`icons.js`×1）—— 逐条核实：**都不含用户输入** |
| ④ Electron 开关与 CSP（P17-10） | `contextIsolation=true` / `nodeIntegration=false` / `sandbox=true` / `webSecurity=true`；`index.html` **已有 CSP**，且 `connect-src` 限在本地 |
| ⑤ 依赖（P17-11） | 6 个依赖**全部浮动**（`^`）：xterm×2、node-pty、electron、electron-builder、monaco-editor |

## 结论（按"是否影响真实使用"读）

- **Electron 的安全开关是对的**，CSP 也有且限制合理 —— 这两项本来就达标，审计确认了它。
- **`fs:write` 仍是"接受任意绝对路径"**：P11 已经给 `agent-rules.md` 加了守门，但**整体仍开放**。
  真正的 Agent 写路径是 `agent-patch`（另有危险表），所以这条的影响面主要是"渲染侧被注入后能写文件"。
- **依赖没锁定**：`^` 意味着每次 `npm i` 都可能拿到新版本 —— 对一个要让别人能复现构建的项目，这是风险。
- `spawn-util` 的 `shell:true`：P1 修过"孤儿进程"（`killTree`），但**命令注入面**仍在。

## 审计自己的三处误报（都修了）

第一版把 **20 处 `innerHTML = ''` 全报成"XSS 面"** —— 逐条看下来全是**清空操作**；
还把 `$schema: 'https://opencode.ai/config.json'` 报成"远程加载脚本"（那只是个 JSON 字段名）。
**误报比漏报更坏**：它会让人开始忽略报告。所以逐条核实后收紧判据：

- 只报**非空**赋值，且允许它出现在 `() => (el.innerHTML = '')` 这类括号里；
- "远程加载"只认真正的 `<script src="https://…">` / `<link href="https://…">`。

收紧后渲染侧从 20 → 3，剩下三条都人工核实过。

## 未做（如实标注）

- **P17-02 收窄 `run_capture`** / **P17-04 命令枚举化**：审计列出来了，但**没动**；
- **P17-07 Agent 工具权限审计**、**P17-08/09 Provider Key 存储与日志审计**：没单独展开
  （Key 相关的守门在 P12/P11 已做：不进项目目录、读回来即脱敏、日志过 `redactText`）；
- **P17-11 依赖锁定**：只报告了"6 个浮动"，**没有**把它们钉成具体版本
  （钉版本会改变构建行为，需要单独验一轮，不顺手做）。

## 验证

| 项 | 结果 |
|---|---|
| `node tools/audit-desktop-security.js` | 完整报告（123 IPC / 高危 1 / 渲染 3 / 开关正确 / 浮动 6） |
| `node tools/audit-desktop-security.js --ci` | ✓ 没有新增高危项 |
| 纯 Node 全量 | 35 个脚本全通过（本轮未改产品代码） |
| 空 catch 门禁 | 93 ≤ 95 |
| CI | 新增 `Desktop security audit` 步骤（12 steps） |
