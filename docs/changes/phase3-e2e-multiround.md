# PH3-E2E-07～14：真实多轮 Agent 任务的**非成功路径**

- 日期：2026-09-26
- 新增：`desktop/test-agent-multiround.js`（**61/0**），已挂 CI

## 范围：01～06 记 NOT_RUN，07～14 做完

E2E-01～06（解释 / 诊断 / 只读调查 / 单文件改 / 双文件改 / 改后测试）**需要真实模型**
→ 按 RULE-3-01 记 **NOT_RUN**（见 PHASE3.md §6）。

这一批做的是 07～14 —— 同样是"真实多轮"，但**不依赖真实模型**，可用 Mock 完整验证。

## 它测的是"串起来能用"

单层测试都过 ≠ 串起来能用。这一批把前面几层**接在一起**跑：

| 项 | 串了谁 | 关键断言 |
|---|---|---|
| 07 Failure | agent-task + agent-verify | test 失败后**不再跑 run/health**；FAILED 是终态、没有出边 |
| 08 Retry | agent-verify | **没有 fix 就不硬重试**（盲目重跑只是把同一个失败再验一遍） |
| 09 Budget | agent-task + sandbox 预算 | 超预算 → `stopped=budget` + `TASK_BUDGET_EXCEEDED`，**步数很小**（真停了） |
| 10/11 Resume/Cancel | agent-task | 任何非终态可取消；已完成不能再取消；取消后**一个工具都没跑** |
| 12 Session Resume | session-view | 接**本项目**最近那条（**不跨项目**，哪怕别项目更新） |
| 13 Memory Reuse | memory-schema | 上任务**用户确认后**入库的事实，下任务能检索到；ERROR 未验证不入库 |
| 14 Cross-project | workspace + memory-schema | B 里看不到 A 的规则；`belongsTo` 用**工作空间身份**（大小写/斜杠不同仍同项目） |

## 一处我自己的错（第三次同型）

`createVerifyLoop(opts)` 里各步骤要放进 **`run({patch, deps})` 的 deps**，我第一版直接当
`opts` 传了 —— 于是 `apply` 步骤先挂。**又是没先看签名就写**（RULE-03）。

另外顶层 `await` + `require` 冲突**第二次**出现（Node 24 的
`ERR_AMBIGUOUS_MODULE_SYNTAX`），包进 `async main()` 解决。
