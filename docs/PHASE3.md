# MoonBit Work · Phase 3 状态文件

> 本文件是 Phase 3 的**唯一状态口径**。任何"完成了"的说法以本文件为准。
> 建立：2026-09-26（PH3-BASE-03）；执行顺序见 §25 的 16 条主线。

---

## 1. 冻结现状（PH3-BASE-01 / 02）

| 项 | 值 | 采集方式 |
|---|---|---|
| **当前 HEAD** | `e96db19`（`fix(tools): check-handler-refs 的 --ci 被当成目录`） | `git log -1 --oneline` |
| 分支 | `phase2-engineering-workspace` | `git rev-parse --abbrev-ref HEAD` |
| 工作区 | **干净**（0 项变更） | `git status --short` |
| 远端 | `origin/phase2-engineering-workspace`，`ahead=0 behind=0` | `git rev-list --left-right --count` |
| **MoonBit 源码** | **94 个 `.mbt`** | `find . -name '*.mbt'`（排除 `_build` / `.mooncakes`） |
| **MoonBit 包** | **30 个 `moon.pkg`**（此前资料写 29，以实测 30 为准） | `find . -name 'moon.pkg'` |
| **commits** | **151** | `git log --oneline \| wc -l` |
| **桌面 JS** | **159 个**（39 纯 Node 测试 / 50 Electron 验证 / 6 静态工具） | `find desktop -maxdepth 1 -name '*.js'` |
| MoonBit 工具链版本 | 本机 `moon 0.1.20260915`；**native 后端不可用**（见 §4 R12） | `moon version`（此前实测） |
| 桌面版本 | `0.2.0-alpha`（**不标 beta**，理由见 §5） | `desktop/package.json` |

---

## 2. 当前 Phase

**PHASE 3 · 第 1 批（12 个任务）· 进行中**

第一批清单（清单 §26）与本轮实际结论：

| 任务 | 状态 | 说明 |
|---|---|---|
| PH3-BASE-01 确认 HEAD | **PASS** | `e96db19`，见 §1 |
| PH3-BASE-03 建立 PHASE3.md | **PASS** | 本文件 |
| PH3-BASE-04 旧任务映射表 | **PASS** | 见 §3 |
| PH3-V-01 扫描剩余局部 `chk` | **PASS（Phase 2.1 已完成）** | `tools/check-local-chk.js --ci` → **基线 0 个** |
| PH3-V-02 迁移第一个 `chk` | **PASS（Phase 2.1 已完成）** | 34 个脚本已迁到 `verify-harness.js`；局部定义归零 |
| PH3-V-19 验证器反向测试 | **PASS** | `test-verify-harness.js` 36/0，含 `chk([])` / `chk({})` → FAIL |
| PH3-AI-01 确认 AI Adapter 接口 | **PASS** | 见 §5.1 |
| PH3-AI-03 确定唯一 Provider→Adapter 路径 | **PASS** | 三步做完：opencode 收成 transport（32/0）→ adapter 支持 transport（85/0）→ **`agent:run` 改为只认 adapter**（`runOpencodeOnce` 残留 0）。见 §5.4 |
| PH3-AI-05 API Key 生命周期审查 | **PASS（修了 3 处）** | 见 §5.3 |
| PH3-AI-06 错误脱敏 | **PASS（本轮加固）** | 6/6 用例 + 3 条新断言 |
| PH3-AI-07 真实 Provider 连接测试 | **NOT_RUN** | **需要用户提供 Provider**（见 §6） |
| PH3-AI-09 真实模型只读任务 | **NOT_RUN** | 同上 |
| PH3-AI-10 真实模型错误分析 | **NOT_RUN** | 同上 |
| PH3-AI-11 真实模型 Patch Preview | **NOT_RUN** | 同上 |

---

## 3. 旧任务映射表（PH3-BASE-04）

| 旧任务 | 结论 |
|---|---|
| P0～P9（Phase 1 黑客松基线） | **已完成**并冻结于 tag `hackathon-final-2026-09-24` |
| P10 Session / P11 Memory | **已完成基础**，Phase 3 转为 **PH3-SESSION / PH3-MEM 深化** |
| P12 Provider | **已完成**（存储 / 面板 / 激活 / 探测 38/0）；Phase 3 转 **PH3-AI 真实模型接入** |
| P13 Workbench / P14 Backend / P15 Database / P16 Quality | **已完成基础**，Phase 3 分别转 **PH3-WS / PH3-BE / PH3-DB / PH3-Q 深化** |
| P17 安全 / P18 warnings / P19 测试体系 / P20 产品化 | P17 **已两轮**（高危 1→0）、P19 **已收口**（局部 chk 基线 0）、P20 **已完成 01/05/06** |
| P21 Demo / P22 回归 / P23 发布 | **已完成**（演示 28/0、回归 PASS、版本 0.2.0-alpha） |
| **P3-12 Terminal → Command Registry** | **DEFERRED-BY-DESIGN** —— 集成终端是真 PTY，没有"项目命令必须经 Command Registry"的自然触发点；不为打勾破坏 PTY 设计 |
| **P18 `warnings=-79`** | **不强制清** —— 只涉及 3 个包、用于跨版本兼容；本机工具链旧、无法完整验证 → 转 **PH3-MB**（版本矩阵 + 只在 CI 判断） |
| **Debugger（native 断点）** | **FROZEN** —— 已做过 PDB/DWARF 不可行性评估（`docs/DEBUGGER-FEASIBILITY.md`） |
| **Office / Token SaaS / 通用 Agent / 完整浏览器** | **FROZEN** —— 只保留 Office 的"关联项目 / 送 Agent / 结论进便签"这条链路 |

