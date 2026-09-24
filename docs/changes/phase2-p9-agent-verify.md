# Phase 2 / P9-01 ～ P9-11：Agent 验证闭环

> 对应任务：**MBW-P9-01 ～ P9-11**｜规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）
>
> 清单 P9 的意思：Agent 改完代码之后，必须**自己证明没改坏**。

## 一、闭环（P9-01 ～ P9-07）

```
apply → check → test → run → health
  任一步失败 → **立刻停** → 失败转成 P4 的 Problem → VERIFY_FAILED
```

**"立刻停"是刻意的**：check 挂了就没有必要再 test/run/health（那只会浪费时间和输出噪音），
而且**每多跑一步都会让"到底是哪一步坏的"更难判断**。测试直接断言了这一点：
check 失败时 `test/run/health` 的调用次数**都是 0**。

失败 → Problem 的来源映射（复用 P4 的适配器，不另造一套）：

| 步骤 | Problem 来源 |
|---|---|
| `check` | `compiler`（复用 `fromCompilerOutput`）|
| `test` | `test` |
| `run` | `runtime` |
| `health` | `api` |

## 二、防自我循环（P9-09 / P9-10）

```js
for (;;) {
  if (round >= maxRounds) { stoppedReason = '达到最大轮次'; break }
  round++
  last = await verifyOnce(...)
  if (last.ok) break
  if (round >= maxRounds) { stoppedReason = '达到最大轮次'; break }   // ← 轮次用尽就别再提议
  next = await fix(...)
}
```

三处收口：**轮次上限**（默认 3）、**没有 fix 就停**、**fix 抛错也停**。
所以"修复 → 失败 → 再修 → 失败 → 无限"这条路径**不存在**。

## 三、最终报告（P9-11）

`buildVerifyReport`（结构化）+ `renderVerifyReport`（人可读 Markdown）：

```
# 验证报告
- 结论：**失败（VERIFY_FAILED）**
- 修改文件：a.mbt
- 轮次：1 / 上限 2（停止原因：达到最大轮次（2））

| 步骤 | 结果 | 耗时 | 说明 |
| apply | ✓ | 0ms | |
| check | ✗ | 1ms | 编译失败 |

## 待处理问题（1）
- [error] /p/a.mbt:2 unbound
```

## 四、写测试时抓到两个真问题（都是"多余/冒泡"型的）

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | 轮次用尽后**仍然调用了一次 `fix`** | 白跑一次提议（结果没人用）| 把轮次检查提前到 `fix` 之前 |
| 2 | `fix` 抛错**直接冒泡**到调用方 | 一次坏提议就能让整个闭环崩掉（本该只让这一轮失败）| `try/catch` 包住，转成 `stoppedReason` |

第 2 个尤其值得记：**"防循环"的代码自己崩掉，就等于没有防** —— 那正是这条路径最危险的地方。

## 五、验证（RULE-01）

```bash
cd desktop && node test-agent-verify.js
```

**结果：40 通过 / 0 失败**

| 组 | 关键断言 |
|---|---|
| P9-08 状态机 | 7 个状态；**禁止跳级**（patched → verified 被拒）；终态无出边 |
| P9-01～07 成功 | 五步都跑且都 ok；`verified` |
| **失败即停** | check 失败 → **test/run/health 调用次数都是 0**；test/run/health 失败各自的 Problem 来源正确 |
| 异常 | 步骤抛错 → 转成失败（不冒泡）；apply 失败 → 一步都不往下跑 |
| **P9-09/10** | maxRounds=3 且一直失败 → **跑满 3 轮就停**、`fix` 只被叫 2 次、保留每轮结果 |
| | 第 2 轮修好 → 停且 ok；没提供 fix → 1 轮就停；**fix 抛错 → 停**（不无限重试） |
| P9-11 | 报告字段齐；渲染含结论/文件/步骤表/问题列表；成功路径写 VERIFIED |
| 来源映射 | check→compiler / test→test / run→runtime / health→api |

**回归**：纯 Node 全量 **16 个脚本 / 559 项** —— 全 0 失败；
`check-empty-catch --ci` **94 ≤ 基线 95**；CI YAML OK。

## 六、Gate M2 状态（诚实）

清单 Gate M2 要求的完整链条：`Ask → Understand → Read → Diagnose → Patch → Check → Test → Run → Health → Report`

| 环节 | 状态 |
|---|---|
| Read | ✅ P6（七个只读工具，接真实数据）|
| Diagnose | ✅ P4（统一 Problem 模型）+ P9（失败即转 Problem）|
| Patch | ✅ P8（默认拒绝/精确匹配/备份/回滚/UI 确认）|
| Check / Test / Run / Health | ✅ P9-01～07（失败即停）|
| Report | ✅ P9-11 |
| **Ask / Understand** | ❌ **未做** —— 这两环需要**真实的 LLM 产出 patch**（P9-12～15 的"故障 Demo + 自动诊断/自动 Patch"）|

**结论：Gate M2 的"自动化"那一半成立**（改完能自证 + 不无限循环 + 有报告），
**但"模型参与"那一半还没接** —— 也就是本批的 `fix` 目前只有注入点，没有真实的"让模型提议修复"。
把这条接上（需要可用的 LLM 额度）之后，M2 才算完整。

## 七、未做（下一批）

| 任务 | 说明 |
|---|---|
| P9-12～15 | 故障 Demo（语法/运行/逻辑三种错误）+ Agent 自动诊断/自动 Patch/自动 Verify —— 需要真实 LLM |
| 接线 | 把闭环接到主进程与 UI（现在是纯逻辑 + 40 项单测），并把 `renderVerifyReport` 的结果展示到界面 |
