# P13 工作台：数据层（最近项目 / 待办 / 便签）

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P13-01～03 + P13-08 + 面板 DONE**；**P13-04～07 未做**（如实标注）
- `test-workbench` **56/0**

## 清单里最要紧的那条

> **P13-08 Workbench 不允许反向污染 IDE 状态**

这条容易读过去，但它是整个工作台的设计约束。落实成三条**可检验**的设计：

| 落实方式 | 怎么验的 |
|---|---|
| ① **只读**项目信息 | 只接受"从外面读来的" `rootDir/projectType/label`；这一层**不导出任何能改 IDE 的函数** |
| ② **分开存** | 工作台数据（待办/便签/最近）与 IDE 状态（标签/当前文件/运行状态）不是一回事 |
| ③ **按项目隔离** | 待办与便签都挂在项目根下 —— 一个项目的待办不会出现在另一个项目里 |

而且它不是"写在注释里就算"：

- `WORKBENCH_SCOPE` 把 `owns / reads / neverWritesIDE` 三样写成**数据**；
- 测试断言 **store 的键只有** `recent/todos/notes/version`，且**每个 IDE 状态键都不在里面**；
- 最直接的一条：**把 IDE 字段（`activeFile`/`runState`/`tabs`）一并传进来，也不会被带进 store** ——
  这是"只读"的实证，而不是承诺。

## 做了什么

| 任务 | 内容 |
|---|---|
| P13-01 | `touchRecent`：同根**去重并提到最前**（不是追加）；上限 20；`listRecent` 返回**副本**（调用方改不到 store） |
| P13-02 | 待办：增 / 勾 / 删；空内容拒；超长截断（300）；每项目上限 200 |
| P13-03 | 便签：读写按项目；上限 20000 |
| P13-08 | 见上（书面声明 + 断言） |

另外：`sanitizeStore` 让**损坏的 store 不抛**（类型错的字段被清空、缺 root 的最近项被过滤）——
存储坏了不该让工作台打不开。这一条测试里喂了 6 种坏输入。

## 面板（同批补齐）

`showWorkbenchPanel()`（动态 DOM）：左侧"最近项目"（**可点击直接打开**）、
右侧当前项目的**待办**（可勾可删）与**便签**（可存）。数据存
`~/.moonbit-work/workbench.json`（**用户目录**，不进项目 —— 与 P10 的会话、P12 的 Provider 同理）。

`openProject` 之后会**记一笔最近**：只把项目信息喂给工作台，这是**读**方向。

**P13-08 在磁盘层面也被断言**：端到端验完直接读那个 json，确认里面**只有**
`recent/todos/notes/version`，搜不到 `tabs`/`activeFile`/`runState`/`problems`/`session`；
并且文件在用户目录、不在项目里。

同时端到端真的做了"切项目"：给 A 加待办 → 切到 B（**看不到**）→ 切回 A（**还在**）——
证明隔离不等于丢数据。

## 未做（如实标注）

- **P13-04 File Relay → Project**：没做（中转站与项目的联动）；
- **P13-05 Office Preview / P13-06 Office → Agent**：没做；
- **P13-07 Agent Summary → Note**：没做。

诚实说明：这三项与 Office 相关，本批只做了数据层、那条设计约束、以及工作台面板。

## 验证

| 项 | 结果 |
|---|---|
| `node test-workbench.js` | **56 / 0** |
| `npx electron verify-workbench.js` | **23 / 0**（隔离 + 磁盘上无 IDE 键） |
| `verify-welcome.js` / `verify-agent-request.js` | 通过 / 41-0（回归：改过 openProject） |
| 纯 Node 全量 | **37 个脚本全通过** |
| 安全审计 | 高危 0 / 中危 0 |
| 门禁 | 空 catch 93 ≤ 95 |
| CI | 新增 `node test-workbench.js`（12 steps） |