**新任务**（Phase 3 新增主线）：PH3-V / PH3-AI / PH3-TASK / PH3-IDE / PH3-Q / PH3-IPC / PH3-SEC / PH3-WS / PH3-E2E / PH3-REL。

---

## 4. 当前红灯与 SKIP

### 红灯（known-red）

| 编号 | 内容 | 处置 |
|---|---|---|
| **R12** | **本机 MoonBit native 工具链不可用**：`moon build --target native` → `EXIT=127`；`moon test` 零输出；`no system C compiler found` | **不修**（环境问题）。Run E2E 已搬进 CI；MoonBit 能力验证**只信 CI**。**禁止**把它算成 PASS |
| **R11** | `npm run verify:desktop` 用 `&&` 串联 9 个脚本 → 前一个失败后面静默不跑 | 已知技术债，未修（记在 `PHASE2.md`） |
| R10（P18） | `warnings = "-79"` × 3 个包 | 转 PH3-MB，**不机械删除** |

### SKIP（环境不满足，**不是** FAIL）

| 脚本 | 原因 | 语义 |
|---|---|---|
| `test-backend.js` | 需要 Docker（`mbp-pg` / `mbp-redis`）+ native 二进制 | 显式 SKIP |
| `test-api-debug.js` | 后端未运行（`ECONNREFUSED 127.0.0.1:8110`） | 显式 SKIP |
| `test-term.js` | 需 Electron 运行时（`require('electron')` 在纯 node 下不可用） | 显式 SKIP |

---

## 5. AI 接入层审计（PH3-AI-01 / 02 / 03 / 05 / 06）

### 5.1 接口现状（AI-01）

| 文件 | 导出 | 说明 |
|---|---|---|
| `agent-adapter.js` | `createAdapter` `normalizeResponse` `buildBody` `joinUrl` `DEFAULT_TIMEOUT_MS` `runToolLoop` `defaultRedact` | `generate()` / `stream()` / `toolCall()` + 最小 `runToolLoop` |
| `mock-llm.js` | `createMockLlm` `scenarios` | 与 adapter **同接口**，`isMock` 标记 |

**关键性质（AI-02 ✅）**：`agent-adapter.js` **不出现任何厂商名** —— 没有 `deepseek` / `ollama` 分支，
只有一份 `{baseUrl, model, apiKey}` 数据 + OpenAI 兼容端点 `POST {baseUrl}/chat/completions`。

### 5.2 ★ AI-03：目前**存在两条路径**，未收敛为唯一路径

清单要求：`UI → Provider → AI Adapter → Agent Runtime`，且**禁止** UI / Agent / Provider 三处各自直连。

实测结论：

| 路径 | 走法 | 是否合规 |
|---|---|---|
| **A（新，adapter 直连 HTTP）** | `Provider → agent-adapter.js（自己发 HTTP）→ 模型` | ✅ 这是清单要的形状 |
| **B（旧，起 opencode 子进程）** | `agent.js → spawn opencode run …`（`agent:run` / `agent:stop`） | ⚠️ **与 A 并存** |
| **C（配置写入）** | `ai-provider-main.js → 写 ~/.config/opencode/opencode.jsonc`（`options:{baseURL, apiKey}`） | ⚠️ 服务于 B |

**判定：PH3-AI-03 = FAIL。** 同一份 API Key 有**两条使用路径**（写进 opencode 配置给 B 用；直接给 A 用），
而 UI 文案（`aiagent.js`）与状态显示仍以 opencode 为准（`未找到 opencode —— npm i -g opencode-ai …`）。

> **这是本批最有价值的发现**：清单担心的"三处各自直连"确实存在，只是形态是"A 直连模型 / B 直连 opencode"。
> **修法必须渐进（RULE-04）**：先让 A 成为唯一出口，B 退化为"A 的一种传输实现"或标记 DEPRECATED，
> 不能直接删 `agent.js`（它当前仍是 UI 实际走的那条）。

### 5.3 ★ AI-05 / AI-06：脱敏只覆盖了"有响应"的路径（本轮已修）

`defaultRedact` 有三条规则（`sk-…` / `Bearer …` / JSON 里的 `apiKey|authorization`），
`createAdapter` 里 4 处 error 都过了 `redact(...)`。**但**：

