# MoonBit Work — Phase 2 纲领与门禁

> 本文件是 **Phase 2（IDE Core + Engineering Agent）** 的总纲：版本基线、任务规则、门禁规则、已知红灯、已知技术债。
> 逐任务状态见 [`PHASE2-TASKS.md`](PHASE2-TASKS.md)；各阶段变更记录见 [`changes/`](changes/)。
> 建立时间：2026-09-24 ｜ 建立者：Phase 2 第一批任务（MBW-P0-03）

---

## 一、当前版本

| 项 | 值 |
|---|---|
| 模块 | `xiewenchen/moonbit-platform@0.1.0` |
| 仓库 | `https://github.com/xiewenchen/moonbit-work` |
| 黑客松基线 commit | `796fd0500604156f9d4fbf2afdf570e1d2a7edcc`（2026-09-24 08:45:35 +0800） |
| 冻结 tag | `hackathon-final-2026-09-24` |
| Phase 2 分支 | `phase2-engineering-workspace` |
| 主干分支 | `master`（= `origin/master` @ 796fd05） |

基线规模（2026-09-24 实测）：**93 个 `.mbt` / 11315 行 / 29 个 MoonBit 包**；桌面端功能体检 **23/23**。
（`docs/PROJECT-SUMMARY.md` 等文档里的 28 包 / 11209 行 / 31 commits / 11 份文档是**较早时点**的记录，勿再引用。）

## 二、当前阶段

**Phase 2 起步（P0）**。Phase 2 不追求「功能越来越多」，而追求：

```
现有能力统一 → 易用 → 易测 → Agent 真能参与 → 工程闭环
```

三个最终里程碑：

| 里程碑 | 内容 | 完成判据 |
|---|---|---|
| **M1 IDE Core** | Open → Edit → Build → Run → Browser → API → Data | Gate M1-A 全绿 |
| **M2 Engineering Agent** | Ask → Understand → Read → Diagnose → Patch → Check → Test → Run → Health → Report | Gate M2 全绿 |
| **M3 Engineering Workspace** | IDE + Agent + MoonBit Backend + Quality + Workbench | Gate M3 全绿 |

## 三、任务规则（RULE）

| ID | 规则 |
|---|---|
| **RULE-01** | **未验证 = 未完成**。写完代码 ≠ 完成；写完 + 测试 + 回归 + 结果记录 = 完成 |
| **RULE-02** | **一个任务只解决一个问题**。发现其他问题 → 记录 → 新建任务 → 暂停当前任务 |
| **RULE-03** | **修改前必须知道修改对象**：先输出「现状 / 入口 / 调用链 / 问题位置 / 允许修改 / 禁止修改」 |
| **RULE-04** | **任何架构重构都必须渐进迁移**：旧逻辑 → 建新接口 → 迁移一个调用点 → 验证 → 再迁移；禁止一次性删除 |
| **RULE-05** | **Agent 权限逐级开放**：READ → EXECUTE → MODIFY，未过前一级门禁不得进入下一级 |

## 四、门禁规则（Gate）

| 门禁 | 条件 | 解锁 |
|---|---|---|
| **Gate P0** | TAG / BRANCH / BASELINE / DOC 全 PASS | P1 |
| **Gate A** | P1 PASS | ProjectContext（P2） |
| **Gate M1-A** | run-url 5/5 · run-dispatch 5/5 · 错误项目 PASS · timeout PASS · Run×10 PASS · Run/Stop×10 PASS · demo rehearsal 不再因 run-url 失败 | P2 |
| **Gate P2** | 单一 ProjectContext · 旧状态逐步减少 · 多项目 PASS · 无项目 PASS · LSP/Terminal/Agent PASS | P3 |
| **Gate P3** | 同一动作（UI / Menu / Shortcut / Agent）走同一 Command；**此时 Agent 只建接口，不允许自动执行** | P4 |
| **Gate P4** | 五类问题统一可见：LSP / Compile / Runtime / Test / Agent | P5 |
| **Gate B** | P4 PASS + P5 PASS + **P5.5（安全门）PASS** | Agent Execute |
| **Gate C** | P6 PASS + P7 PASS + Security PASS | Agent Modify |
| **Gate D** | P8 PASS | Agent 自动修复 |
| **Gate E** | P9 PASS | 「Engineering Agent 成立」 |

**P5.5 安全门（Path Sandbox / Command Sandbox / Timeout / Output Limit / IPC Review）未过，禁止进入 Agent Execute / Modify。**

### 当前进度（2026-09-24）

| 门禁 | 状态 |
|---|---|
| Gate P0（TAG / BRANCH / BASELINE / DOC） | ✅ 通过 |
| **Gate M1-A**（run-url 5/5、run-dispatch 5/5、错误项目、timeout、Run×10、Run/Stop×10、demo rehearsal） | ✅ **7/7 通过** |
| **Gate A**（P1 PASS → 可开始 ProjectContext） | ✅ **已解锁**（P1-01～P1-29 全部 PASS）|

> 下一步：**P2 ProjectContext**。

