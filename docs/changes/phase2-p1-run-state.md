# Phase 2 / P1-14 ～ P1-18：Run 生命周期原语

> 对应任务：**MBW-P1-14 ～ MBW-P1-18**｜规则：RULE-01 / RULE-02 / RULE-04
> 执行时间：2026-09-24（+08:00）

## 一、范围与边界（RULE-03）

| 类别 | 内容 |
|---|---|
| **本轮做** | 建四件套原语：状态枚举、状态转换/状态机、ProcessHandle、统一的流事件、RunResult |
| **本轮不做** | **接线**（把状态机接进 `createServiceRunner` 的主流程）—— 那是 **P1-19**，按 RULE-04 渐进迁移单独做 |
| **允许修改** | 新增 `desktop/run-state.js`、新增 `desktop/test-run-state.js`、`.github/workflows/ci.yml`、`docs/` |
| **禁止修改** | `desktop/runners.js`（本轮不动）、`renderer.js`、`main.js`、`preload.js`、`*.mbt` |

**为什么这批能在当前环境做**：全是纯逻辑，不 spawn 进程、不 require electron、不需要 MoonBit native 构建 →
不受 **R12**（本机 `moon build --target native` 全目标 EXIT=127）影响。

## 二、产出：`desktop/run-state.js`

| 任务 | 导出 | 要点 |
|---|---|---|
| P1-14 | `RUN_STATE` / `ALL_STATES` / `TERMINAL_STATES` / `isState` | 7 个状态；**`Object.freeze`**（改不动）；未知状态被拒 |
| P1-15 | `ALLOWED_TRANSITIONS` / `canTransition` / `createRunStateMachine` | 转换表 + 状态机（`to` / `canGo` / `history` / `isTerminal` / `reset`）|
| P1-16 | `createProcessHandle` | `pid / command / cwd / startTime / status` + `stop()`(SIGTERM) / `kill(signal)` / `recordExit(code)` |
| P1-17 | `STREAMS` / `createStreamEvent` | `{ stream: 'stdout'\|'stderr', chunk, timestamp }`；非法流名被拒 |
| P1-18 | `createRunResult` | `ok / status / exitCode / url / stdout / stderr / duration / error`（类型归一）|

### 转换表（严格照清单）

```
允许： IDLE→BUILDING
       BUILDING→STARTING | FAILED
       STARTING→RUNNING | FAILED | STOPPING
       RUNNING→STOPPING | FAILED
       STOPPING→STOPPED
禁止： STOPPED→RUNNING   FAILED→RUNNING   ← 除非重新进入 Run 流程
```

「重新进入 Run 流程」在本实现里是 **`reset()` → IDLE**；终态**没有任何出边**（测试断言 `STOPPED`/`FAILED` 的出边数 = 0）。

## 三、几个刻意的设计决策

1. **拒绝转换时不改状态** —— `to()` 返回 `{ok:false, error}`，状态原样保留（可测：被拒后 `state` 不变）。
2. **观察者抛错不污染状态机** —— `onTransition` 抛出的异常收进 `observerErrors`，转换本身照常成功。
3. **`kill()` 幂等** —— 已 STOPPING/STOPPED/FAILED 的进程再 kill 返回 `{ok:false}`，**不重复调底层 kill**（测试断言底层只被调用一次）。
4. **区分「被用户停」与「自己崩」** —— 用户 `kill()` 后 `recordExit(非0)` 仍记 **STOPPED**；未经过 STOPPING 而 `recordExit(非0)` 记 **FAILED**。
5. **`RunResult.ok` 的语义写死并写明**：没有 `error` 且状态落在 RUNNING / STOPPING / STOPPED（即「进程确实起来过」）。
6. **`duration` 只在起止时间都有时才算**（只给一头 → `null`，不猜）。

## 四、验证（RULE-01）

```bash
cd desktop && node test-run-state.js
```

**结果：48 通过 / 0 失败 / 共 48 项（exit 0）**

| 组 | 项数 | 代表断言 |
|---|---|---|
| P1-14 | 5 | 7 态齐备、枚举冻结、未知态被拒 |
| P1-15 允许 | 2 | 9 条允许转换全走通 |
| P1-15 禁止 | 11 | `STOPPED→RUNNING` / `FAILED→RUNNING` / 跳级 被拒；被拒后状态不变；终态不能前进；`reset()` 后可重走 |
| P1-15 观察者 | 3 | 抛错不影响转换，错误被记录 |
| P1-16 | 13 | 字段、stop→SIGTERM、重复 kill、`recordExit` 的 STOPPED/FAILED 分支、kill 抛错 |
| P1-17 | 5 | 两种流、缺省时间戳、null chunk、非法流名 |
| P1-18 | 8 | 默认值、ok 推导、duration、类型归一、完整结果 |
| 自检 | 2 | 终态无出边、7 个状态都在表里 |

**回归**（CI 里的纯 Node 段全量）：

| 脚本 | 结果 |
|---|---|
| `test-runner-detect` | 18 / 0 |
| `test-project-detect` | 12 / 0 |
| `test-relay` | 25 / 0 |
| `test-url-detect` | 29 / 0 |
| **`test-run-state`（新）** | **48 / 0** |
| `test-run-e2e` | 17 / 0 |
| `check-empty-catch --ci` | **95 = 基线**（未新增）|
| CI YAML（pyyaml）| **OK**，10 个 step |

## 五、未做（明确留给 P1-19）

| 项 | 说明 |
|---|---|
| 把状态机接进 `createServiceRunner` | P1-19：顺序必须是 `spawn → collect output → detect URL → update state → open browser` |
| 用 `ProcessHandle` 替换 runner 内部的裸 `child` | P1-19 |
| 用 `createRunResult` 汇报运行结果 | P1-19 |
| **P1-25**（无监听超时）、**P1-27～P1-29**（连续 10 次 / 红线） | 依赖 P1-19 接线后才能测 |

> 本轮建的是**接口**，`runners.js` 一个字节没动 —— 符合 RULE-04「先建新接口，再迁移调用点」。