| 位置 | 问题 | 状态 |
|---|---|---|
| `agent-adapter.js:193`（`runToolLoop` 的 "模型调用失败"） | **未脱敏**，且 `redact` 在该函数作用域内**根本不存在** | **已修**（`deps.redact \|\| defaultRedact`） |
| `agent-adapter.js:219`（兜底 `String(e.message)`） | 同上 | **已修** |
| `agent-adapter.js:125`（"返回不是合法 JSON"） | 未脱敏（此处 `redact` 可用，只是漏了） | **已修** |

**为什么值得记**：第 112 行的注释已经写明"注入的 request 可能把 headers 拼进 error —— **必须过脱敏**"，
但 193/219 两处属于**另一个函数**，拿不到那个 `redact` —— 于是"知道要脱敏"与"真脱敏了"之间差了整整一个作用域。
**这不是疏忽，是结构问题**（同 `runToolLoop` 无法访问 `createAdapter` 内部绑定）。

新增断言（`test-agent-adapter.js`，**69 → 72 项**）：
1. `runToolLoop` 收到抛错的 llm → 返回的 `error` 里 **Key 已脱敏**，且**错误本身没被吞**；
2. 非 JSON 响应体里带 Key → 也被脱敏；
3. 反向：`defaultRedact` 6 个用例（含 `ollama` 这种非 Key 串**不被误伤**）。

---

## 6. 需要用户决策的阻塞项（PH3-AI-07 / 09 / 10 / 11）

这 4 个任务的**前置**是"有一个真实可用的 Provider"。实测本机：

```
~/.moonbit-work/providers.json  → 仅有 placeholder（sk-****9999 形态的占位）
Ollama                          → 未安装 / 未运行
~/.config/opencode/opencode.jsonc → 只有 deepseek 一条，且 Key 是占位
```

因此按 **RULE-3-01（未验证 = 未完成）**，这 4 项**记为 NOT_RUN**，
**不**用 Mock 冒充"真实模型已验证"。需要用户提供其中之一才能继续（见本轮 ask）。

---

## 7. 已知风险（截至本文件建立）

1. **两条 AI 路径并存**（§5.2）—— 在收敛前，"Agent 用的是哪个模型"存在歧义。
2. **本机无法验证 MoonBit 侧**（R12）—— 所有 MoonBit 结论以 CI 为准。
3. **`0.2.0-alpha` 不升 beta**：因为"Agent 用**真实 LLM** 端到端修好一个项目"仍未验证（正是 §6）。
4. **`verify:desktop` 的 `&&` 串联**（R11）—— 可能掩盖后续脚本失败。
5. **P3-12 未做**（DEFERRED-BY-DESIGN）—— 集成终端不与 Command Registry 打通。

---

## 8. PH3-AI-03 进展：opencode 已收成 transport（2026-09-26）

清单描述的是「UI / Agent / Provider 三处各自直连」。**实测比这更具体**：

- **生产实际只有一条路**：`UI(aiagent.js:196) → IPC agent:run → agent.js → spawn opencode`
- **`agent-adapter.js` 只被 `mock-llm.js` 与测试使用** —— 生产环境**没人用**（与 `buildAgentContext` 同型的「建好未接」）

### 已做（第 1 步：等价抽取 + 单测）

新建 `desktop/opencode-transport.js`，把原先内联在 `agent.js` 里的三样搬出来并变成可测的纯逻辑：
事件解析（四种事件）、`--format json` 参数组装、启动与续接 id。
`agent.js` 的 `agent:run` 改为调 `runOpencodeOnce`，**行为等价**。

- 新测试 `test-opencode-transport.js` **32/0**（含「`--format json` 必须带」、「close 事件带回 sessionId」、
  「找不到 opencode 时错误文案与原文一致」），已挂 CI（12 steps）。
- `agent.js` 里内联的 `JSON.parse(line)` 残留 **0**；`verify-agent-config` 真跑 **9/0**；纯 Node 全量 **40 个**。
- 测试样本**取自 `agent.js` 里的实测注释**，不是我想象的格式。

### ★ 抽取时差点丢掉的副作用

原实现靠**每个事件里的 `sessionID`** 做多轮续接。我第一版没把它带出去（只取了 `text`/`tool`/`meta`/`error`）——
**「行为一字不改」需要逐条核对，而不是感觉上一样**。为此补了断言：
「事件里带 sessionId」+「只有 sessionID、没有内容的事件也要传出去」。

### ★ 门禁抓到了我自己（值得记）

写 `test-opencode-transport.js` 时，我在文件里**自写了一份 `chk`**（还写了注释"本文件用自带断言"）——
结果 `node tools/check-local-chk.js --ci` 直接报 **「当前带局部 chk：1 个；基线 0 个」**，
而**我已经把它提交了**。

> 这条最该记的不是"我错了"，而是**"理由"不能豁免门禁**：我当时确实有理由（想让这个测试保持
> 零依赖、纯 Node）。但门禁的规则是"新增局部 chk = 0"，理由再充分也不该绕。
> 已改用公共 `verify-harness`（`chk(name, ok, detail)` 签名一致，改动极小）。
> —— **Phase 2.1 建立的这套门禁，在本批第一次抓到的是它的作者。**

