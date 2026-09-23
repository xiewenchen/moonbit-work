# 来源标注（ATTRIBUTION）

本项目包含**自有实现**与**第三方组件**。下表逐项标明来源与我们的贡献，避免把第三方能力算作自研。

## 工具链版本

| 组件 | 版本 | 位置 |
|---|---|---|
| MoonBit 编译器（`moon`）| **0.1.20260915**（2e1a46d，2026-09-15）| `~/.moon/bin/moon` |
| MoonBit LSP（`moon-lsp`）| **v0.10.13+cbb11c36f**（2026-09-15）| `~/.moon/bin/moon-lsp.exe` |
| MSVC 工具链（native 后端）| VS BuildTools 17.14.41 · MSVC 14.44.35207 | 系统安装 |

## 能力来源

| 能力 | 来源 | 我们的贡献 |
|---|---|---|
| 补全 / 跳转定义 / 悬停 / **查找引用** / **重命名** / 语义高亮 / 大纲 / 签名提示 / 折叠 / 代码操作 | **moon-lsp `v0.10.13+cbb11c36f`**（MoonBit 工具链 `0.1.20260915`, commit `2e1a46d`, 2026-09-15）| **LSP 客户端集成**：`lsp-manager.js`（配置化、生命周期与崩溃重启、`didOpen/didChange/didClose` 文档同步、逐请求超时、URI 归一）+ Monaco provider 对接 |
| IDE 界面 / 文件树 / 多标签编辑器 / 跨文件搜索 / 命令面板 / 状态栏 / 四标签活动栏 | **本项目自研** | 完整实现（`renderer.js` / `main.js` / `preload.js`）|
| 可执行入口发现 / 运行调度 / 项目类型识别 | **本项目自研** | 完整实现（`runners.js` 支持 moonbit/node/python/rust/go；`project-detect.js` 判类型）|
| MoonBit→JS 后端（FFI 调 Node + JSON-RPC）| **本项目自研** | 完整实现（`ide-backend/`，`extern "js"` FFI）|
| 文件中转站（Office 备份 / 版本 / 回滚 / 元信息）| **本项目自研** | 完整实现（`relay-main.js` / `relay.js`）；**ZIP 读取器自写，无第三方依赖** |
| 后端平台：HTTP / Redis / PostgreSQL / 应用框架 / Conduit 后端 | **本项目自研（纯 MoonBit）** | 完整实现，约 11k 行（`http/` `redis/` `pg/` `app/` `conduit/` 等）|
| 办公工作台（时钟 / 日历 / 待办 / 便签 / 日程）| **本项目自研** | 完整实现（`dash.js`），节假日表按国务院办公厅公布安排整理 |
| Strapi 外观（外壳 DOM + 全套 CSS）| **Strapi Design System**（MIT）| 运行时导出后**转译**（`export-strapi-page.js` / `translate-strapi.js`）+ 主题适配（日间/夜间）|
| 编辑器内核 | **Monaco Editor**（MIT）| 集成 + 自定义主题 `strapi-dark` / `strapi-light` |
| 集成终端 | **xterm.js**（MIT）+ **node-pty**（MIT）| 集成（含无 PTY 时的回退路径）|
| 工作台拖拽排序 | **SortableJS**（MIT，v1.15.6）| 集成（本地 `vendor/sortable.min.js`）|
| 桌面壳 | **Electron**（MIT）| 集成 + 安全配置（contextIsolation / sandbox / 禁用 nodeIntegration）|

| 重命名的 **WorkspaceEdit 应用 / 预览确认 / 一次撤销 / 版本校验** | — | **本项目实现**（`renderer.js` 的 rename provider；Monaco 提供原子应用与版本校验能力，预览与范围控制由本项目编写）|

## 规范与数据

- **Conduit 后端**遵循 [RealWorld](https://github.com/realworld-apps/realworld) 的**公开 API 规范**；规范本身不含代码，实现为自研。
- **法定节假日**按国务院办公厅公布的放假安排整理（2026–2027），可在界面内编辑覆盖。
- **配色依据**：W3C WCAG 2.1 SC 1.4.3（对比度）与 Solarized 的设计原则（见 `docs/` 与源码注释）。

## 说明

- 表中标「moon-lsp（官方）」的能力，**语言分析本身由官方 LSP 提供**；本项目做的是**客户端集成与编辑器对接**，不计入自研。
- LSP 接入的关键实现点（便于复核）：`desktop/lsp-manager.js`。
