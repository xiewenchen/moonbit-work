# Phase 2 / P1-19：把 Run 状态机接进主流程（接线）

> 对应任务：**MBW-P1-19**｜规则：RULE-01 / RULE-02 / RULE-04
> 执行时间：2026-09-24（+08:00）
> 前置：P1-07～P1-13（URL Detector）、P1-14～P1-18（生命周期原语）、MBW-X1（E2E 骨架）

## 一、范围（RULE-03）

| 类别 | 内容 |
|---|---|
| **本轮做** | 把 `run-state.js` 的状态机 / ProcessHandle / 流事件 / RunResult 接进 `createServiceRunner`，并按清单规定的顺序执行 |
| **允许修改** | `desktop/runners.js`、`desktop/test-run-e2e.js`、`docs/` |
| **禁止修改** | `renderer.js`、`main.js`、`preload.js`（IPC 契约只扩不改）、`*.mbt` |

**清单要求的顺序**：`spawn → collect output → detect URL → update state → open browser`。

## 二、改了什么

`createServiceRunner` 现在是状态机的宿主：

```
start():  reset → IDLE → BUILDING → (spawn) → STARTING
   │                                            │
   │ 收到含本地 URL 的输出 ── detect ──→ STARTING → RUNNING ──→ open browser
   │                                            （顺序：先更新状态，再开浏览器）
stop():   RUNNING/STARTING → STOPPING → (进程 close) → STOPPED
崩溃:     STARTING/RUNNING → FAILED        「被停」与「自己崩」分开判定
```

| 接入项 | 做法 |
|---|---|
| 状态机（P1-14/15） | `createRunStateMachine()`；`start()` 先 `reset()`（清单允许的「重新进入 Run 流程」）|
| ProcessHandle（P1-16） | 包装 child：`pid / command / cwd / startTime / status`，`stop()` → SIGTERM；`recordExit(code, signal)` |
| 流事件（P1-17） | `onStreamEvent({stream, chunk, timestamp})`（新增）；**`onData(chunk)` 旧签名保留**，renderer 不受影响 |
| RunResult（P1-18） | `onEnd` 的 payload = 原有 `code/error` + **RunResult 全量字段**（`ok/status/exitCode/url/stdout/stderr/duration/error`）+ `state` |
| 状态上报 | 新增 `onState(state)` 回调（IPC 层发 `runner:state`；renderer 暂未消费，留给 P1-21 的界面提示）|

### 顺带修掉的两个真实缺陷（**测试抓到的**，不是想出来的）

| # | 缺陷 | 表现 | 修复 |
|---|---|---|---|
| 1 | **`stop()` 进 STOPPING 时没有上报状态** | `onState` 收不到 `STOPPING`（状态流转少一环，界面无从反映"正在停止"）| 保存本轮 handlers，在 `stop()` 里 `emitState()` |
| 2 | **`spawnRunner` 的 `close` 丢掉了 `signal`** | 被信号终止时 `code=null`，前端只能看到 `exit -`，无法区分「被杀」与「正常退出」| `child.on('close', (code, signal) => onEnd({ok:true, code, signal}))`，并传给 `recordExit` |

### 两个防串台的关键标志

1. **`runSeq`**：第 N 次运行的进程 close 事件如果迟到（用户已经点了第二次运行），会被丢弃 —— 否则**上一轮的迟到事件会把新一轮的状态打成 FAILED**。
2. **`finished`**：`error` 与 `close` 可能都触发，保证 `onEnd` **只上报一次**。

### 资源保护

`stdout` / `stderr` 各留 **64 KiB** 进 RunResult（`slice(-MAX_CAPTURE)`），避免长跑服务把内存吃穿。

## 三、验证（RULE-01）

`desktop/test-run-e2e.js` 从 **17 项扩到 31 项**，新增的三组都过了：

| 组 | 断言 | 结果 |
|---|---|---|
| ⑨ 状态流转与顺序 | start 后 `STARTING`；**抓 URL 时状态已是 `RUNNING`**（证明顺序是 detect → update state → open browser）；打开浏览器时也是 `RUNNING`；stop 后 `STOPPING`；结束后 `STOPPED`；`onState` 三个状态都收到 | 全 PASS |
| ⑩ RunResult | 8 个字段齐全、`status=STOPPED`、`url` 记进结果、`duration ≥ 0`、`stdout` 含服务输出、`ok=true`、renderer 依赖的 `code` 字段仍在 | 全 PASS |
| ⑪ 流事件 | `{stream, chunk, timestamp}` 形状正确 | PASS |

**结果：31 通过 / 0 失败**

**回归**（全量纯 Node）：

| 脚本 | 结果 |
|---|---|
| `test-runner-detect` / `test-project-detect` / `test-relay` | 18 / 12 / 25（0 失败）|
| `test-url-detect` | 29 / 0 |
| `test-run-state` | 48 / 0 |
| **`test-run-e2e`** | **31 / 0** |
| `check-empty-catch --ci` | **94 ≤ 基线 95**（接线顺带把一处 A 类空 catch 变成有代码的 catch）|
| Electron 回归 `verify-run-dispatch` | 见下方 |

## 四、覆盖映射（更新）

| 任务 | 之前 | 现在 |
|---|---|---|
| P1-19 修复 Run → URL → Browser | E2E 骨架 | ✅ **接线完成**（顺序有断言）|
| P1-20 浏览器打开单独测试 | 部分 | ✅ 覆盖 |
| P1-21 浏览器失败测试 | 部分 | ✅ 覆盖（且浏览器结果**单独一路**上报）|
| P1-22 / P1-23 / P1-24 / P1-26 | 部分 | ✅ 覆盖 |
| **P1-25 无监听超时** | BLOCKED | ❌ **仍未做** —— 需要引入「STARTING 超时」语义 |
| **P1-27～P1-29 连续 10 次 / 红线** | BLOCKED | ❌ **仍未做** —— 紧接着下一批做 |

## 五、未做

- **P1-25**：无监听服务超时（`STARTING → timeout → FAILED`）。需要一个可配的超时窗口 + 定时器，属独立任务。
- **P1-27～P1-29**：连续 10 次 Run / Run-Stop ×10 / 红线（0 卡死、0 browser 错误、0 zombie、0 永久 STARTING）。
- `renderer` 侧消费 `runner:state` / `runner:browser`（界面提示）—— 属 P1-21 的 UI 部分。
