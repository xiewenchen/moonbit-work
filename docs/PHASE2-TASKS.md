# Phase 2 任务状态表

> 规则：**未验证 ≠ 完成**（RULE-01）。状态只能由**实测结果**推动，不允许提前写 PASS。
> 状态取值：`TODO` / `DOING` / `BLOCKED` / `PASS` / `FAIL` / `DEPRECATED`
> 配套：纲领与门禁见 [`PHASE2.md`](PHASE2.md) ｜ 变更记录见 [`changes/`](changes/)

**最后更新**：2026-09-24（第一批执行中）

---

## 第一批（本轮只做这些）

| ID | Phase | Task | Status | Blocked By | Verification | Commit | Notes |
|---|---|---|---|---|---|---|---|
| MBW-P0-01 | P0 | 冻结黑客松提交版本（建 tag） | **PASS** | — | `git tag -l -n5`；`git show hackathon-final-2026-09-24` | 796fd05 | 本地 tag；**未 push**（代理链路慢，见 Notes 末） |
| MBW-P0-02 | P0 | 建立 Phase 2 分支 | **PASS** | P0-01 | `git branch -vv` → `phase2-engineering-workspace` | 796fd05 | 从 master 切出 |
| MBW-P0-03 | P0 | 建立 `docs/PHASE2.md` | **PASS** | — | 文件存在且含版本/阶段/规则/门禁/红灯/技术债 | — | — |
| MBW-P0-04 | P0 | 建立任务状态表 | **PASS** | — | 本文件 | — | 字段与状态枚举照清单 |
| MBW-P0-05 | P0 | 建立「已知红灯」区 | **PASS** | — | `PHASE2.md` §5（R1–R10） | — | 全部取自实测/仓库文档，不得写绿 |
| MBW-P0-06 | P0 | 建立初始验证快照 | **PASS** | — | `docs/changes/phase2-p0-baseline.md`（command/时间戳/exit/stdout/stderr/result 齐备） | — | `verify:desktop` exit=1（run-url 3/5）、`verify:demo` exit=1（6/7）；顺带发现红灯 R11 |
| MBW-P0-07 | P0 | 建立变更日志目录 | **PASS** | — | `ls docs/changes/` → `phase2-p0-baseline.md` | — | — |
| MBW-P1-01 | P1 | 阅读 Run 入口（只读） | **PASS** | P0 | 调用链已产出：`runProject()` renderer.js:678 为第一入口 | — | 未改代码 |
| MBW-P1-02 | P1 | 阅读 Runner（只读） | **PASS** | P1-01 | runners.js 职责表（识别/命令/spawn/stdout/stderr/URL/exit/browser） | — | 顺带记录：`openExternal` 失败被空 catch 吞（属 P1-21） |
| MBW-P1-03 | P1 | 阅读主进程 IPC（只读） | **PASS** | P1-01 | IPC 图已产出；`registerRunnerIpc` 仅 main.js:122 注册一次，无重复调用 | — | — |
| MBW-P1-04 | P1 | 阅读现有 Run 测试（只读） | **PASS** | — | 6 个脚本逐一记录；本轮重跑 `verify-url-regex` **8/0** | — | — |
| MBW-P1-05 | P1 | 建立失败复现记录（只复现不修） | **PASS** | P1-02 | 7 组复现（IDE ×2 / 命令行 ×4 / 单测 ×1）+ 6 项对照实验 | — | 详见 `changes/phase2-p1-run-diagnosis.md` |
| MBW-P1-06 | P1 | 判断失败属于哪一层 | **PASS** | P1-05 | **第一次出现错误的位置 = 构建阶段（B）**：`moon build --target native` 在 `moonc link-core` 失败，EXIT=127 | — | A–J 逐层排查见报告；G（URL detector）已排除 |

### Gate P0

| 项 | 状态 |
|---|---|
| TAG | PASS |
| BRANCH | PASS |
| BASELINE | PASS |
| DOC | PASS |

> Gate P0 未全 PASS，不得进入 P1 的修改类工作（P1-01～P1-04 是只读，可与 P0-06 并行）。

---

## 第二批（P1 定位完成后才决定是否进入）

