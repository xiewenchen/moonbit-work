# P9A：Ask / Understand —— 可验证的任务理解

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P9A-01～05 全部 DONE**

## 清单里那句约束决定了整个设计

> 这里的 Understand **不做「展示模型思维链」**。它应该是：**可验证的任务理解结果**。

所以 `task-understanding.js` 是**确定性推导**，不是让模型自述。每一栏都能指着说来源：

| 栏 | 来自 | 可核对方式 |
|---|---|---|
| `goal` | 用户那句话本身 | 字符串比对 |
| `project` | 真实 ProjectContext | 带 `source: 'projectContext'` |
| `relevantFiles` | 任务里提到的路径 / 当前文件 / 相关问题涉及的文件 | 每条带 `why` |
| `relevantProblems` | 统一 Problem Model 里匹配得上的 | 带 `id`（能点开）+ `file:line` |
| `proposedActions` | **规则**推出（不是模型编的） | 每条带 `rule` 说明为什么 |
| `constraints` | 门禁决定（不是模型自律） | `needsConfirmBeforeApply` / `canModifyFiles` |

**"理解错了"因此是能被看出来的** —— 这正是不做思维链的意义。

## 五项

| 任务 | 产出 |
|---|---|
| P9A-01 | `buildTaskUnderstanding(req, inputs, deps)`：结构 + 校验 + 冻结；`extractPathLike` 认路径（不会把 `/users` 当文件）、`extractKeywords` 抽关键词 |
| P9A-02 | 主进程 `agent:understand` IPC → 渲染侧可拿；`describeUnderstanding` 一行摘要 |
| P9A-03 | `aiagent.js` 里的**理解卡**：把六栏摊开，两个按钮「开始执行 / 取消」 |
| P9A-04 | `Auto-start / Confirm-first`（`localStorage: ag-autostart`，**默认 Confirm-first**） |
| P9A-05 | 取消 **不执行任何动作**（更不会去 Patch），只把原话读回输入框，方便改了再问 |

`applyLlmPlan(u, plan)` 是给 P9B 留的接口：**只允许覆盖 `proposedActions`**，
`goal / project / relevantFiles / relevantProblems / constraints` 是事实，模型改不了。

## 测试里抓到的两个**实现缺陷**（不是测试写错）

1. **`relevantFiles` 一开始把「所有」问题的文件都算作相关** ——
   于是"有问题"的文件会因为"它自己有错"而命中自己，`relatedFiles` 变成 `allProblemFiles`，
   "相关"就失去意义。改成**两阶段**：先算种子（任务提到的 + 当前文件）→ 用它匹配问题 →
   再把匹配到的问题涉及的文件并进来。
2. **`applyLlmPlan` 收到全非法的 plan 会把计划清空** ——
   等于"模型这次没给出可用计划"变成"不需要做事"。改成保留原计划。

## 验证

| 项 | 结果 |
|---|---|
| `node test-task-understanding.js` | **53 / 0**（含"事实栏不许被 LLM 改"的 6 条断言） |
| `npx electron verify-agent-request.js` | **35 / 0**（原 19 项 + P9A 16 项） |
| 纯 Node 全量 | **28 个脚本全通过** |
| `verify-agent-config.js` | **9 / 0**（改过 `aiagent.js`，必须回归配置弹窗） |
| 门禁 | 空 catch 94 ≤ 95；local-chk 通过（已迁移 6 个） |

**UI 是真点的**（不是只看接口）：设输入框内容 → 点发送 → 断言 `.ag-understanding` 出现、
文案含"能被核对的"、列出目标与项目、两个按钮文案正确 → 点「取消」→ 卡消失且原话回到输入框。

## 一个值得记的坑

第一版 UI 验证我 dispatch 的是**单个 Enter**，一直失败。查 `aiagent.js` 才发现本页快捷键是
**Ctrl/Cmd + Enter**。→ 改成**点发送按钮**，更贴近真实操作。

**教训**：验证要给"用户真正会做的动作"，而不是"我以为的快捷键" —— 否则测的是我的想象。

## 未做 / 剩余风险

- **Auto-start 的"直接跑"路径没有端到端验**（它会真调 opencode，依赖真实模型额度）。
  本批只验证了**默认 Confirm-first** 的理解卡路径 + `policy` 的传递。
- **`proposedActions` 目前是规则推的**；接到真实 LLM 后由 `applyLlmPlan` 覆盖（P9B/P9C）。
- 理解卡不提供"部分采纳"（只能整体开始或取消）—— 需要的话留给后续。

## review 后的修正（两个 should-fix 都是真问题）

1. **`exists` 有 workspace 穿越**：原实现是 `fs.existsSync(path.join(root, rel))`，
   而 `extractPathLike` 的字符集含 `.` 与 `/` —— 消息里写 `../../foo` 就能用它探测
   workspace 之外的路径是否存在（结果还会经 `relevantFiles` 回传）。已改为
   `path.resolve` 后校验 `path.relative` 不以 `..` 开头；并补了端到端断言
   （真的拿 `../../../../Windows/.../hosts` 试，必须被拒）。
2. **Auto-start 开关只有读取点、没有写入 UI**：原本只能靠 DevTools 改 `localStorage`，
   行为不可发现 —— 而 P9A-04 明确要求"允许配置"。已把开关做到理解卡上，
   并让文案写明它**只跳过这一步、不影响「改文件前必须确认」**；验证里断言了
   "开关存在 + 点它会真的写进 localStorage"。

另修三个 nits：中文关键词改成 **2 字滑窗**（原来「接口返回」整体成一个词，
只写「接口」的问题匹配不上）；**定位不到文件时不推 `proposePatch`**（改推 `locateFile`，
否则会得到一个"改哪里都不知道"的补丁动作）；补上 ⑦ 节对 `relevantProblems` 的断言。

顺带被空 catch 门禁抓到一次：新写的 `catch (_) {}` 让 `aiagent.js` 的 A 类从 5 变 6 ——
改成打 warning 而不是静默吞（**门禁起作用了**）。
