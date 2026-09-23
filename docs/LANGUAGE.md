# 语言层：LSP 接入

## 结论

语言分析**全部来自官方 `moon-lsp`**；本项目的贡献是 **LSP 客户端集成 + Monaco 对接**（见 `docs/ATTRIBUTION.md`）。

- LSP 版本：`moon-lsp v0.10.13+cbb11c36f`（2026-09-15，随 MoonBit 工具链 `0.1.20260915` 分发）
- 客户端实现：`desktop/lsp-manager.js`
- 已声明能力：**16 项**（`initialize` 返回）

## 已接的 provider

| 能力 | Monaco 侧 | LSP 方法 | 状态 |
|---|---|---|---|
| 补全 | `registerCompletionItemProvider` | `textDocument/completion` | ✅ |
| 跳转定义 | `registerDefinitionProvider` | `textDocument/definition` | ✅ **实测** |
| 悬停 | `registerHoverProvider` | `textDocument/hover` | ✅ **实测** |
| 查找引用 | `registerReferenceProvider` | `textDocument/references` | ✅ **实测** |
| 大纲 | `refreshOutline()` | `textDocument/documentSymbol` | ✅ **实测** |
| 实时诊断 | `onLspDiagnostics` → Monaco markers | `textDocument/publishDiagnostics`（服务端推送）| ✅ 已接 |
| 内联建议（Ghost Text）| `registerInlineCompletionsProvider` | 未走 LSP（本地前缀匹配）| ⚠️ 保留自研 |

## 实测数据（`http/http.mbt`，探测点 `safe_byte` 调用处）

```
initialize      → capabilities 16 项
definition      → 1 条 Location（368 行的调用 → 366 行定义）  同文件 ✓
definition(跨文件) → 1 条 Location（→ http.mbt:101）            跨文件 ✓
hover           → 有内容（```moonbit Int```）+ range
references      → 8 条
documentSymbol  → 38 条（safe_get@18 / safe_byte@28 / Method@38 …）
```

**F12 手验**：光标停在 `safe_byte` 上按 F12 → **跳到定义行** ✓

## 客户端实现的工业级要求（对照验收标准）

| 要求 | 落地方式 |
|---|---|
| **配置化** | `command` / `args` / `transport` / `languageId` / 超时全从配置读；项目内 `.moonbit-ide.json` 的 `lsp` 段可覆盖。换别的语言服务器只改配置 |
| **生命周期** | `start` 拉起；`stop` 先 `shutdown` → `exit` → 兜底 `kill`；**意外退出自动重启**（上限 3 次）|
| **按需启动** | 语言类请求发现 LSP 未起时**自动 start**（不把责任推给调用方 —— 这是修过的一个真缺陷）|
| **文档同步** | `didOpen` / `didChange` / `didClose` 都发，**version 单调递增**；已 open 的文件再次 open 会转成 `didChange`，避免 version 被重置 |
| **错误处理** | 每个请求独立超时（默认 10s，initialize 20s），超时返回明确原因；进程崩溃时批量失败所有 pending 请求 |
| **URI 归一** | Monaco 产出 `file:///c%3A/...`，LSP 期望 `file:///c:/...` —— `normalizeUri()` / `filePathOf()` 双向归一，否则 didOpen 与 definition 会被当成两个文件 |

## 诊断：两条并行的线

| 路径 | 触发 | 定位 |
|---|---|---|
| **LSP 诊断** | 文件打开/修改后由服务端**主动推送** | **边写边报**（实时）|
| **`moon check`** | 手动（工具栏 check 按钮）| **一次性完整检查** |

两者**互补而非重复**，问题面板只展示**当前打开文件**的诊断（避免依赖库刷屏）。

## 尚未接入（按复杂度单独排期）

| 能力 | 复杂度 | 为什么不能"同模式加一个" |
|---|---|---|
| **重命名** | 中 | 返回 `WorkspaceEdit`，需跨文件批量应用改动 |
| **语义高亮** | 高 | 增量更新协议（`semanticTokens/full/delta`）+ 与 Monaco tokenization 对接 |
| **签名提示 / 内联提示 / 代码操作 / 调用层级** | 中–高 | 各有 UI 呈现或生命周期问题，不是纯数据映射 |