| ID | Task | Status | Blocked By | Notes |
|---|---|---|---|---|
| MBW-P1-07 | 抽离 URL Detector `detectUrl(input) → URL \| null` | **PASS** | P1-06 | 新建 `desktop/url-detect.js`（纯逻辑）；**未接线**，runners.js 不动（RULE-04 渐进迁移） |
| MBW-P1-08 | 单 chunk 测试 | **PASS** | P1-07 | 2 项 |
| MBW-P1-09 | 跨 chunk 测试 | **PASS** | P1-07 | 3 段拼出同一个 URL + 拼接对照 |
| MBW-P1-10 | ANSI 测试 | **PASS** | P1-07 | 含 `\x1b[39m` 紧贴 URL 的形态 |
| MBW-P1-11 | 多 URL 测试 | **PASS** | P1-07 | 引入可注入的 `preferPorts` 规则，不再盲取第一个 |
| MBW-P1-12 | 非法 URL 测试 | **PASS** | P1-07 | 8 项（含 `http://127.0.0.1:` → 去尾冒号） |
| MBW-P1-13 | 重复 URL 测试 | **PASS** | P1-07 | 第二次不再触发；reset 可复用 |

> **P1-07～P1-13 实测**：`cd desktop && node test-url-detect.js` → **26 通过 / 0 失败**（含「正则与 runners.js:262 逐字符一致」的防漂移断言）。
> 记录：`docs/changes/phase2-p1-url-detector.md`。**未接线** —— 生产代码零改动，迁移留 P1-19。
| MBW-P1-14 | 定义 Run 状态枚举 | **PASS** | P1-06 | `desktop/run-state.js` 的 `RUN_STATE`（7 态、冻结、未知态被拒） | 纯逻辑，不受 R12 影响 |
| MBW-P1-15 | 定义状态转换 | **PASS** | P1-14 | 转换表 + `createRunStateMachine`：9 条允许全通；STOPPED/FAILED→RUNNING 与跳级被拒；`reset()` = 重新进入 Run 流程 | 拒绝时状态不变 |
| MBW-P1-16 | 建 ProcessHandle | **PASS** | P1-14 | pid/command/cwd/startTime/status + `stop()`(SIGTERM)/`kill()`；kill 幂等；区分「被停」与「崩掉」 | — |
| MBW-P1-17 | 统一 stdout/stderr 事件 | **PASS** | P1-16 | `createStreamEvent(stream, chunk, at)` → `{stream, chunk, timestamp}`；非法流名被拒 | — |
| MBW-P1-18 | 建 RunResult | **PASS** | P1-16 | `createRunResult(...)` → ok/status/exitCode/url/stdout/stderr/duration/error（类型归一） | ok 语义已写明 |
| MBW-P1-19 | 修复 Run → URL → Browser | **PASS** | P1-07, P1-18 | 状态机已接进 `createServiceRunner`；顺序有断言（**抓 URL 时状态已是 RUNNING**）；`runSeq` 防上一轮迟到事件串台 | 顺带修 2 个真缺陷 |
| MBW-P1-20 | 浏览器打开单独测试 | **PASS** | P1-19 | 可注入 `openUrl`，断言“恰好调用一次 + 状态为 RUNNING” | — |
| MBW-P1-21 | 浏览器失败测试 | **PASS** | P1-19 | 浏览器抛错 → `onBrowserOpen{ok:false}`，**服务仍在运行** | 界面提示留给 P1-21 UI |
| MBW-P1-22 | Stop 测试 | **PASS** | P1-19 | stop → STOPPING → STOPPED，且**端口不再可连** | — |
| MBW-P1-23 | Run 后重复 Stop | **PASS** | P1-22 | 第二次 stop 返回 `ok:false` 且不抛 | — |
| MBW-P1-24 | 启动失败 | **PASS** | P1-19 | 可执行文件不存在 → `onEnd` 报 `ok:false` + 原因 | — |
| MBW-P1-25 | 无监听服务超时 | **PASS** | P1-19 | `startTimeout` + **inactivity 语义**（从最后一次输出算起）；超时→FAILED 且主动清掉进程 | 默认 60s，可配；持续输出不会误杀 |
| MBW-P1-26 | 进程提前退出 | **PASS** | P1-19 | 启动即 exit 1 → FAILED，并上报退出码 | — |
| MBW-P1-27 | 连续 10 次 Run | **PASS** | P1-19 | 10/10 进入 RUNNING 并拿到 URL | — |
| MBW-P1-28 | 连续 10 次 Run/Stop | **PASS** | P1-22 | 10/10，每个 pid 用 `process.kill(pid,0)` 复核已退出（0 僵尸） | — |
| MBW-P1-29 | Run/Stop × 10 红线 | **PASS** | P1-28 | 0 zombie / 0 永久 STARTING / 0 browser 错误 / 没卡死（实测 10 轮 ≈ 6s） | renderer 卡死用总耗时代理 |

