# Phase 2 / P5-01 ～ P5-09：AgentContext

> 对应任务：**MBW-P5-01 ～ P5-09**｜规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）
> **本批只建组装器**；从 renderer / 主进程真实取数（接线）属下一批。

## 一、要解决的问题

清单 P5 的两种问法其实是同一件事的两面：

- **P5-08**：禁止「把整个项目全部塞给模型」；
- **P5-09**：上下文要有优先级 `当前任务 > 当前错误 > 当前文件 > 当前项目结构 > 必要历史`。

这两条决定了 Agent 是"看得见工程"还是"被噪音淹死"。

## 二、产出：`desktop/agent-context.js`（纯逻辑 + 依赖注入）

| 任务 | 内容 |
|---|---|
| P5-01 | `createAgentContext(input)`：`task / project / activeFile / selection / problems / lastRun / lastTest / recentFiles / history`，缺的一律 `null`/`[]`（**不编造**），整体冻结 |
| P5-02～P5-07 | `buildAgentContext(sources)`：每类数据由调用方注入（**值或函数**，函数会被 `await` —— 允许异步取，如读文件）|
| P5-08 | `AGENT_CONTEXT_LIMITS`：总预算 24000 字、单文件 8000、选区 2000、问题 3000、项目路径最多 40 条、最近文件 5、历史 1000 |
| P5-09 | `CONTEXT_PRIORITY`：`task > problems > activeFile > selection > project > history` |
| 渲染 | `renderAgentContext(ctx, opts)` → `{ text, used, maxChars, included, omitted, clipped }` |

### 三个刻意的设计

1. **`problems` 的优先级高于 `activeFile`** —— 排查问题时「当前错误」比「整个文件」更值钱。
   清单给的顺序就是 `当前任务 > 当前错误 > 当前文件 > …`，这里照做。
2. **项目只给骨架**：`renderPiece('project')` **只读 `files`（路径清单）**，
   即使调用方把内容挂在 `project.content` 上也**不会被渲染**（有专门断言）。
   这是 P5-08「禁止塞整个项目」的**落点** —— 靠代码结构保证，不靠自觉。
3. **被丢掉的部分要如实说明**：文本末尾追加
   > 注：因上下文预算（N 字）不足，以下部分**未提供**：history、project。如果需要，请明确要求我读取某一项。

   否则模型会**以为自己看到了全部**，然后基于缺失信息乱下结论。这比多点噪音危险得多。

## 三、验证（RULE-01）

```bash
cd desktop && node test-agent-context.js
```

**结果：28 通过 / 0 失败**

| 组 | 关键断言 |
|---|---|
| P5-01 | 全空也合法（字段不编造）；`recentFiles` 自动截到上限；**整体冻结** |
| P5-02～07 | 六类都能渲染（任务/问题/文件/选区/项目/历史）；问题带位置与来源；选区标出行范围；**异步数据源被 await**；`render:false` 只回对象 |
| **P5-08** | 项目段只列路径；**即使 `project` 上挂了 `content` 也不渲染**；100 个文件只列前 40 并说明总数 |
| **P5-08** | 单文件超长 → 截断 + **注明省略了多少字** |
| **P5-09** | `task` 必在 `included[0]`；预算不足时**丢的是 `history`/`project`**；**如实说明**；裁剪后总长不超预算 |
| 边界 | 全空不抛；只有任务时只渲染任务；无问题时无问题段；无 `rootDir` 时不渲染项目段 |

**回归**：纯 Node 全量 25 / 12 / 25 / 29 / 48 / 43 / 44 / 46 / 14 / **28** / 51 —— 全 0 失败；
`check-empty-catch --ci` **94 ≤ 基线 95**；CI YAML OK（已挂进桌面纯逻辑段）。

## 四、未做（下一批）

| 任务 | 说明 |
|---|---|
| 真实取数 | 从 renderer（`projectCtx` / 活动文件 / 选区 / `problems.list()` / `runner` 结果）与主进程组装真实上下文 |
| 接到 Agent | 喂给 `agent.js`（opencode）的 prompt —— 注意 Gate P3：**Agent 现阶段只有调用接口，不允许自动执行** |
| P5 之后 | **P5.5 Agent 安全门**（路径沙箱 / 命令沙箱 / 超时 / 输出限制 / IPC 审查）—— 未过不许进 Execute/Modify |
