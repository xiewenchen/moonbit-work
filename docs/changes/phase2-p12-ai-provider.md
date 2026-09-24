# Phase 2 / P12-01 ～ P12-11：AI Provider Center

> 对应任务：**MBW-P12-01 ～ P12-11**｜规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）

## 一、清单里反复强调的三件事，做成了代码保证

| 要求 | 实现 | 验证方式 |
|---|---|---|
| **P12-07** 界面只显示 `sk-****1234` | `maskKey`：只保留**出名的** `sk-` 前缀与后 4 位；短于 12 位一律 `****` | 断言 mask 结果，并断言"中间段不出现" |
| **P12-08** Key 不进日志 | `redactForLog` / `logSafe` | **断言整包序列化后不含完整 Key**（含深层嵌套）|
| **P12-09** Key 不进项目目录 | 沿用既有 `~/.config/opencode/opencode.jsonc`（在 workspace 外）| 记录现状 |

## 二、产出：`desktop/ai-provider.js`

| 任务 | 内容 |
|---|---|
| P12-01 | `createProvider` / `validateProvider`（**返回可读的错误列表**，不是一个 `false`）|
| P12-02～05 | 四种预设：OpenAI 兼容 / DeepSeek / Ollama（本地，不需 Key）/ 自定义 |
| P12-06 | `testConnection` → `{ ok, latency, model, status, error }`，探测 `/models` |
| P12-07/08 | `maskKey` / `redactProvider` / `redactForLog` / `logSafe` |
| P12-10 | `mergeProviders(global, project)`：**同名的项目级覆盖全局**，并标上 `scope` |
| P12-11 | `listForUi`：给界面/Agent 的清单**全部脱敏** |

## 三、写测试时抓到的真 bug（而且正好在最危险的路径上）

```js
if (typeof value === 'string') return value     // ✗ 字符串直接原样返回
```

于是 `redactForLog` 对**字符串里的 Key** 完全没处理 —— 而**最危险的泄漏路径恰恰是错误信息**：
有的服务会把 Key 回显在错误体里（`'invalid key sk-proj-…'`）。

后果：`testConnection` 的 `error` 字段、任何塞进日志的错误字符串，都会**带着完整 Key** 出去。

修法：新增 `redactText`，对字符串里**出名的 Key 格式**（`sk-…` 与 `Bearer …`）做替换；
刻意只认这两种格式，避免误伤正常文本（例如文件路径、哈希）。

> 这条值得单独记：**脱敏实现最容易漏的就是"字符串内部"** ——
> 按字段名脱敏只覆盖结构化数据，一旦错误信息是拼出来的字符串就漏了。

## 四、验证（RULE-01）

```bash
cd desktop && node test-ai-provider.js
```

**结果：44 通过 / 0 失败**

| 组 | 关键断言 |
|---|---|
| P12-07 | `sk-…` → `sk-****1234`；中间段不出现；非 sk- 长串 → `****后4位`；**短串一律 `****`** |
| **P12-08** | `redactProvider` 后不含原文；**深层嵌套**（对象/数组/`authorization`/`password`）序列化后不含原文；错误字符串里的 Key 也被遮 |
| P12-01 | 归一（trim / 尾斜杠 / 预设填充 / `enabled` 默认 true）；校验的错误列表逐条正确 |
| P12-02～05 | 四种预设齐备且端点/模型正确；Ollama 不需要 Key |
| P12-06 | 成功 → ok + latency + model；**请求头确实带 Authorization**；失败时 **error 已脱敏**；缺 Key 先被校验拦住；`request` 抛错/未注入都明确报错 |
| P12-10 | 项目同名覆盖全局、`scope` 正确、并集顺序、空输入不抛 |
| P12-11 | 切换所需字段齐备，且**给界面的 Key 是脱敏的** |

**回归**：纯 Node 全量 **17 个脚本 / 603 项断言** —— 全 0 失败；
`check-empty-catch --ci` **94 ≤ 基线 95**；CI YAML OK。

## 五、未做（下一批）

| 任务 | 说明 |
|---|---|
| 接到 UI | Provider 面板（列表 / 编辑 / Test Connection 按钮 / 显示脱敏 Key）|
| 接到 `agent.js` | 用 `listForUi` + 选中的 provider 去驱动 opencode 的配置写入（P12-11 的切换）|
| 与 Ask/Understand 对接 | Provider 通了之后，才能让模型真的产出 patch（Gate M2 的另一半）|