> **P1-25 / P1-27～P1-29 实测**：`cd desktop && node test-run-e2e.js` → **47 通过 / 0 失败**（从 31 扩到 47）。
> 记录：`docs/changes/phase2-p1-timeout-and-loops.md`。
>
> ⚠️ **Gate M1-A = 5/7**：run-url 与 demo rehearsal 两项仍卡在 **R12**（它们的验证要真跑 MoonBit native 项目）。
> 已给出解法建议（把 `verify-run-url.js` 的靶子换成零依赖 fixture），待单独任务执行。

> **P1-19 接线实测**：`cd desktop && node test-run-e2e.js` → **31 通过 / 0 失败**（从 17 扩到 31）。
> 测试拓到 2 个真缺陷并已修：① `stop()` 进 STOPPING 未上报状态；② `close` 丢掉 `signal`。
> 记录：`docs/changes/phase2-p1-run-state-wiring.md`。

> **P1-14～P1-18 实测**：`cd desktop && node test-run-state.js` → **48 通过 / 0 失败**。
> 记录：`docs/changes/phase2-p1-run-state.md`。原语已建、**未接线**（runners.js 零改动）。

---

## P2 及以后（占位，尚未排期）

| Phase | 主题 | Status |
|---|---|---|
| P2 | ProjectContext（单一工程上下文） | **进行中**：P2-01～P2-05 PASS；P2-06～P2-18 待做 |
| P3 | Command Registry | **PASS（P3-12 未做）**：P3-01～P3-11、P3-13～P3-15 全部 PASS；P3-12（Terminal 调命令）无现成基础，如实留待 |
| P4 | Problem Model | **PASS**：P4-01～P4-12 全部完成（模型 + Store + 六类适配器 + 面板接线 + 点击跳转）|
| P5 | Agent Context | **进行中**：P5-01～P5-09 PASS（组装器 + 预算 + 优先级）；真实取数与接到 Agent 待做 |
| P5.5 | Agent 安全门（路径/命令沙箱、超时、输出限制、IPC 审查） | TODO |
| P6 | Agent Read-only Tools | TODO |
| P7 | Agent Execute Tools | TODO |
| P8 | Agent Modify（Patch） | TODO |
| P9 | Agent Verification Loop | TODO |
| P10 | Session | TODO |
| P11 | 项目级 Agent Memory | TODO |
| P12 | AI Provider Center | TODO |
| P13 | Workbench | TODO |
| P14 | MoonBit Backend Integration | TODO |
| P15 | 数据库工作台 | TODO |
| P16 | Quality Center | TODO |
| P17 | 安全技术债收口（U1–U10） | TODO |
| P18 | 技术债（-79 / --deny-warn / 空 catch） | TODO |
| P19 | 测试体系 | TODO |
| P20 | 产品化 | TODO |
| P21 | 最终产品 Demo | TODO |
| P22 | 最终回归 | TODO |
| P23 | 版本发布（0.2.0-alpha / beta / 0.2.0） | TODO |

---

## 清单外补充任务（用户指定）

| ID | Phase | Task | Status | Verification | Commit | Notes |
|---|---|---|---|---|---|---|
| MBW-X1 | P1 | **Run 链路可测化 + E2E 搬进 CI** | **PASS** | `node desktop/test-run-e2e.js`；CI step「Run E2E (pure Node)」；`verify-run-dispatch` 5/5 | 见提交 | 记录：`changes/phase2-p1-run-e2e-ci.md` |
| MBW-X2 | P1 | **run-url 换零依赖靶子 + 修「shell 启动留孤儿」真缺陷** | **PASS** | `verify-run-url` **5/5**；`verify:demo` **7/0**；`test-run-e2e` **51/0**；端口监听数独立核对 = 0 | 200d78c | 记录：`changes/phase2-p1-run-url-target-and-orphan-fix.md` |

> **Gate M1-A 已 7/7 通过**；**P1-01～P1-29 全部 PASS** → 按 Gate A 可进入 **P2（ProjectContext）**。

---

## P2 明细（ProjectContext）

