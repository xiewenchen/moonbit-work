# P11：项目级记忆（只做"项目知识"，不做 MemoryOS）

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P11-01～09 全部 DONE**；`test-project-memory` **101/0**、`verify-project-memory` **38/0**

## 放在项目里的四样东西

```
<项目>/.moonbit-work/
  project.md        项目是什么（自动生成，人也可以改 —— 重新生成时保留「手工补充」）
  agent-rules.md    Agent 必须遵守的规则 —— **未经确认不可修改**
  context.json      机器可读的上下文（自动生成，带 schema 版本）
  history/          已验证的错误经验（experiences.json + 压缩归档 archive-<ts>.json）
```

**为什么放项目里**（而不是像 P10 的会话那样放用户目录）：
这是**项目的知识** —— 应该能随项目提交、被团队共享；会话则是"我这台机器上的对话记录"。
性质不同，位置就不同。代价是"写进项目就可能被提交"，所以规则文件有写保护。

## 各任务

| 任务 | 做法 |
|---|---|
| P11-01 | `memoryLayout()` 定义四个产物路径 |
| P11-02 | `renderProjectMd(ctx)` 自动生成；`extractHandWritten` 抠出「手工补充」区，重新生成时写回 |
| P11-03 | `buildContextJson` 带 `schema: moonbit-work/project-context@1`（可演进）+ 命令 + 文件列表 |
| P11-04 | `parseRules`：一行一条、`##` 分类、`!` 开头是硬约束。**不做 DSL** —— 规则是给人看的 |
| P11-05 | `canWriteRules`：无 `confirmed` 一律拒绝，并说明"规则约束的是 Agent 自己" |
| P11-06 | `createExperience`：`{error, solution, verified}`；**`verified` 默认 false**，IPC 层只收 `verified: true` |
| P11-07 | `searchExperiences`：关键词 + 文件 + verified + hits 加权，**只返回真的相关的** |
| P11-08 | `compressExperiences`：按指纹分组，同类超阈值合并（保留最近解法、累计 hits），**原条目先归档** |
| P11-09 | `deleteExperience`（按 id，找不到明确报错） |

## review 抓到的两个 blocking（都修了）

1. **规则写保护可以绕过**（真漏洞）。保护原本只在 `memory:writeRules` 这一条路径上，
   而 `fs:write` 是"接受任意绝对路径"的通用写口 —— 直接写
   `<root>/.moonbit-work/agent-rules.md` 就绕过去了。
   （`agent-sandbox.js` 的注释自己就写了 `fs:write` 接受任意绝对路径。）
   → 把判定提到**写盘这一层**：`fs:write` handler 加 `guardProtectedWrite`，两条路径共用同一条规则。
   端到端验了：直写被拒、传 `confirmed:1`（非真布尔）也不算、普通文件不误伤。
   **边界说清楚**：这拦的是"顺手写 / Agent 自动写"，**不是**防恶意 renderer
   （renderer 本来就能传 `confirmed:true`）。真正的 Agent 写路径是 `agent-patch`，那条另有一套危险表。

2. **`extractHandWritten` 会丢用户内容**。原来用 `/^## /m` 找结尾，会命中补充区里的
   `### ` 三级标题（`^## ` 匹配 `### ` 的前三个字符），**后面的内容在重新生成时被静默丢弃**。
   → 改成只认顶层 `## `（排除 `###`）。另加两道保护：
   - 若 `project.md` 存在但**找不到"由 MoonBit Work 自动生成"标记**（说明被手工改写/替换过）
     → **跳过刷新**，宁可不刷新也不拿模板盖掉；
   - 正常刷新前先写一份 `project.md.bak`。

## 另修的 should-fix / nits

- **压缩会丢数据**：`removedIds` 只有 id，被合并条目的 `error/solution` 就**找不回来了**。
  → 新增 `archiveExperiences`，压缩时把原条目写进 `history/archive-<ts>.json`（压缩可以"合"，但不能"丢"）。
- **id 会撞**：原来只用 `Date.now()`（毫秒），同毫秒批量添加会撞 id，之后按 id 删会一次删多条。
  → 加自增序号。
- `created.includes(L.context)` 恒为假（已存在的 context.json 也被记成"新建"）→ 直接 push。
- 规则模板里的占位符 `- （在这里写…）` 会被 `parseRules` 当成**一条真规则**读给 Agent
  → 改成 HTML 注释行（注释不会被解析成规则；并加了断言）。

## 诚实边界

- **规则写保护的威胁模型**：挡"顺手写/Agent 自动写"，不挡恶意 renderer（见上）。
- **检索阈值偏松**：单个泛词命中 + `verified(+2)` 就能过 `minScore=2`。已堵掉"只靠 verified 过阈值"，
  但阈值本身仍偏松 —— 宁可多给一条相关经验，也不要漏掉有用的那条。
- **压缩按"相同句式"合并**：指纹只归一数字与字面量，**标识符不归一**
  （否则"类型不匹配"和"变量名打错"会被合到一起）。所以是"宁少合并、不误合并"。
- `history/` 会随使用增长（有归档，但没有清理策略）。

## 验证

| 项 | 结果 |
|---|---|
| `node test-project-memory.js` | **101 / 0**（含 store 层真写盘、加固节 13 条） |
| `npx electron verify-project-memory.js` | **38 / 0**（含"fs:write 绕不过去"） |
| 纯 Node 全量 | **31 个脚本全通过** |
| `verify-welcome.js` | 7 项通过（改过 `fs:write`，回归通用写文件路径） |
| 门禁 | 空 catch 94 ≤ 95；local-chk 通过 |
| CI | 新增 `node test-project-memory.js`（11 steps） |
