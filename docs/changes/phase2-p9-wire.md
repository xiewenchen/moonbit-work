# Phase 2 / P9 接线：把验证闭环接到界面

> 承接 P9-01～P9-11（闭环引擎已建、40 项单测通过，但只有注入点、没有真实依赖与界面）。
> 规则：RULE-01｜执行时间：2026-09-24（+08:00）

## 一、流程边界（这一步最重要）

清单里 P8 与 P9 是连着说的，但**两件事的"自动"程度必须不同**：

```
用户点 Apply（P8 的对话框）→ 文件落盘 → 【自动】check → test → run → health → 出报告
```

即：**改文件仍然要用户点确认**，而**验证是全自动的**。
所以闭环**没有**"自动改文件"的能力 —— 它的 `applyPatch` 实现就是
`async () => ({ ok: true, file })`（"这一步已经在用户确认时做完了"）。这样 P8 的 Gate 一点没松。

## 二、接线内容

| 层 | 内容 |
|---|---|
| `agent-verify-main.js` | 四个真实实现：`check` = `moon check --target native`（文本交给 P4 的 `fromCompilerOutput`）；`test`/`run` = **P3 的命令表**（与 UI 同一条路）；`health` = 对 `runner.result.url` 发一次请求 |
| IPC | `agentVerify:run` / `agentVerify:last` + 事件 `agentVerify:progress` / `agentVerify:done` |
| `renderer.js` | 进度走**输出面板**；失败项经新增的 `problems.add()` **灌进统一问题模型** → **问题面板直接看到** |
| `window.moonbitIDE.agentTools.verify` | `{ run, last }` |

闭环之后会 `project.stop`（跑失败时别把服务留着）。

## 三、验证：用**真实**的 "check 成功 / test 失败" 场景

本机（R12：MoonBit 原生工具链坏）恰好提供了一个**天然的真实场景**：

- `check`（`moon check --target native`）→ **成功**（这个本机是好的）
- `test`（`moon test --target native`）→ **失败**

于是闭环应当：`apply ✓ → check ✓ → test ✗` → **立刻停**（不跑 run/health）→ 报告 `VERIFY_FAILED`。

**结果：`npm run verify:agent-verify` → 17 / 0**

| 断言 | 说明 |
|---|---|
| check 通过 / test 未通过 | 真实工具链结果 |
| **失败即停：没有跑 run / health** | 关键行为 |
| 失败 → Problem（来源 = `test`） | 复用 P4 适配器 |
| 报告文本含"验证报告"与 `VERIFY_FAILED`、含步骤表 | P9-11 |
| **统一问题模型里出现 test 来源的问题** + **问题面板渲染出条目** + **输出面板出现报告** | 接线的意义：结果真的到了用户能看见的地方 |
| `last()` 与本次一致 | 状态可查 |

## 四、接线时抓到的两个问题

### 1. 真 bug：`Object.assign` 又把字段覆盖了 —— **与 P2 那次同型**

```js
steps.push(Object.assign({ name: step, ok: false, ... }, extra || {}))   // ✗
```

`extra` 来自命令表的结果，**带着自己的 `name: 'project.test'`** → 把我们的 `name: 'test'` 覆盖了。
后果：报告里那一步显示成 `project.test`，**按步骤名断言全都找不到**（测试里 `steps.find(s => s.name === 'test')` 返回 `undefined`）。

修法：让 `name: step` **最后**写。

> 同一个坑第二次踩（P2 是 `root` 被 `projectInfoCache` 覆盖）。**结论：凡是 `Object.assign({ ...默认值 }, 外部对象)`，
> 都要先想"外部对象可能带什么同名键"。** 这次连注释一起写进去了。

### 2. 第三次踩 `chk` 的语义坑

`verify-*.js` 用布尔语义 `chk(name, ok, detail)`，`test-*.js` 用相等语义 `chk(name, got, want)`。
我写 `chk('test 未通过', steps.find(...).ok, false)` —— 把**期望值** `false` 当条件传入 → 永远 FAIL。

修：`=== false` 显式比较。（这已经是**第三次**了，教训写进 §五。）

## 五、给未来的自己

| 教训 | 动作 |
|---|---|
| `Object.assign({ 默认 }, 外部)` 的键覆盖 | 永远让"我要的值"最后写；必要时连注释一起写 |
| 两种 `chk` 语义混用 | 写断言**一律显式比较**，不要传"值"当条件 |
| 步骤名会被外部结果污染 | 步骤表这类"枚举标识"必须自己说了算 |

## 六、验证汇总（RULE-01）

| 验证 | 结果 |
|---|---|
| `npm run verify:agent-verify`（新）| **17 / 0** |
| `node test-agent-verify.js`（措辞与覆盖顺序改过，回归）| **40 / 0** |
| 纯 Node 全量（16 个脚本）| **559 项断言全 0 失败** |
| **`npm run verify:demo`** | **7 步通过 / 0 步失败**（改了 main/preload/renderer，必须回归）|
| `check-empty-catch --ci` | 94 ≤ 95 |

## 七、P9 完成度

| 任务 | 状态 |
|---|---|
| P9-01 ～ P9-11（闭环 / 状态机 / 防循环 / 报告）| ✅ |
| **接线（主进程 + UI）** | ✅ **本批完成** —— 结果会出现在输出面板与问题面板 |
| P9-12 ～ P9-15（故障 Demo + 自动诊断/自动 Patch）| ❌ 需要真实 LLM |
| **Ask / Understand**（Gate M2 的另一半）| ❌ 需要真实 LLM |

> 现在 `fix`（自动修复提议）仍然只有注入点 —— **闭环能"证明改坏了没有"，但还不能"自己修"**。
> 这一步要等模型接进来（P12 Provider → Ask/Understand）。
