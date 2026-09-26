# PH3-IDE-04/05/12/13：Problem → 解释/修复 + 完成/失败通知

- 日期：2026-09-26
- 改动：`agent-request.js`、`agent-context.js`、`agent-request-main.js`、`renderer.js`、`preload.js`、`main.js`
- 验证：`verify-agent-request` 55 → **64/0**；`test-agent-context` 28/0

## PH3-IDE-04/05：对着**具体那一条**问题问 Agent

问题面板每一行现在有「解释」「修复」两个按钮。关键不是按钮，而是**上下文里带着哪一条**：

- 新增 `focusProblem`（`{ file, line, message, source, severity }`），从渲染侧一路穿到
  `AgentContext`，并**排在 `problems` 列表之前**——它代表"这次就是冲着它问的"，
  不该淹没在一片问题里。
- **两条判据必须一致**：`agent-request.js` 的 `normalizeProblem` 与 `agent-context.js` 的
  `createAgentContext` 都要求**有 message 才算一条问题**。第一版只在入参处判、上下文里没判，
  于是出现"入参被丢弃了但上下文里又冒出来"的怪事（测试当场抓到）。
- 行号取不到就**不写**（`file` 单独出现）——编一个行号会让 Agent 去看错地方。

**边界**：两个按钮都只是**入口**。Fix 也只走到"提议补丁、等用户确认"，
**P8 的确认闸不动** —— 不会因为从面板点一下就直接改文件。

## PH3-IDE-12/13：完成/失败通知

`agent:notify`（主进程 `Notification`）+ `agent:notified`（推回渲染侧）。
失败时通知带上**第一条问题的位置**，但**跳不跳文件由真实的 Problem 决定** —— 通知不自己编位置。
`notified` 字段**如实**反映系统通知到底弹没弹（无头环境弹不出来就是 `false`，不假装）。

## 两个真 bug（都是验证抓到的）

1. **`getWindow is not defined`** —— 我把 `agent:notify` 写进 `agent-request-main.js`，
   但那个模块的参数里**没有** `getWindow`。补上（并在 `main.js` 注入），
   且没注入时**如实报错**而不是静默不弹。
2. **判据不一致**（见上）：入参处丢弃、上下文处又收下。

## 过程中的操作失误（值得记）

这次连续三次把"**新增一行**"做成了"**替换掉那一行**"（`problems` 的 take、preload 的
`onAgentVerifyProgress`、还有一处），另有一次 `edit_file` 因为 `old` 末尾带换行、
`new` 没带而**吃掉一个换行**导致语法错。

> 教训：改相邻代码时，`old_string` 要**含住被保留的上下文**，不能只取"我要替换的那一行"。
