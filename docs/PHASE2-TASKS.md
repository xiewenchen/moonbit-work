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
| MBW-P1-14 | 定义 Run 状态枚举 | BLOCKED | P1-06 | IDLE/BUILDING/STARTING/RUNNING/STOPPING/STOPPED/FAILED | 阻塞于 **R12**（本机 native 构建失败，无法 E2E 验证） |
| MBW-P1-15 | 定义状态转换 | BLOCKED | P1-14 | 禁止 STOPPED→RUNNING、FAILED→RUNNING | 同上 |
| MBW-P1-16 | 建 ProcessHandle | BLOCKED | P1-14 | pid/command/cwd/startTime/status + stop()/kill() | 同上 |
| MBW-P1-17 | 统一 stdout/stderr 事件 | BLOCKED | P1-16 | stream/chunk/timestamp | 同上 |
| MBW-P1-18 | 建 RunResult | BLOCKED | P1-16 | ok/status/exitCode/url/stdout/stderr/duration/error | 同上 |
| MBW-P1-19 | 修复 Run → URL → Browser | BLOCKED | P1-07, P1-18 | 此时才动 Runner 主流程 | 同上（改完无法验证） |
| MBW-P1-20 | 浏览器打开单独测试 | BLOCKED | P1-19 | 直接给 8123 | 同上 |
| MBW-P1-21 | 浏览器失败测试 | BLOCKED | P1-19 | browser 失败不得把服务标成 FAILED | 同上 |
| MBW-P1-22 | Stop 测试 | BLOCKED | P1-19 | 无僵尸进程 | 同上 |
| MBW-P1-23 | Run 后重复 Stop | BLOCKED | P1-22 | 第二次安全无副作用 | 同上 |
| MBW-P1-24 | 启动失败 | BLOCKED | P1-19 | STARTING → FAILED | 同上 |
| MBW-P1-25 | 无监听服务超时 | BLOCKED | P1-19 | STARTING → timeout → FAILED | 同上 |
| MBW-P1-26 | 进程提前退出 | BLOCKED | P1-19 | 启动即 exit 1 → FAILED | 同上 |
| MBW-P1-27 | 连续 10 次 Run | BLOCKED | P1-19 | 10/10 | 同上 |
| MBW-P1-28 | 连续 10 次 Run/Stop | BLOCKED | P1-22 | 10/10，0 僵尸 | 同上 |
| MBW-P1-29 | Run/Stop × 10 红线 | BLOCKED | P1-28 | 0 卡死 / 0 browser 错误 / 0 zombie / 0 永久 STARTING | 同上 |

---

## P2 及以后（占位，尚未排期）

| Phase | 主题 | Status |
|---|---|---|
| P2 | ProjectContext（单一工程上下文） | TODO |
| P3 | Command Registry | TODO |
| P4 | Problem Model | TODO |
| P5 | Agent Context | TODO |
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
| MBW-X1 | P1 | **Run 链路可测化 + E2E 搬进 CI** | **PASS** | `node desktop/test-run-e2e.js` → **17/0**；CI step「Run E2E (pure Node)」；`verify-run-dispatch` **5/5** 回归 | 见本轮提交 | 记录：`changes/phase2-p1-run-e2e-ci.md` |

**MBW-X1 覆盖映射（诚实）**：P1-19 链路核心 ✅ / P1-20 ✅ / P1-21 ✅ / P1-22 ✅ / P1-23 ✅ / P1-24 ✅ / P1-26 ✅；
**P1-25（无监听超时）与 P1-27～P1-29（连续 10 次）仍未覆盖** —— 需要状态机（P1-14～P1-18）。
本次只做了「可测化 + 等价抽取 + 接线」，**未引入状态机**，故 P1-14～P1-18 仍为 BLOCKED。

---

## 备注

1. **tag 不推送到远端**：`git tag` 已在本地建好；推送需要网络（当前 FlClash 出口为香港机房 IP，链路慢且抖动，见记忆 `clash-chatgpt-blocked-diagnosis`）。待人工确认后再 `git push origin hackathon-final-2026-09-24`。
2. **本机 `moon test` 异常**：基线快照里 native/wasm-gc 测试以 CI 为准（红灯 R3）。
3. 本表只由**实测**推进；任何未跑通验证的项不得置 PASS。