### 还剩（第 3 步）—— **已完成**

`agent.js` 的 `agent:run` 也改成**只认 adapter**：

```js
const adapter = createAdapter({ transport: 'opencode', provider: { model }, opencode: { spawn, resolveSpawn, findBin, sessionId, cwd, onSpawn } })
adapter.generate([{ role: 'user', content: prompt }], { onEvent })
```

于是 `agent.js` 里 `runOpencodeOnce` 残留 **0**、`JSON.parse(line)` 残留 **0** ——
**UI 不再自己 spawn、不再自己解析事件**，只认 adapter 的接口。

过程中遇到一个**真实的接口约束**：IPC 必须**立即**返回 `pid`（`agent:stop` 靠它 kill），
而 `adapter.generate()` 是 Promise。解法是给 opencode deps 加 `onSpawn(child, pid)` 同步回调
（`new Promise` 的 executor 是同步跑的，所以它一定在 `generate()` 返回前触发）。
另给 `opts.onEvent` 加了**原始事件透传** —— 否则 tool/meta 事件到不了界面。

验证：`test-agent-adapter` 81 → **85/0**（新增 onSpawn 同步拿 pid、onEvent 收到 tool/meta。
`verify-agent-config` 真跑 **9/0**；纯 Node **40 个**。

**结论：PH3-AI-03 = PASS。** 唯一出口成立：`UI → adapter → transport → 模型`，
opencode 只是 transport 的一种实现。

---

## 10. PH3-IDE-01/02：当前文件与选中代码进 Context（2026-09-26）

**发现**：接口**早就建好了** —— `agent-request.js` 第 203/204 行一直有
`deps.getActiveFile` / `deps.getSelection`，但**渲染侧从没提供**（源码注释写着"留给 P5A 后续"）。
所以这两项不是"要新做"，而是"**把已经留好的口子接上**"。

**做了**：
- `renderer.js` 新增 `activeFileOf()`（从 Monaco model 取，**不是磁盘** —— 用户可能改了没存）
  与 `selectionOf()`（从编辑器选区取文本与起止行）。
- `collectRendererInputs()` 改为**默认从编辑器取**，调用方仍可显式覆盖（测试靠这个注入假数据）。
- `window.moonbitIDE.editor` 暴露只读视图：`openFile` / `activeFile` / `selection` /
  `selectLines` / `clearSelection` —— 其中 `selectLines` 正是产品入口
  "选中代码 → Ask Agent"（PH3-IDE-02）要用的能力，同时让验证**真造选区**而不是假装有。

**一处刻意的不假装**：没开文件 / 没选区时返回 **null**，而不是空对象/空串 ——
与 Quality 的 `NOT_RUN`、数据库的 `NO_CLIENT` 是同一条原则：**别把"没有"说成"有"**。

**验证**：`verify-agent-request` 41 → **55/0**（+14）。⑨ 节真开 `desktop/package.json`、
真选 1–3 行，逐步断言：
- 没开文件 → 快照里**没有** activeFile；打开后 → 有（记路径与字符数，**不塞全文**）；
- 没选区 → 没有；选 1–3 行 → 有且行号对得上；清空后 → **又回到没有**（证明是真读，不是缓存）；
- `sources.activeFile` / `sources.selection` 标为 `ok`（而不是 `absent`）。

> 过程中又踩一次「没先查就写」：断言里用了 `A`，而该脚本的变量其实叫 `ROOT`（RULE-03 的又一次提醒）。
> 还有一次是我把 `sources` 的层级写错（它在 `snapshot` 里，我写成了顶层）。

---

## 11. PH3-IDE-06/07：Patch 显示在 Monaco diff（2026-09-26）

原先 Patch 只能在对话框里读一段文本（`agent-patch.js` 的 `renderPatchPreview`）。
现在 `window.moonbitIDE.patchDiff(patch, opts)` 开一个**只读**的 Monaco diff：
`original ↔ modified` 并排 —— 真正的落盘仍走 P8 两阶段（propose → 用户点 Apply），
**预览与写入是分开的**，这一点没有因为"能看到 diff"而放开。

「跳到修改位置」按钮（PH3-IDE-07）打开真实文件并滚到改动行。

### ★ 这一批我自己踩的两个坑（都值得记）

1. **把函数声明插进了对象字面量内部** —— `window.moonbitIDE = { … }` 里的注释与 `editor`
   属性挨着，我按注释定位插入，结果 `function showPatchDiff` 落在对象里 → 语法错。
   （`node --check` 当场抓到。）改为对象方法 `patchDiff: (…) => {}`，编辑器实例挂 `window`
   上（对象内声明不了模块级变量）。
2. **`window.moonbitIDE.editor.patchDiff` 不存在** —— 它挂在 `moonbitIDE` 上、不在
   `editor` 下，我转发时写错了一层。

> 第 2 条能定位，**是因为验证里包了 `try/catch`**。否则只会看到 electron 的
> `Script failed to execute`（它不告诉你渲染侧到底抛了什么）。
> 这是"异常也要给出可读原因"的又一次实际收益。