| ID | Task | Status | Verification | Notes |
|---|---|---|---|---|
| MBW-P2-01 | 统计重复状态（只读） | **PASS** | 盘点表见 `changes/phase2-p2-context.md` §一 | 项目根散在 **4 处**且不同步；类型有 **2 套算法** |
| MBW-P2-02 | 定义 ProjectContext | **PASS** | `desktop/project-context.js`：9 个字段 + label/features/createdAt，**整对象冻结** | — |
| MBW-P2-03 | 定义 ProjectType | **PASS** | 8 种类型（含 java/static）+ 归一化（大小写/怪输入） | — |
| MBW-P2-04 | project-detect 只负责识别 | **PASS**（审计） | 逐条核对：只返回 ProjectInfo、无启动/编译/改 UI | 唯一可议：`cwd \|\| DEFAULT_CWD` 回退属根解析，待迁移 |
| MBW-P2-05 | 建 ProjectContext Factory | **PASS** | `createProjectContext(info, overrides)` + TYPE_SPEC 推导命令 | 含与真实 `detectProject()` 的集成断言 |
| MBW-P2-06 / 07 | 迁移 Renderer + 回归 | **PASS** | `verify-welcome` 全绿；`verify:demo` **7/0**（含体检 23 项）；`verify-run-url` 5/5 | 只迁「无项目态」一个判据（RULE-04）；**preload 不能过桥**（sandbox:true 不允许 require 本地文件），改走 script+window 全局 |
| MBW-P2-08 / 09 | 迁移 Runner + 回归 | **PASS** | `test-runner-detect` **25/0**（含 7 项 `rootOfInput`）；`verify-run-url` 5/0（旧路径）；`verify:demo` **7/0**（新路径） | 新增 `rootOfInput()` 容忍字符串/ProjectContext/{ctx}；归一化只翻译输入，*不*默默回退 cwd |
| MBW-P2-10 ～ P2-14 | 迁移 LSP / Terminal / API / Problems / Agent | **PASS** | `test-project-context` **43/0**；`verify-run-url` 5/0；`verify:demo` **7/0** | 13 处重复取根 → `rootOfInput` 统一；**修 2 个真问题**（api-debug 忽略传入路径、backend:build 无 cwd 参数）；renderer 12 处调用点改传上下文（带一致性检查） |
| MBW-P2-15 | 逐个废弃旧变量 | **PASS（1/3）** | `node --check renderer.js`；全量回归 | 删掉 `rootDir`（只剩写没有读）；`projectInfoCache` / `lspRoot` 待后续（lspRoot 需先提升作用域）|
| MBW-P2-16/17/18 | 无项目态 / 多项目切换 / 关闭项目 | **PASS** | **`verify-multiproject` 17/0**；`verify-run-url` 5/0；`verify:demo` 7/0 | 新增对外入口 `window.moonbitIDE`（P3 雏形）；**挖出 2 个真 bug**（见记录）|

> **P2-15～P2-18 实测**：`npm run verify:multiproject` → **17 通过 / 0 失败**（A=Node / B=MoonBit / A→B→A / 关闭）。
> 记录：`docs/changes/phase2-p2-multiproject.md`。**P2（ProjectContext）主体完成**。

> **P2-01～P2-05 实测**：`cd desktop && node test-project-context.js` → **36 通过 / 0 失败**。
> 记录：`docs/changes/phase2-p2-context.md`。**未改动任何调用点**（renderer/runners/main/lsp-manager… 均零改动）。

**MBW-X1 覆盖映射（诚实）**：P1-19 链路核心 ✅ / P1-20 ✅ / P1-21 ✅ / P1-22 ✅ / P1-23 ✅ / P1-24 ✅ / P1-26 ✅；
**P1-25（无监听超时）与 P1-27～P1-29（连续 10 次）仍未覆盖** —— 需要状态机（P1-14～P1-18）。
本次只做了「可测化 + 等价抽取 + 接线」，**未引入状态机**，故 P1-14～P1-18 仍为 BLOCKED。

---

## 备注

1. **tag 不推送到远端**：`git tag` 已在本地建好；推送需要网络（当前 FlClash 出口为香港机房 IP，链路慢且抖动，见记忆 `clash-chatgpt-blocked-diagnosis`）。待人工确认后再 `git push origin hackathon-final-2026-09-24`。
2. **本机 `moon test` 异常**：基线快照里 native/wasm-gc 测试以 CI 为准（红灯 R3）。
3. 本表只由**实测**推进；任何未跑通验证的项不得置 PASS。
