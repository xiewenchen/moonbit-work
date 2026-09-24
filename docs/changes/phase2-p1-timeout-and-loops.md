# Phase 2 / P1-25 与 P1-27～P1-29：启动超时 + 连续 10 次

> 对应任务：**MBW-P1-25**（无监听服务超时）、**MBW-P1-27～P1-29**（连续 10 次 / 红线）
> 规则：RULE-01 / RULE-02
> 执行时间：2026-09-24（+08:00）

## 一、P1-25：启动超时（`STARTING → timeout → FAILED`）

### 关键设计决策：**inactivity 语义**，不是「从 start 算起」

第一版写成「从 start 计时 N 秒」，随即发现**它会伤到真实使用**：

> `hello` 首次 native 编译要几分钟（P1-05 实测 25 秒时还在编译）——
> 若按「从 start 算起」，用户点「运行」后 30 秒进程就被判超时**杀掉**，
> 恰好违背「运行项目能看到效果」这个 IDE 的核心目标。

所以改成**从「最后一次输出」算起**：

```js
const DEFAULT_START_TIMEOUT = 60000            // 默认：连续 60 秒无输出才判失败
// onChunk 里：if (state === STARTING) armStartTimer()   ← 每次有输出就重新计时
```

| 场景 | 行为 |
|---|---|
| 编译很久但一直吐日志（hello 首次编译） | **不超时**（每次输出重置计时）|
| 进程起来了、不监听也不输出（黑洞） | 超时 → FAILED，且**主动 kill 掉进程**（不留孤儿）|
| 正常起服务并打印 URL | 进 RUNNING 时 `clearStartTimer()` |

`startTimeout` 可配（`createServiceRunner({ startTimeout })`）；`<= 0` 表示不启用。

## 二、P1-27～P1-29：连续 10 次 / 红线

| 任务 | 断言 |
|---|---|
| **P1-27** Run × 10 | 10 次都进入 `RUNNING` 且拿到 URL（10/10）|
| **P1-28** Run/Stop × 10 | 10 轮都停在 `STOPPED`；每轮的 pid **用 `process.kill(pid, 0)` 逐个复核已退出**（0 僵尸）；每轮都是新进程 |
| **P1-29** 红线 | **0 zombie / 0 永久 STARTING / 0 browser 错误 / 没卡死**（10 轮上限 60s，实测约 6s）|

> 「0 renderer 卡死」在纯 Node 里无法直接验，用「10 轮总耗时 < 60s」作为等价代理指标。

## 三、本轮还修掉一个**测试自身的缺陷**（flaky）

第一次把 `test-run-e2e.js` 放进「全量循环 + 后台还在跑 Electron」的条件里跑，
结果出现 **45 通过 / 2 失败** —— 单独跑却稳定 47/0。

**根因**：两个超时测试的窗口设得太紧（800ms / 700ms），而 Node 进程**冷启动**时间在负载下会超过它 →
「第一次输出还没到，定时器就先到期」→ 误判超时。

**修复**：把测试窗口放宽到 1500ms（并相应拉长观察窗口）。
**验证**：在**同样的并发负载条件下**连跑 3 次，稳定 **47/0**。

> 这不是产品缺陷，是**测试脆弱性**；但它同样值得记 —— 一个 flaky 的 E2E 会让后面所有人不再相信红灯。

## 四、验证

```bash
cd desktop && node test-run-e2e.js
```

**结果：47 通过 / 0 失败**（从 31 扩到 47）

| 组 | 内容 |
|---|---|
| ⑫ | 无监听 → 超时 → FAILED，错误信息含「超时」，进程被清掉 |
| ⑬ | Run × 10：10/10 进 RUNNING 并拿到 URL |
| ⑭ | Run/Stop × 10：10 轮都 STOPPED、0 僵尸、每轮新进程 |
| ⑮ | 红线：0 zombie / 0 永久 STARTING / 0 browser 错误 / 没卡死 |
| ⑯ | **inactivity 语义**：持续输出（模拟编译中）**不会**被误杀 |

全量回归：`runner-detect` 18/0、`project-detect` 12/0、`relay` 25/0、`url-detect` 29/0、`run-state` 48/0；
`check-empty-catch` **95 = 基线**；Electron `verify-run-dispatch` **5/5**。

## 五、Gate M1-A 逐项对照（诚实）

| Gate M1-A 要求 | 状态 | 依据 |
|---|---|---|
| run-url 5/5 | ❌ **被 R12 阻塞** | `verify-run-url.js` 要真跑 MoonBit `hello`，而本机 `moon build --target native` 全目标 EXIT=127 |
| run-dispatch 5/5 | ✅ | 本轮复测 5/5 |
| 错误项目 PASS | ✅ | `test-run-e2e` ⑥（可执行文件不存在 → onEnd 报错）|
| timeout PASS | ✅ | ⑫ + ⑯ |
| Run × 10 PASS | ✅ | ⑬ |
| Run/Stop × 10 PASS | ✅ | ⑭ |
| demo rehearsal 不再因 run-url 失败 | ❌ | 同 run-url（同样依赖 native 构建）|

**结论：Gate M1-A = 5/7，不能宣布通过。** 剩下两项**不是代码问题**，而是「验证手段依赖本机 MoonBit native 工具链」。

### 建议的解法（下一步，未做）

`verify-run-url.js` 的靶子**不必是 MoonBit 项目** —— 它的目的是验证
「IDE 的 Electron 集成链路：点运行 → 抓 URL → 开浏览器」。把靶子从 `hello/` 换成
`desktop/testdata/fixture-http-server.js`（零依赖 Node 服务）后：

- **本机可跑**（不再需要 `moon build`）→ run-url 有望 5/5；
- 进而 demo rehearsal 那一步也能过 → Gate M1-A 7/7。

代价：改动一个验证脚本（属独立任务，按 RULE-02 单独做）。