**另**：空 catch 门禁**又一次**抓到我（`dispose()` 的 `catch (_) {}`）—— 补了说明归入 B 类。

**验证**：`verify-patch-diff` **17/0**（真造补丁、断言宿主里出现 `.monaco-diff-editor`
而**不是**普通编辑器、点跳转后状态栏文件名真的变了且正是补丁里那个文件、
缺 `file`/`old-new` 时如实拒绝、关闭按钮能收掉面板）。
回归 `verify-agent-request` 55/0、`verify-panels-smoke` 25/0、`verify-agent-patch` 28/0；纯 Node 41 个。

---

## 12. PH3-IDE-09/10：任务时间线 + 状态栏（2026-09-26）

`window.moonbitIDE.taskUI`：`begin(goal)` / `step(name, ok, detail)` / `status(s)` /
`finish(ok, reason)` / `snapshot()` / `fromVerifyProgress(ev)`。

两条刻意的边界：
- **渲染层不握状态机** —— 状态是否合法仍归 `agent-task.js`；这里只负责**如实显示**
  （失败就是失败，不美化成"部分成功"）。
- **数据来自已有事件流**（`onAgentData` / `onAgentVerifyProgress`），不新开通道，
  也不重放"思维链"——只显示**做了什么、结果如何**。

### ★ 验证抓到我的 2 个真 bug

1. **`begin()` 没调 `renderTaskTimeline()`** —— 容器的创建挂在渲染函数里，不渲染就什么都没有。
2. **`step()` 里写了 `if (!active) active = true`** —— `finish()` 把 `active` 置 false 之后，
   它自己末尾记的那一步又把 `active` 设回 true → **任务"复活"**，`snapshot().active` 永远是 `true`。

> 第 2 个正好落在"**终态必须是真的终态**"上 —— 与 `agent-task.js` 里"终态没有出边"
> 是同一条原则，只是镜像到了渲染层。**同一类错误会在不同层重复出现。**

### 第三次踩同一个坑（这次换个方法）

把 `const` / `function` 插进了 `window.moonbitIDE = { … }` 对象字面量内部 → 语法错。
前两次靠"改写成对象属性"绕过，这次改用 **`sed` 按行号整体搬移到对象之前**，
并先 `node --check` 确认边界。

> 结论：**往这个文件插代码前，必须先确认插入点在对象外** —— 我已经在这个文件上栽了三次。

**验证**：`verify-agent-timeline` **22/0**（真建时间线、七步都上页面、失败行显示 ✗、
`finish(false)` 后状态栏是"Agent: 失败"而不是"已完成"、切标签后快照仍在）。
回归 `verify-patch-diff` 17/0、`verify-agent-request` 55/0、`verify-panels-smoke` 25/0、
`verify-agent-config` 9/0；纯 Node 41 个。

---

## 13. PH3-IDE-08：验证结果进 Problems / Quality（2026-09-26）

**先核对才发现大部分早就有**：P9 接线时 `onAgentVerifyProgress` 进了输出面板、
`onAgentVerifyDone` 已经 `problems.add(ps)` 写进**统一问题模型**。
所以清单里的 "→ Problems / Output" **当时就通了**。

**缺的是 "→ Quality" 那一路**。做法**不新开机制**：
- `quality:snapshot` 本来就支持 `opts.sources`（"显式传入的来源优先"）；
- 所以 `onAgentVerifyDone` 里把这次结果记成 `window.__lastAgentVerify`，
  由 `quality.snapshot()` **默认带上**（`Object.assign({ sources: agentVerifySources() }, opts)`）。

> 只保留**最近一次**，不累积 —— 否则反复验证会往 Quality 里堆重复项，
> 而 Quality 该回答的是"**现在怎么样**"，不是"历史上跑过几次"。

### ★ 又踩一次"名字撞车"

我最初把这条 source 命名为 `agent-verify`，而磁盘上**已经存在** `agent-verify-result.txt`
（别的验证脚本写的），Quality 扫描时把它读了进来。我的断言用 `indexOf('agent-verify')`
模糊匹配，**匹配到了那个文件** —— 于是"3 个失败"那条断言读到的是 `17/0`。

> 这与之前 `chk`/`eq` 语义撞车、`dash` 按钮顺序撞车是**同一类**：
> **一个名字/顺序承载了两种含义**。修法不是改断言，而是**把名字改独特**
>（`agent-verify（最近一次）`），并让断言精确匹配。

**验证**：`verify-quality-ui` 20 → **26/0**（+6）：Agent 验证结果出现在工程状态里、
失败标 FAIL（3 个失败不美化）、带 passed/failed 计数、全通过标 PASS、
**没跑过验证时不会凭空多出一条**。
回归 `verify-agent-timeline` 22/0、`verify-patch-diff` 17/0、`verify-panels-smoke` 25/0、
`verify-problems` 14/0；纯 Node 41 个。

---

## 14. PH3-Q-06/07/08：事实层接线（2026-09-26）

上一节只建了"层"，这一节把它**接进系统**（否则它只是"一个能跑的库"）。

