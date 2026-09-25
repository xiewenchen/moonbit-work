# P13-04～07 数据层：办公文件 ↔ 项目联动

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**数据层 DONE**（`test-office-link` **53/0**）；**IPC 与面板未做**（如实标注）

## 四件事，都不重复造已有的东西

| 任务 | 做法 |
|---|---|
| P13-04 | **显式关联**：文件 → 项目。关联是**记下来**的，不靠路径猜 |
| P13-05 | **复用** `relay-main.js` 已有的 Office 元信息解析（`docProps/core.xml`）—— 这里只做"预览该显示什么"的整理，**不重新解析 docx/xlsx**（那件事 relay 已做过且有测试） |
| P13-06 | 把文件（元信息 + 正文摘要）做成 **Agent 的输入片段** |
| P13-07 | 把 Agent 的结论**追加**到项目便签（交给 P13-03 的 `setNote` 落盘） |

## 三处刻意的设计

1. **关联也按项目隔离**（与 P13 数据层一致）：`linksFor(store, A)` 只返回 A 的文件；
   没给项目就返回空 —— **不把全部倒出来**。
2. **预览"没元信息"要如实说**：`buildOfficePreview(null)` 返回 `hasMeta:false` 且
   说明"这份文件没有可读的内置属性"，而不是给一堆空字段装作解析过。
   有元信息时也写清边界："以上来自内置文档属性，**不是排版还原**，但足够确认这是哪份文档"。
3. **写便签是追加不是覆盖**：便签是用户的，Agent 写一次不能把原来的顶掉。
   所以 `appendSummaryToNote` 是在原内容后面追加带时间戳的小节（测试直接断言"原有内容还在"）。

另外 `toAgentSnippet` 的每一样东西都**带出处**（文件、类型、已关联的项目、时间）——
这与 P5A 那条"Agent 收到的每样东西都该能指着说来源"是一致的。
没有正文时它会写"（没有正文文本；只能依据上面的元信息判断）"，而不是留一片空白让人瞎猜。

## 未做（如实标注）

- **IPC 与面板**：没做 —— 数据层已就绪（`linkFile` / `linksFor` / `buildOfficePreview` /
  `toAgentSnippet` / `appendSummaryToNote`），接上即可；
- **File Relay 侧的实际取文件**：没接（`relay-main.js` 已有文件列表与元信息，但这次没把它们接到这些函数上）。

## 验证

| 项 | 结果 |
|---|---|
| `node test-office-link.js` | **53 / 0** |
| 纯 Node 全量 | 38 个脚本全通过 |
| 门禁 | 空 catch 93 ≤ 95；local-chk 基线 0 |
| CI | 新增 `node test-office-link.js` |

---

## 接线（同批补齐）

`office-main.js` + 7 个 IPC + `showOfficePanel()`（动态 DOM）：

| 能力 | 面板上的入口 |
|---|---|
| P13-04 关联 | 输入文件路径 + 类型 → 「关联到本项目」；列表里每条可「解除」 |
| P13-05 预览 | 走 `office:preview`（复用 relay 的元信息） |
| P13-06 送进 Agent | 列表里每条一个「送给 Agent」→ 显示生成的输入片段 |
| P13-07 结论 → 便签 | 文本框 + 「追加到项目便签」 |

两处存储**各归各位**：关联表存 `~/.moonbit-work/office-links.json`（用户目录），
而 P13-07 的便签**复用** `workbench-main` 的存储 —— 便签本来就属于项目，不另存一份。

端到端 25 项，含"关联按项目隔离"（A 只看得到 A 的）、"没元信息不装作有"、
"两条结论都在（追加而非覆盖）"。脚本会写用户目录的两个文件，所以进去前备份、
任何退出路径都还原（与 P12 改 opencode 配置同样处理）。

回归：`verify-workbench` 23/0（便签存储路径没被改坏）、`verify-session-memory-ui` 17/0、
`verify-welcome` 通过；纯 Node 全量 38 个全过。
