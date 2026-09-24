# Phase 2 / P4-01 ～ P4-09、P4-11、P4-12：Problem Model

> 对应任务：**MBW-P4-01 ～ P4-09**（定义 / 六类适配器 / Store）、**P4-11**（去重）、**P4-12**（生命周期）
> 规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）
> **本批只建模型与 Store**；接到问题面板与编辑器高亮（P4-10 点击跳转）属下一批。

## 一、为什么要统一

现状（P4 之前）：

| 来源 | 现在去哪 |
|---|---|
| LSP / `moon check` 诊断 | `lastDiags` → `renderProblems()` |
| 运行时堆栈 | `runtimeLocs` → 自己一套高亮 |
| …… | 各自渲染各的 |

清单 Gate P4 要求：**LSP / 编译 / 运行时 / 测试 / Agent 五类问题统一到一处**。

## 二、产出：`desktop/problem-model.js`（纯逻辑）

| 任务 | 内容 |
|---|---|
| P4-02 | `SEVERITY` = error / warning / info（带排序权重）|
| P4-01 | `createProblem`：`id/source/severity/message/file/line/column/code/timestamp/lifecycle`，字段一律归一（`col → column`、非数字行号 → 1、空 file → null）|
| P4-11 | `fingerprint`：**来源+位置+严重度+code+消息(前 120 字)**；Store 用它当 id → **去重是结构性的** |
| P4-09 | `createProblemStore`：`add / replaceSource / list / get / fix / ignore / clear / stats / history` |
| P4-12 | `PROBLEM_LIFECYCLE` = open / fixed / ignored（流转时移出 current、保留到 history）|
| P4-03～08 | 六个适配器（见下）|

### 适配器策略：只做**可靠**的转换

| 适配器 | 输入 |
|---|---|
| `fromLspDiagnostics` | 结构化诊断（形状与 `lsp-parse` 一致）|
| `fromCompilerOutput` | `moon check` **文本** —— **复用已有的 `parseDiagnostics`**，不重写正则 |
| `fromRuntimeLocs` | 结构化位置（renderer 已有堆栈解析，不重复解析）|
| `fromTestResult` | `{name, ok, message, file, line}`（通过的用例**不产生**问题）|
| `fromApiResult` | `{ok, method, url, status, error}`（5xx → error，4xx → warning）|
| `fromAgentFinding` | `{message, severity, file, line}`（无 message 的被过滤）|

> 刻意不写"从任意日志文本里猜问题"的正则 —— 那种解析很脆，且会把噪音当问题。
> 文本解析只在**格式确定**的地方做（编译输出）。

## 三、写测试时抓到的两个语义缺陷（都已修）

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | `replaceSource` 把该来源**所有** OPEN 都标 FIXED，包括**还会再出现**的那些 | `history` 被"其实没消失"的条目污染 | 先算**差集**：只把新一批里 `!nextIds.has(id)` 的标 FIXED |
| 2 | 同一问题再次 `add` 会刷新 `timestamp` | 上限淘汰按 timestamp 时，**老问题会被当成新问题**丢掉 | `addOne` 里保留 `prev.timestamp`（"这个问题从何时开始存在"）|

第 1 个是**真缺陷**：`replaceSource` 的典型用法是"重跑一次 check"，若语义错了，
每次重跑都会往 history 里塞一堆假 FIXED。

## 四、验证（RULE-01）

```bash
cd desktop && node test-problem-model.js
```

**结果：46 通过 / 0 失败**

| 组 | 覆盖 |
|---|---|
| P4-01/02 | 字段归一（怪 severity/source/行号）、`id` 缺省 = 指纹 |
| **P4-11** | 同问题 → 同 id；**相同错误加 100 次 → 只剩 1 条** |
| P4-09 | 排序（error 优先，再按 file/line）、按来源/严重度/文件过滤、`stats` |
| P4-09 | **`replaceSource` 差集语义**：重跑后消失的进 history、仍在的留在 current、不动别的来源 |
| P4-12 | `fix`/`ignore` 移出 current 进 history；对不存在 id → `null`；`clear(来源)` / `clear()` |
| 上限 | `limit=3` 时丢**最旧**（按 timestamp）、被挤掉的标 `evicted` |
| 适配器 | 编译器样本（真实 `moon check` 格式）→ 2 条且字段正确；测试通过的不产生问题；API 5xx/4xx 分级；Agent 过滤无 message |
| **Gate P4** | 五类来源写进同一个 Store → `list()` 能同时看到 5 类、按严重度排序、`stats` 覆盖五类、替换一类不影响其它类 |

**回归**：纯 Node 全量 25 / 12 / 25 / 29 / 48 / 43 / 44 / **46** / 51 —— 全 0 失败；
`check-empty-catch --ci` **94 ≤ 基线 95**；CI YAML OK（已把 `test-problem-model.js` 挂进桌面纯逻辑段）。

## 五、未做（下一批）

| 任务 | 说明 |
|---|---|
| P4-10 | 点击 Problem 跳转到文件/行（UI 行为）|
| 接到 renderer | 把 `lastDiags` / `runtimeLocs` 改为统一进 Store；问题面板从 `store.list()` 渲染 |
| Agent 写入 | P4-08 的适配器已就位，等 P6/P7（Agent 只读/执行）时接上 |