`quality-main.js` 的 `snapshotQuality` 现在额外产出 **`fact`** 字段（**旧字段一个不动** ——
这是"加一层"，不是"换一套"，符合 RULE-04）：

| 字段 | 来源（**必须真实**） |
|---|---|
| `fact.commit` | 读 `.git/HEAD`（含 worktree 的 `ref:` 二级跳转），纯 fs 不起进程 |
| `fact.environment` | `process.platform` → windows/linux/mac |
| `fact.origin` | `LOCAL` —— `desktop/*-result.txt` 是**本机**跑 verify 脚本产出的，不是 CI（不冒充 CI） |
| 每条的 `verifiedAt` | **产物文件的 mtime** —— 磁盘上的真实事实 |
| `provenance.command` | **留 null** —— 结果文本里本来就没记命令，**不编一个** |

于是 `PH3-Q-08` 也通了：Agent 的 `qualityStatus` 只读工具返回同一份快照
（它本来就不重跑测试），现在里面**带 `fact` 与 `canProceed`**，Agent 能据此判断
"现在到底能不能继续"。

**验证**：`verify-quality-ui` 26 → **43/0**（+17）：`fact.commit` 是真实短 hash、
`environment` 是本机平台、`origin` 是 LOCAL（不是 CI）、`verifiedAt` 来自 mtime 且不是 0、
`provenance.command` 如实为 null、旧字段全部仍在、Agent 工具也拿到同一份。

> 又是一次「断言取错层级」：工具返回的 `data` **直接就是**快照，我写成了 `data.snapshot.fact`。
> 与之前 `sources` 那次同型 —— **先看清返回形状，再写断言**。

---

## 9. PH3-TASK：Agent Task Runtime（2026-09-26）

新建 `desktop/agent-task.js` + `test-agent-task.js`（**91/0**，已挂 CI）。
纯逻辑、全依赖注入 —— 因此**不需要真实模型**即可完整验证。

| 任务 | 状态 | 落点 |
|---|---|---|
| TASK-01 定义 AgentTask | PASS | `createTask()` → `id/sessionId/goal/status/startedAt/finishedAt` + `budget` + `usage`，**冻结** |
| TASK-02 定义 Task 状态 | PASS | 9 个状态 **+ INTERRUPTED**（崩溃恢复用） |
| TASK-03 创建 Task | PASS | `createTask()` |
| TASK-04/05/06 Understanding→Plan→Tool | **部分** | 状态跃迁已就位；Plan 的 `action/source/reason` 待接（依赖真实模型） |
| TASK-07 记录 ToolCall | PASS | `createToolCall()` → `tool/args/startedAt/endedAt/result` |
| TASK-08/09/10 用户等待点 | PASS | `needsUser()`（patch / 危险命令）+ `WAITING_USER` 进出边 |
| TASK-11/12/13 预算 | PASS | `DEFAULT_BUDGET` + **执行前** `checkBudget()` → `TASK_BUDGET_EXCEEDED` |
| TASK-14 Resume / TASK-15 Cancel | PASS | 任何非终态 → CANCELLED；INTERRUPTED → EXECUTING（需用户明确要求） |
| TASK-16 Recovery | PASS | `recoverInterrupted()` **只标记，不自动继续**；幂等 |

### ★ 写这批时，测试抓到我自己的 2 个真 bug

1. **`recoverInterrupted(null)` 抛 `tasks is not iterable`** —— 默认参数 `tasks = []` 对 **`null` 不生效**
   （只有 `undefined` 才触发默认值）。改为 `Array.isArray(tasks) ? tasks : []`。
2. **时间预算永远拦不住** —— 写成 `task.startedAt || at`，而 `startedAt` 可以是 `0`（合法时间戳），
   `0` 是 falsy → 被当成「没有开始时间」→ `elapsed` 恒为 0。
   改为 `Number.isFinite(task.startedAt) ? task.startedAt : at`。

> 两个都是**边界输入**才暴露的：前者要传 `null`，后者要传 `0`。这就是 RULE-3-03
> 「验证器必须测异常输入」的实际价值 —— 正常输入下这两个 bug 都看不出来。

让 `agent-adapter.js` 使用这个 transport，使 **adapter 成为唯一出口**，UI 与 Agent Runtime 只认 adapter。
当前 adapter 仍只走 HTTP，与 transport 尚未汇合 —— 所以 **AI-03 整体仍未 PASS**。

---

## 15. PH3-REL：发布前工程治理（2026-09-26）

`tools/audit-release.js` + 基线 `tools/release-baseline.json`，已挂 CI。
**79 个模块，真缺口 9 个（新增 0）** —— 其余模块要么有 `test-*`，要么有 `verify-*`，
要么被别的测试 `require` 过。

### 这个工具最花心思的两处是**判据**

1. **分类**：`*-main.js` 是接线层（由 verify 覆盖）、`e2e-*`/`probe-*` 是工具脚本 ——
   对它们要求单测是错的。不分类会报出一堆假缺口。