## 五、已知红灯（不得写成绿色）

以下为 2026-09-24 基线的**真实状态**，来自桌面端验证结果文件与仓库文档：

| # | 红灯项 | 现状 | 证据 |
|---|---|---|---|
| R1 | **run-url** | **3 通过 / 2 失败**（未抓到本地 URL，`waited=25214ms`；页面 `Failed to fetch`） | `desktop/run-url-result.txt` |
| R2 | **demo 自动流程** | **6 步通过 / 1 步失败**（失败即 run-url） | `desktop/demo-rehearsal-result.txt` |
| R3 | **本机 moon test** | 零输出、退出码 1（`moon check` 正常）→ **测试数字以 CI 为准** | 本机实测；`TECH-DEBT.md` |
| R4 | **数天级长稳** | 未验证（最长单次约 15 分钟；另有 3 轮×5 万请求） | `docs/VERIFICATION.md` §5 |
| R5 | **多实例联合压测** | 未验证（`cluster` 机制已验证，未做「N 进程 + 反代」联合压测） | `docs/VERIFICATION.md` §5 |
| R6 | **真实通知渠道** | 未验证（Alertmanager 接收器是 webhook） | `deploy/README.md` §5.12 |
| R7 | **Windows 优雅关闭** | 存在限制（`accept` 在 Windows/IOCP 下不响应任务取消） | `docs/ROADMAP.md` / 源码注释 |

补充红灯（同样不得写成绿色）：

| # | 项 | 现状 |
|---|---|---|
| R8 | Docker 镜像构建（本机验证） | 本机网络受限未验证；CI 已跑通 |
| R9 | 断点调试器 | 已评估为**不可行**（Windows 只有 PDB，无 DWARF） |
| R10 | 桌面 LSP hover/跳转 | 依赖本机 `moon-lsp`，部分能力走符号索引降级 |
| R11 | **`verify:desktop` 的串联方式** | 9 个脚本用 `&&` 串联 → `verify-run-url` 一失败，后面 3 个（含 23 项功能体检）**静默不跑**；因此「verify:desktop 通过」与「23/23」当前无法在同一次运行里取得 | 本次 P0 基线快照（`changes/phase2-p0-baseline.md`） |
| R12 | **本机 MoonBit native 工具链故障** | `moon build --target native <可执行目标>` **全部 EXIT=127**（`moonc link-core` 失败，`main.c` 不生成）；`moon check` 正常、`moon test` 零输出。→ 本机仍跑不起 native 服务。**已不再阻塞任何门禁**：Run 链路验证已与 native 工具链解耦（纯 Node E2E + CI + 零依赖靶子），Gate M1-A 已 7/7 通过 | `changes/phase2-p1-run-diagnosis.md`（P1-06）、`changes/phase2-p1-run-url-target-and-orphan-fix.md` |

## 六、已知技术债

| # | 项 | 现状 | 处理计划 |
|---|---|---|---|
| D1 | `moon.pkg` 的 `warnings = "-79"` | **10 处**临时收窄 | P18：一次清一个包 |
| D2 | CI 的 Check 未开 `--deny-warn` | 宽松模式 | P18-05：等 D1 清完再开 |
| D3 | 空 catch 基线 | **95 处**（已冻结，禁止新增） | P18-06：分类后逐步清 |
| D4 | 未修复风险 U1–U10 | 不安全默认配置 / `kernel.run_capture` 通用执行 / `moon_ide` 参数 / 依赖未钉版本 / `curl \| bash` / preload IPC 面宽 / CSP unsafe-inline / 测试私钥入库 | P17：逐条收口 |
| D5 | AI Agent 布局 | 已决策：保持独立第 5 标签（勿再当悬案） | 冻结 |

## 七、三个绝对冻结区

| 区 | 保留 | 冻结 |
|---|---|---|
| **F1 Office** | 预览 / 中转 / 版本 / 备份 / 送 Agent | Word / Excel / PPT 编辑器 |
| **F2 Token** | Provider / Model / Base URL / API Key / Test Connection | Token 中转 SaaS |
| **F3 Agent** | 只围绕「当前项目 / 文件 / 错误 / 运行 / 测试 / API / 数据库」 | 通用 Agent 平台 |

## 八、开发节奏（每个任务）

```
取 1 个任务 → 阅读现状 → 定义修改边界 → 修改 → 局部测试 → 回归 → 记录 → Commit → 取下一个
```

**禁止**：取 10 个任务 → 一次全做 → 最后一起测。

---

## 附：Phase 全量顺序

```
P0 → P1(Run) → P2(ProjectContext) → P3(Command) → P4(Problem) → P5(AgentContext)
   → P5.5(Security Gate) → P6(Read) → P7(Execute) → P8(Modify) → P9(Verify) → M2
   → P10(Session) → P11(Memory) → P12(Provider) → P13(Workbench) → P14(Backend)
   → P15(Database) → P16(Quality) → P17(Security) → P18(TechDebt) → P19(Testing)
   → P20(Productization) → P21(Product Demo) → P22(Regression) → P23(Release)
```
