# PH3-OFFICE-02/05/06/07/08：办公与工程融合

- 日期：2026-09-26
- 新增：`office-fusion.js` + `test-office-fusion.js`（**62/0 一次通过**）+ `verify-office-fusion.js`（真注入 **37/0**）
- 已挂 CI；npm script `verify:office-fusion`

`office-link.js`（关联/预览/送 Agent/结论→便签）与 `workbench.js`（待办/便签）保持不动 ——
这一层补的是"**它们之间怎么接**"。

## 05：便签 → Agent Context

两条边界：
- **空的就不注入**（`noteToContext('')` 返回 `null`）—— 没写过的便签不该在上下文里占一格；
- **限量且如实说明**（超长截断并标 `truncated`，还说出原长是多少）。

## 06：待办 → Agent 任务（界面上就是 "Start with Agent"）

**最关键的一条：不猜意图。**
- `goal` 与发给 Agent 的 `prompt` **就是待办原文**，**不自动补**"请修复/请实现"之类的话术；
- 理由：**猜错意图会让 Agent 去做用户没要求的事 —— 那比不做更糟**；
- 需要补充说明的，由用户在点之前自己写进待办（`detail` 字段有就带、没有就是 `null`，**不编**）。

端到端验证真的从待办发起了一次请求，并断言 `request.message` **原样**等于待办文本。

## 02/07：关联 Task 与日历映射

- `linkToTask` 只改这条 link 的 `taskId`，**不动别的字段**（尤其 `projectRoot`）；
  `linksOfTask` 支持按任务筛（`taskId` 为空的归到 `null` 组）。
- `calendarToProjectTask` **只做映射**，不建日历系统（冻结项）；**拿不到时间就是 `null`，不编一个**。

## 08：不碰 ProjectContext —— 这次是**真验证**，不只是声明

`FUSION_SCOPE` 在代码里列清 `writes`（都在用户目录或 `.moonbit-work`）与
`neverWrites`（ProjectContext / 项目源码 / agent-rules.md / providers.json），
且测试断言两张清单**没有交集**。

**而且端到端真的验了一遍**：调完 `linkToTask` 与 `buildContext` 之后，
`getContext()` 的 JSON **逐字节相同**，且仍 `Object.isFrozen()`。

## 过程中的两次踩坑（都与"猜"有关）

1. **`git checkout` 把我这次刚加的注入也还原了** —— 我以为只回退了坏的那一处。
   之后又因为不确认文件里到底有没有 `ui-hierarchy`，插了两次（生成的 index.html 里出现了两遍）。
   **教训：回退文件后必须重新确认它的真实内容，不能凭记忆继续改。**
2. **`J()` 帮助函数不能包 async 表达式** —— 它做的是 `JSON.stringify(expr)`，
   而 `expr` 是 Promise 时得到 `"{}"`。这次改成"自己 `await` 再 `JSON.parse`"。
   同一处我还把 `eq` 与 `chk` 的参数用反了（`eq` 是相等语义）。