2. **"没有同名测试文件" ≠ "没被测"**：第一版把 `mock-llm.js` 报成新缺口，
   而它被 `test-agent-adapter.js` 直接 require 并断言了行为。加了 `referencedByTest`
   之后新增缺口从 1 变 0。

> 假缺口与假绿一样有害 —— **它会让人开始不信这个工具**。

### PHASE3.md 本身（REL-10）

本文件即 REL-10 的产物：§1 冻结现状、§2 当前 Phase 与第一批任务结论、
§4 红灯与 SKIP、§6 需用户决策的阻塞项、§7 已知风险，
以及各阶段的实现记录（§8-§15）。任何"完成了"的说法以本文件为准。

---

## 16. PH3-MB：`warnings = "-79"` 的版本矩阵（2026-09-26）

产出：**`docs/MOON-VERSION-MATRIX.md`** + CI 新增一步**非阻断**的可见性探测（13 steps）。

### 订正了一个数字

资料说 `-79` "只涉及 3 个包" —— **实测是 10 个**：
`app` `bench` `conduit` `demo` `http` `http/server` `kernel` `pg` `pg/client` `redis`。
（对照：`-29` 出现在 **21 个包**，它是 `test_unqualified_package`，与 `-79` 无关，别一起处理。）

> 要动就是动 10 个包，不是 3 个 —— 这条先订正掉，否则"影响面"一开始就是错的。

### 做了一个可复现的对照，证明**本机测不出来**

```bash
cd conduit && sed -i 's/-29-79/-29/' moon.pkg && moon check --target native
# → Finished. moon: ran 2 tasks, now up to date (33 warnings, 0 errors)
```

**告警数一个没变。** 这说明本机这份工具链**根本不产生** `-79` 对应的告警 ——
于是"去掉它会不会有问题"在本机**从原理上就测不出来**：
删掉它不报错，不是因为安全，而是因为**本机看不到那个检查**。

### 结论：这一项的正确状态是 `DEFERRED`（等证据），不是 `TODO`（等动手）

- CI 里已有 `moon version`；现在再加一步探测，**每次 CI 都会留下实测结果**；
- 该步 `continue-on-error: true` —— 它是**报告**不是**判定**（版本差异不是代码问题）；
- **只有** CI（或某明确版本）里"去掉 `-79` 后告警数会变"，才说明那一版能用来判断收窄。

按 RULE-04，将来收窄也要**逐个包**做（一次一个、每个都跑 CI），而不是 10 个一起改。

---

## 17. PH3-IDE-11：后台运行 —— 切标签时任务**仍在推进**（2026-09-26）

原来的验证只断言了 `typeof active === 'boolean'` —— **那恒真，等于没验**。
清单要的是"切走之后 Agent 任务**继续**"，所以重写成了三件事：

1. **切走后 `active` 仍是 `true`**（任务没被中断）；
2. **在别的标签页上调 `step` 也真的被记下** —— 这才是"仍在推进"的实证；
   而且**失败那步也如实记**（后台不美化）；
3. **切回来能接上**（步数**继续累加，没重置**，前后步骤都在，目标也没被改）。

过程中 type gate 又抓到一次我自己的错：`chk` 传了字符串（第二参必须是布尔），
当场 FAIL 并提示"数组/对象比较请用 `eq`"。另：我把步数数错了（`begin` **不产生**步骤），
断言从 `>= 5` 改成 `>= 4`。

**验证**：`verify-agent-timeline` 22 → **33/0**（⑥ 节 12 条）。

---

## 18. PH3-REL 复核（2026-09-26）

用新挂的 `audit-release` 把这一整个 Phase 3 新增的模块盘了一遍：

```
模块 82 个　test 55 个　verify 55 个　有覆盖 53 个
本次新增缺口 0 个
```

**新增缺口 0** —— 本批新增的 10 个模块（`ipc-result` / `ui-hierarchy` / `office-fusion` /
`workspace` / `quality-fact` / `memory-schema` / `session-view` / `backend-profile` /
`db-context` / `env-recovery` / `agent-task` / `opencode-transport`）**都有对应测试**。

### 复核时修掉一处**误分类**

基线里原来有 `translate-strapi.js` —— 但它是**构建/转译脚本**（生成 `index.html`），
不是产品模块。它的产物由 Electron verify 覆盖，它自己不需要单测。
已把 `translate-` / `build-` / `gen-` 前缀归入 `tool-script`，基线 **9 → 8**。

> 这与上一批"mock-llm 被误报"是同一类：**判据错 → 报假缺口**。
> 假缺口不会让代码出错，但会让这个工具失去可信度。

### 剩下 8 个的性质（写进基线 note，不假装它们不存在）

- `d17.js` `d18.js` `holidays.js` `icons.js` `moonbit-lang.js` —— dash 的静态资源，改动风险低；
- `fsops.js` `lsp-manager.js` —— 由 `verify-*` 间接覆盖；
- `aiagent.js` —— UI 交互层（由 `verify-agent-config` / `verify-p20-ui` 等覆盖）。

---

## 19. P22 全量回归 + P23 发布（2026-09-26）· Phase 3 收口

