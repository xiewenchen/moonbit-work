# Phase 2 任务状态表

> 规则：**未验证 ≠ 完成**（RULE-01）。状态只能由**实测结果**推动，不允许提前写 PASS。
> 状态取值：`TODO` / `DOING` / `BLOCKED` / `PASS` / `FAIL` / `DEPRECATED`
> 配套：纲领与门禁见 [`PHASE2.md`](PHASE2.md) ｜ 变更记录见 [`changes/`](changes/)

**最后更新**：2026-09-24（第一批执行中）

---

## 第一批（本轮只做这些）

| ID | Phase | Task | Status | Blocked By | Verification | Commit | Notes |
|---|---|---|---|---|---|---|---|
| MBW-P0-01 | P0 | 冻结黑客松提交版本（建 tag） | **PASS** | — | `git tag -l -n5`；`git show hackathon-final-2026-09-24` | 796fd05 | tag 已建并**已推送**到远端 |
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
| P5.5 | Agent 安全门 | **PASS**（门已建好，尚未装到 Agent 执行路径上）：Path/Command Sandbox、Timeout、Output Limit、IPC 审查全部完成 |
| P6 | Agent Read-only Tools | **PASS（含接线）**：七个工具 + 统一结果 + 审计字段 + **接到真实数据**（19/0 验证）；喂给 Agent 属 P7 |
| P7 | Agent Execute Tools | **PASS（含接线）**：六个执行工具（一律经命令表）+ 审计 + 预算 + 失败不重试；**执行表拒绝 write**（仍不能改文件）；喂给 Agent 待做 |
| P8 | Agent Modify（Patch） | **PASS**：核心层（默认拒绝/精确匹配/备份先行/失败回滚）+ **UI 确认对话框**（28/0 真点击验证）；接到 Agent 属 P9 |
| P9 | Agent Verification Loop | **PASS（含接线）**：闭环 + 失败即停 + 轮次上限 + 防死循环 + 报告 + **结果进输出/问题面板**（17/0 真实场景验证）；**Ask/Understand 与自动修（需 LLM）未做** |
| P10 | Session | **PASS**：不可变会话模型（id/绑定项目/四类记录）+ 持久化到**用户目录**（按项目分文件，不进项目）+ 项目切换自动切会话 + 关项目结束上下文 + **面板**（按项目展示会话与四类记录，不提供改历史）；**修掉真缺陷**：渲染侧原来用全局 localStorage 键 → 换项目会串；`test-session` **68/0**、`verify-session` **25/0**、`verify-session-memory-ui` **17/0** |
| P11 | 项目级记忆 | **PASS**：`.moonbit-work/`（project.md / agent-rules.md / context.json / history）—— 只做"项目知识"；规则**未经确认不可修改**（判定提到写盘层）；经验只收 `verified`、相关度检索、压缩（**原条目归档**）+ **面板**（规则与经验只读展示，**不含编辑入口**）；`test-project-memory` **101/0**、`verify-project-memory` **38/0** |
| P12 | AI Provider Center | **PASS**：核心层（44/0）+ 存储/面板/真实探测（23/0）+ **激活并写入 opencode 配置（38/0，含「原有 provider 一个不丢」与「配置原样还原」）**；端到端「真跑一次模型」未验（需 Key/额度） |
| P19 | 测试体系 | **PASS（关键项全部达成）**：`verify-harness` + 元测试 36 项 + 扫描器（认可相等语义的 chk）+ 异常退出码双向证明 + 4 个长期红灯已修；**34 个脚本迁到公共 harness 且逐个真跑，基线归 0**；**修好 41 个原本坏掉的 `.catch` 兜底**（引用不存在的 log/dump，已用注入 throw 验证）；查清 `verify-dash.js`=测试过时→**按新 UI 重写（13/0）**、`verify-dash-v2.js`=三个测试自身问题（点错按钮/截图缺保护/localStorage 污染）→ 修好后连跑两次 27/0；⚠️ 三次批量尝试失败均回滚（改 JS 源码只用 `edit_file`） |
` 转义，改 JS 源码只用 `edit_file`） |
` 转义 —— 改 JS 源码只用 `edit_file`，见 `docs/changes/phase2.1-p19-migration-2.md`） |
| P5A | Agent Context 真接线 | **PASS（第一批）**：AgentRequest/AgentResponse 契约（含四态）+ **ProjectContext/Problems 真实接入**（`verify-agent-request` 19/0，用真实项目与真实问题验证）+ Context Snapshot（含取数四态 absent/empty/ok/error）；**activeFile/selection/lastRun/lastTest 待接** |
| P9A | Ask / Understand | **PASS（第二批）**：`TaskUnderstanding`（6 栏全部**可核对来源**，不做思维链）+ 规则化 `proposedActions`（每条带 rule）+ `applyLlmPlan` 只许覆盖计划、事实不许改；理解卡（开始执行/取消）+ Auto-start 开关（卡上可见可写，且不解除 P8）；`test-task-understanding` 53/0、`verify-agent-request` **41/0**（含真切界面与"越界路径被拒"） |
| P9B | AI Adapter + MockLLM | **PASS**：`agent-adapter.js`（generate/stream/toolCall + 最小工具循环）+ `mock-llm.js`（与 adapter **同接口**，可真正替换，`isMock` 可断言没连真网）；**解耦做成文本口径**（源码无厂商名、不 require provider）；`test-agent-adapter` **69/0**（含无限规划被预算截断、未经确认不写盘、错误六路径、**apiKey 脱敏**）；**未接入生产路径**（留给 P9C） |
| P9C | Agent E2E | **PASS（链路完整）**：专用靶项目（独立零依赖）+ **三态对照**（干净 check=0 / 注入≠0 / 修好=0）；14 步全走（Ask→Understand→Read→Patch→Confirm→Apply→闭环→报告）；`verify-agent-e2e` **39/0**；**修 3 个真缺陷**（runTest 缺 root、startRun 认知错、主进程用了渲染侧变量）；**test 因 R12 失败、run/health 因失败即停未跑 —— 结论如实为 VERIFY_FAILED**（不伪装通关） |
| P13 | Workbench | **PASS**：数据层（最近项目/待办/便签，**按项目隔离**）+ **P13-08 不反向污染**（磁盘上只有自己的键）+ **面板**（最近项目/待办/便签）+ **P13-04～07 全套**（文件→项目**显式关联**、Office 预览（**复用 relay 的解析**）、送进 Agent（**每样带出处**）、结论**追加**到便签）+ **接线与面板**；`test-workbench` **56/0**、`test-office-link` **53/0**、`verify-workbench` **23/0**、`verify-office` **25/0**、`verify-session-memory-ui` **17/0** |
| P14 | Backend Integration | **PASS**：`BackendProjectContext`（backendLike/port+来源/health/database/redis）+ 新增 `backend:health`（含 PG/Redis 依赖）+ 一键 Build/Run/Stop 沿用命令表；**Agent 新增只读工具 `backendStatus`**（第 8 个）；端口与健康**只采事实不猜**；`test-backend-context` **41/0**、`verify-agent-tools` **31/0**；**UI 侧的 backendHealth 调用点待接** |
| P15 | 数据库工作台 | **PASS**：安全闸（SQL 只放 SELECT / Redis 只放只读）+ Agent 只读工具 `queryDatabase` + 构造层与执行层（表/列/分页/搜索/Redis Keys/Value；标识符与字面量都转义，生成结果再过一遍闸；执行走 psql/redis-cli，**没装客户端如实报 NO_CLIENT 而不是空结果**）+ **面板**（动态 DOM：表列表/列/分页/搜索/Redis；连不上如实显示）；`test-sql-guard` **67/0**、`test-db-explorer` **58/0**、`verify-agent-tools` **41/0**、`verify-db-explorer` **14/0**、`verify-db-ui` **12/0** |
| P16 | Quality Center | **PASS**：`QualityResult` 5 态（**SKIP 与 NOT_RUN 分开**）+ 7 个 Adapter（从已有产物归一、**不重跑**）+ 统一 Store + `overall`/`canProceed` + **UI 面板**（动态 DOM，含"能不能继续"判断）+ **点失败项看日志 / 跳到产物**（日志读取限定在验证产物，拒绕越）；Agent 侧只读工具 `qualityStatus`（第 9 个）与 UI **共用唯一聚合实现**；`test-quality-result` **69/0**、`verify-agent-tools` **36/0**、`verify-quality-ui` **20/0** |
| P17 | 安全第二轮 | **PASS**：`tools/audit-desktop-security.js`（IPC 清单/高危入口/Electron 开关与 CSP/浮动依赖，带基线进 CI）；**已修**：`fs:write` 收窄为只能写工作区、6 个依赖钉成实际版本、**`spawn-util` 的参数拼接面**（控制字符直拒 + `%`/`!` 纳入引号条件，同时保留必需的 `shell:true`）；审计 **高危 0 / 中危 0**；`verify-write-guard` **13/0**、`test-spawn-util` **27/0** |
| P18 | 技术债 | **部分 PASS（扫描类）**：**修正数字** —— `warnings = "-79"` 实际只在 **3 个包**（http/pg/redis，注释写明是为**跨版本兼容**：新工具链把 `implicit_impl_as_method` 当 error）；实测去掉后本机 48 warnings/**0 errors**（因本机 moonc 较旧根本不报）→ **删它会坏 CI、改代码又在本机验证不了**，故未动；`--deny-warn` **暂不开**（33 warnings）；空 catch 分类完成（368 catch：A 完全空 **93** / B 只注释 23 / C 有代码 252）；**逐包迁移与 A 类清理未做** |
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

1. **已推送（2026-09-24）**：`phase2-engineering-workspace`（26 个 commit）与 tag `hackathon-final-2026-09-24` 都已推到 `origin`，远端与本地 `ahead=0 behind=0`。
   > 当时卡了一会儿，原因是 **FlClash 的系统代理是关的**（`ProxyEnable=0`、7890 未监听），而 git 硬配了 `http.proxy=127.0.0.1:7890`；
   > 直连 `github.com` 会被 reset（`api.github.com` 直连却 200，说明是域名级别的干扰）。开代理后一次推送成功。
   > 另备了一份离线完整历史：桌面 `moonbit-work-phase2.bundle`（10 MB，`git bundle verify` = complete history）。
2. **本机 `moon test` 异常**：基线快照里 native/wasm-gc 测试以 CI 为准（红灯 R3）。
3. 本表只由**实测**推进；任何未跑通验证的项不得置 PASS。
