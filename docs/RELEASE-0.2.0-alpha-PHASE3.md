# Phase 3 发布记录：`0.2.0-alpha`

- 日期：2026-09-26
- 分支：`phase2-engineering-workspace`
- 版本：**`0.2.0-alpha`**（**不升 beta**，理由见第三节）
- 前一阶段：Phase 2.1 收口于 `0.2.0-alpha`，Phase 3 在其上继续

---

## 一、发布内容：Phase 3 的 16 条主线

| 主线 | 状态 |
|---|---|
| **PH3-V** 验证体系收口 | ✅ 局部 `chk` 基线 **0**；验证器有异常测试 |
| **PH3-AI-01~06** Adapter / 唯一出口 / Key 生命周期 / 脱敏 | ✅ `UI → adapter → transport`；opencode 降为一种传输实现 |
| **PH3-AI-07/09/10/11** 真实模型路径 | ⏸ **NOT_RUN**（需 Provider —— 见第四节） |
| **PH3-TASK** Agent Task Runtime | ✅ 10 状态机 / 预算 / 崩溃恢复（只标记不自动继续） |
| **PH3-IDE-01~13** Agent × IDE 融合 | ✅ 当前文件与选区进 Context；Patch 显示在 Monaco diff；时间线/状态栏/通知；**后台运行** |
| **PH3-SESSION** 会话深化 | ✅ 标题/搜索/导出/回放（**白名单取字段，不泄漏思维链**） |
| **PH3-MEM** 项目记忆深化 | ✅ 五类 Schema；候选→确认；**不相关就不注入**；跨项目隔离 |
| **PH3-WS** 项目工作空间 | ✅ 统一身份（跨平台规范化）；一致性自检；删除只删元数据 |
| **PH3-BE** 后端融合 | ✅ Profile / 状态机（含 `DEGRADED`）/ OpenAPI 发现 / 错误进问题模型 |
| **PH3-DB** 数据库工作流 | ✅ 连接五态；表结构进 Agent；**草案必须过闸** |
| **PH3-Q** 质量事实层 | ✅ 溯源（真实 commit/环境/mtime）；`STALE`；退化检测（相对基线） |
| **PH3-ENV/REC** 环境与恢复 | ✅ 环境四态（`MISSING ≠ ERROR`）；**异常退出不搬现场** |
| **PH3-SEC** 安全第二轮 | ✅ Manifest 审计；行为测试（注入/超时/死循环/Cancel）；边界复核（真路径） |
| **PH3-IPC** 治理 | ✅ 审计（134→135 入口，未配对 0）；统一返回结构 + 合规率度量 |
| **PH3-UI** 信息架构 | ✅ 三层显示（核心/辅助/工具）；状态栏摘要徽标（没问题就不显示） |
| **PH3-OFFICE** 办公融合 | ✅ 关联 Task；便签进 Context；**待办 → 任务不猜意图** |
| **PH3-REL** 发布治理 | ✅ 模块↔测试审计（82 模块 / 新增缺口 0）；7 个门禁 |
| **PH3-MB** `-79` 版本矩阵 | ⏸ **DEFERRED**（本机看不到该告警，等 CI 证据） |
| **P22** 全量回归 | ✅ 报告 `docs/REGRESSION-P22-PHASE3.md` |

---

## 二、验证现状（可复现的数字）

```
纯 Node 测试      55 个   失败 0
Electron verify   55 个   初跑失败 9 → 修 6 → 剩 3（均已解释）
静态门禁           7 个   全部 EXIT=0
commits          186
desktop JS       192
docs/changes      71 份
```

七个门禁：`check-empty-catch` · `check-local-chk` · `check-handler-refs` ·
`audit-ipc` · `audit-agent-tools` · `audit-desktop-security` · `audit-release`

剩余 3 个 Electron 红灯的**性质**（详见 P22 报告）：
`verify-harness`（是库不是脚本）、`verify-strapi-parity` / `verify-strapi-final`
（"抄 Strapi UI"时代的配色对比，**主题已 token 化 → 前提已变**）。

---

## 三、为什么是 `alpha` 而不是 `beta`

**Gate G1（Agent Runtime）** 要求"**至少一条完整的真实路径**"：
真实 Provider + Ask + Read + Patch + Verify。

目前：
- ✅ 机制全部就位（Adapter、唯一出口、工具循环、Patch 两段式、验证闭环）；
- ✅ 用 Mock LLM 的端到端全通（含失败/预算/Resume/Cancel/记忆复用/跨项目隔离）；
- ❌ **真实模型的那一条从未跑过** —— 机器上既没有可用的 Provider Key，也没有本地 Ollama。

按 **RULE-01「未验证 = 未完成」**，这一条**不能标 beta**。
它的状态是 **NOT_RUN**，而不是"应该没问题"。

> 这也是整个 Phase 3 唯一剩下的、**需要人来提供前置条件**的项。

---

## 四、挂起项（都有明确的前置条件）

| 项 | 状态 | 前置 |
|---|---|---|
| PH3-AI-07/09/10/11 | **NOT_RUN** | 一个真实可用的 Provider（API Key 或本地 Ollama） |
| PH3-E2E-01~06 | **NOT_RUN** | 同上 |
| PH3-MB `-79` | **DEFERRED** | CI 里某一版的 moon **能看到**该告警（由新加的探测步每次记录） |
| P3-12 终端接 Command Registry | **DEFERRED-BY-DESIGN** | 真 PTY 没有自然触发点 |
| `verify:desktop` 的 `&&` 串联（R11） | 已知债 | — |

---

## 五、本阶段最有价值的几条记录

1. **"未验证 = 未完成"** 在本阶段反复生效：办公面板"打开永远空白"、
   `fs:write` 守卫比以为的更严、跨环境工作空间身份不一致 —— **都是真跑才暴露的**。
2. **假绿比红灯危险**：25 条永远通过的断言、异常 exit=0、`typeof x === 'boolean'` 恒真 ——
   B 类比 A 类多，因为**代码写错会报错，而验证写错不会**。
3. **判据错会造假缺口**：`mock-llm` 被误报、`translate-strapi` 被误分类 ——
   **假缺口与假绿一样有害**（会让工具失去可信度）。
4. **两套机制要分清**：危险路径表（无条件拒）与用户确认闸（无 `confirm` 就拒）——
   混测会得出相反结论。
5. **一个"什么都拒绝"的沙箱是坏的** —— 用户会发现功能不可用，然后**去关掉它**。
   能拒该拒的、也能放行该放行的，才叫边界成立。

---

## 六、产物

| 文档 | 说明 |
|---|---|
| `docs/PHASE3.md` | Phase 3 状态文件（18 节，唯一状态口径） |
| `docs/REGRESSION-P22-PHASE3.md` | 全量回归报告（9 个红灯逐条解释） |
| `docs/MOON-VERSION-MATRIX.md` | `-79` 的版本矩阵与收窄判据 |
| `docs/changes/` | **71 份**变更记录 |
| `tools/`（7 个） | 静态门禁与审计，全部挂 CI |