### P22 全量回归

```
纯 Node 测试      55 个   失败 0
Electron verify   55 个   初跑失败 9 → 修 6 → 剩 3（均已解释）
静态门禁           7 个   全部 EXIT=0
```

报告：**`docs/REGRESSION-P22-PHASE3.md`**（9 个红灯逐条给根因与处理）。

**其中最值得记的一条**：`verify-project-memory.js` 因为 P17 把 `fs:write` 收窄成
"**必须已打开项目**才能写"而**静默地不再验证它想验证的东西** —— 它一直只用 `ROOT` 当参数、
从没 `openProject`。这条**读代码看不出来**，只有全量跑才暴露。

另一个真实缺口也写进了报告：**55 个 Electron verify 平时不在任何人手里跑**
（CI 是 Linux 无显示环境，只跑纯 Node + 静态门禁；Electron 靠发布前手动全量）。

### P23 发布：`0.2.0-alpha`

发布记录：**`docs/RELEASE-0.2.0-alpha-PHASE3.md`**。

**为什么不升 beta**：Gate G1 要求"至少一条完整的真实路径"（真实 Provider + Ask + Read +
Patch + Verify）。机制全就位、Mock 端到端全通，但**真实模型那一条从未跑过** ——
按 RULE-01 它就是 **NOT_RUN**，不能标 beta。
---

## 20. PH3-Q-10/11 界面入口：「记为基线」（2026-09-26）

后端早就有 `compareWithLast` / `saveBaseline`，但**用户点不到** —— 这就是"做了但点不到"的假完成。
本批把它接成质量面板上的一个按钮，并在过程中被"真跑"抓出 **5 个只有点下去才会暴露的问题**：

| # | 症状 | 根因 | 性质 |
|---|---|---|---|
| 1 | 面板上根本没有这个按钮 | 只做了后端方法 | 假完成 |
| 2 | 点了不保存、**也不报错** | `renderer` 传 `saveBaseline`，`snapshotQuality` 读 `opts.save` —— 名字不一致 | 静默失败 |
| 3 | 退化行建了**两个**（同 id） | `refreshPanel` 里已有一个，我又新加了一个 → `getElementById` 取到错的那个 | 重复元素 |
| 4 | **明明保存成功却报"失败"** | 我读 `r.regression`，而真实结构是 `r.snapshot.regression` —— 层次写错 | 显示错误（比"没保存"更糟：用户会反复点） |
| 5 | 诊断手段本身失效 | `contextBridge` 暴露的 API 是**只读**的，包装 `window.moonAPI.qualitySnapshot` 被静默忽略 | 测试方法失效 |

第 4 个是靠"文件的 mtime 变了 vs 界面说失败"这对矛盾定位出来的 —— **光看代码看不出来**。
第 5 个导致我一开始的"记录返回值"诊断一直显示"（没调到）"，正好自证了包装无效，
于是改用**真实证据**（文件 mtime）判断"到底写没写"。

> 验证：`verify-quality-baseline.js` **16/0**（真开面板 → 覆盖 confirm → 真点按钮 →
> 断言退化行说明确、断言文件 mtime 变了、断言再刷新已能比较 → **最后恢复用户目录原状**）。
---

## 21. PH3-ENV-04 接线：环境面板上的「PATH 补全建议」（2026-09-26）

`env-recovery.js` 里早有 `pathFixups`（"缺了可能装在哪"），但**只在测试里用过、从未接线** ——
又一个"做了但点不到"。接成环境面板上的一段之后，**接线那一刻连着暴露 3 个同型问题**：

**同一个教训的三个面孔：两个模块用不同的名字描述同一件事。**

| # | 症状 | 名字不一致的两边 | 后果 |
|---|---|---|---|
| 1 | 面板上一条建议都没有 | `pathFixups` 判 `r.state` ↔ `checkEnvironment` 给 `r.found` | 判据永远不成立 → **永远返回空** |
| 2 | 缺 `agent` 时没有候选 | 候选表的 key 是 `opencode` ↔ 探测项的 id 是 `agent` | 缺的就是它 → **界面上空白** |
| 3 | （PH3-Q-10/11 同型）点了不保存 | 界面传 `saveBaseline` ↔ 后端读 `opts.save` | **静默失败** |

> 三个都是"看起来没数据，其实是名字没对上"。**光读代码很难发现**：
> 每一边单独看都正确，只有把它们接在一起、并且**真跑一遍**才会露出来。

第 2 个尤其值得记：候选表里写死 `opencode`（工具名）而探测项用 `agent`（角色名）——
**写死一个名字，就会在某次改名后静默失效**。现在两个 key 都留。

验证：`verify-env-fixups.js` **18/0**，含一条**防假通过**的设计 —— 本机缺的项未必在候选表里，
那样"面板上没有建议"是**正确的**，于是"面板上有建议"永远测不到；所以额外用已知 id
（`moon`）**强制造一个缺失项**，把判据本身锁住。另外面板与后端的一致性用
`界面有该段 === 后端有建议` 断言（两侧同源，不会恒过）。
