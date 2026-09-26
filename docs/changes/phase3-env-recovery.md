# PH3-ENV-01～10 + PH3-REC-01～09：环境自愈与启动恢复深化

- 日期：2026-09-26
- 新增：`desktop/env-recovery.js` + `test-env-recovery.js`（**58/0**，一次通过），已挂 CI

`startup-state.js` 保持不动（它已有 ENV_CHECKS / 标记与 planStartup，也已实现"崩过不搬现场"）。

## ★ PH3-REC-06 是这批最要紧的一条：异常退出**不搬现场**

| 上次怎么退的 | 恢复什么 |
|---|---|
| 正常退出 | 项目 + 标签 + 当前文件 + **滚动位置** + **Agent Session** |
| **异常退出（崩溃/强杀）** | **只恢复项目** —— 标签/文件/滚动/Session **一个都不恢复** |

为什么？**崩溃往往与被打开的文件内容有关**（比如某个文件让语法高亮炸了）。
把现场原样搬回来 = **把崩溃原因一起搬回来**，用户会陷入"一开就崩"。
宁可让用户自己再打开一次文件。

而且 `message` 会**明确告诉用户"上次是异常退出，所以没搬现场"**，
而不是悄悄少恢复几样让人以为丢数据了。

## "降级"是被**验证**的，不是写在文档里的

`simulateKill()` 造出"记录成 running 但不给 cleanExit"的快照 —— 这正是强杀后的真实状态。
测试用它走完整链路：强杀 → `planStartup` 判 `crash-degraded` → tabs 为 0、sessionId 为 null。
还验证了"崩溃后正常退出一次，下次就恢复现场"这条恢复路径。

## PH3-ENV-03：别把 MISSING 当 ERROR

四态 `AVAILABLE / MISSING / BROKEN / UNKNOWN`，且**只有 BROKEN 算"需要修的环境故障"**：

- `MISSING` = 没装 → 归 **optional**（按需安装）
- `BROKEN` = 装了但跑不起来 → 归 **blocking**
- `UNKNOWN` = 没探测（**不是 ERROR**）

摘要也分开说："没有环境故障；N 项未安装（按需）" vs "有 N 项环境异常"。

## PH3-ENV-04：PATH 补全（项目真踩过）

历史上真踩过：**Git Bash 里 PATH 正确、桌面快捷方式里 PATH 错误** → "任何项目都跑不起来"。
所以这里不假设 PATH 是对的：缺哪项就给它的**候选目录**，并提醒"先确认目录里确实有可执行文件"。
`BROKEN` 的**不**给 PATH 建议（装是装了，问题不在 PATH）。
