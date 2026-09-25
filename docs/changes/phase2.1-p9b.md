# P9B：AI Adapter + MockLLM —— 让 Agent 的测试不依赖真实额度

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P9B-01～08 全部 DONE**；`test-agent-adapter.js` **69 / 0**（纯 Node，已挂 CI）

## 两项设计约束（都做成"结构性"的）

| 任务 | 做法 |
|---|---|
| P9B-01 | `agent-adapter.js` 三个接口：`generate` / `stream` / `toolCall`；归一化 OpenAI 兼容返回（含 `tool_calls` 的参数字符串解析，**解析失败不抛、原样留在 `__raw`**） |
| P9B-02 | **本文件里不出现任何厂商名**，也不 `require('./ai-provider')` —— 只接受一份 `{baseUrl, model, apiKey}` 与"能发 HTTP 的东西"。所以"换模型"永远不需要改 Agent 代码 |

> **口径要说清**（review 提醒）：P9B-02 的断言查的是**文本口径**（源码里没有厂商名、没有 require 具体 provider 模块），
> 不等于"架构上不可能被破坏"。要更强得看 import 图。断言名字已经改成写明口径。

## MockLLM（P9B-04）—— 这条单列是有道理的

只要测试依赖真实额度，它就会变成"偶尔能跑"，然后**就没人跑了** ——
而失败场景、无限循环、Patch 这些最需要被测的路径首当其冲。

所以 MockLLM 的接口与 adapter **完全一致**（`generate`/`stream`/`toolCall`/`describe`），
才能被**真正替换进去**；另带 `isMock: true`，让测试能断言"这轮确实没连真网"。
脚本支持 `{text}` / `{toolCalls}` / `{error}` / `{reject}` / `{repeat: n}` / `{repeat:'infinite'}`。

## 组合才是重点（P9B-05～08）

测试不是"各自单测完就算"，而是把 MockLLM + **真实工具注册表** + **真实补丁流程** + **真实预算** 拼起来：

| 任务 | 验的是 |
|---|---|
| P9B-05 | LLM 要 `readFile` → 真跑只读注册表 → 工具结果**回灌**给模型（断言第二轮 messages 里有 `role: 'tool'`） |
| P9B-06 | 模型要求 `proposePatch` → **被只读表拒绝**（这正是"Agent 不能自己写"的保证）；另用真实 `applyPatch` 验"未经确认不写盘"（Gate P8） |
| P9B-07 | 非法工具 / 畸形 JSON 参数 / 非 JSON 返回 / HTTP 500 / 网络层错误 / 模型直接抛 —— 六条路径都不把异常漏出去 |
| P9B-08 | **无限规划被预算截断**：`repeat:'infinite'` 一直要 `run` → 在 `maxCalls: 3` 处停下（`stopped: 'budget'`，恰好消费 3 次）；无预算时由 `maxSteps` 兜底且 `ok:false`（**不伪装成功**） |

**预算检查放在"执行工具之前"** —— 一轮返回 N 个调用就扣 N 次额度，所以"一次多要几个"也绕不过去。

## review 抓到的两个真问题（都不是测试写错）

1. **apiKey 可能上浮**：原来把注入 `request` 返回的 `r.error` 原样透传，而注释写着"交给上层脱敏"——
   **那个上层不存在**（全仓只有 `ai-provider.js` 有 `redactText`，而 adapter 明确不 import 它）。
   注入的 request 实现常把 headers 拼进错误信息，`Authorization: Bearer sk-...` 会直接冒到日志/界面。
   → 改为**内置兜底脱敏**（遮 `sk-…` / `Bearer …` / JSON 里的 apiKey 字段），也允许调用方注入更严格的 `redact`。
   并补了 5 条断言（网络错误、错误体回显、保留可读部分、标 HTTP 状态、自定义 redact）。
2. **`mock-llm` 的 `repeat:n` 基本失效**：`pick()` 无条件 `idx += 1`，导致 `repeat:2` 实际只重复 1 次；
   旁边还有一行 `idx = Math.max(idx, 0)` 的**恒等死代码**，正好暴露本意（"用完了才前进"）被写反。
   而这条当时**零覆盖**，所以一直没暴露。→ 修好 + 补测试（含 `repeat:'infinite'`）。

另修 nits：同轮多个工具调用**合并成 1 条 assistant + N 条 tool**（逐个发 assistant 严格上游可能不认）；
`budget.tryConsume()` 包 try/catch；把 `<= 4` 收紧成 `=== 4`。

## 诚实边界

- **adapter / runToolLoop 尚未接入任何生产路径**（`main.js` / `agent.js` / `agent-request-main.js` 都没引用它们，
  全仓 grep 只命中自身与测试）。所以：
  - 上面那个脱敏缺口**当前不会在真实请求里爆**，但 P9C 接线时**必须**落实（现在已有内置底线）；
  - "Provider 激活 → Agent 真跑"目前验到"adapter 用对了 baseUrl/model"，**没有**真的发出一次模型请求。
- `stream` 在没有注入 `requestStream` 时**如实标 `streamed: false`**（不假装在流）。
- `generate` 本身不扣预算 → 纯文本的无限规划只能靠 `maxSteps` 兜（已在测试里写明）。

## 验证

| 项 | 结果 |
|---|---|
| `node test-agent-adapter.js` | **69 / 0**（八节，正好对应 P9B-01～08） |
| 纯 Node 全量 | **29 个脚本全通过** |
| `verify-agent-request.js` | 41 / 0（回归） |
| 门禁 | 空 catch 94 ≤ 95；local-chk 通过 |
| CI | 新增 `node test-agent-adapter.js`（11 steps） |
