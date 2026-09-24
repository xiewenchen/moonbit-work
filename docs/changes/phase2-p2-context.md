# Phase 2 / P2 第一批：ProjectContext（盘点 + 定义 + Factory）

> 对应任务：**MBW-P2-01 ～ MBW-P2-05**｜规则：RULE-03（改前先摸清）/ RULE-04（先建接口、再迁移调用点）
> 执行时间：2026-09-24（+08:00）
> 前置：Gate M1-A 7/7 已过、Gate A 已解锁

## 一、P2-01 盘点：同一条事实此前散在四处

| 变量 | 位置 | 类型 | 写入点 | 读取点 | 是否权威 |
|---|---|---|---|---|---|
| **`cwdInput.value`** | `renderer.js:98` | string | 582 / 601 / 636 / 664 / 766 | **14 处**（286,446,679,685,825,1085,1181,1367,1484,1527,1810,1836,2039…）| ✅ **事实上的权威**（所有 IPC 都拿它当根）|
| `rootDir` | `renderer.js:102` | string\|null | 365 | **只有 82（一次）** | ❌ 冗余（存了几乎不用）|
| `projectInfoCache.root` | `renderer.js:2001` | object | 2005 | 2028 | ❌ 冗余（`project:info` 的副本）|
| `lspRoot` | `renderer.js:1525` | string\|null | 1535 | 1529 | ❌ 冗余（LSP 单独记一份）|
| `tabs[active].path` | `renderer.js:103/104` | — | 207/226/227/247 | 271/1316 | ✅ 「当前文件」的唯一来源（这点是好的）|
| `DEFAULT_CWD` / `START_DIR` | `main.js:75-78` | string | `resolveStartDir()`（59） | 各 IPC handler | 兜底值（两个名字指同一个）|

### 三个具体的「重复表达」问题

1. **项目根有 4 份，且互不同步**：`cwdInput` / `rootDir` / `projectInfoCache.root` / `lspRoot`。
2. **`rootDir` 与 `cwdInput` 会真的不一致**：`boot(dir)` 在 `renderer.js:766` 设 `cwdInput.value = 用户选的目录`，
   紧接着 `loadTree` 在 `770/773` 设 `rootDir = 模块根 || 用户选的目录` —— 当 `findModule` 找到模块时，**两者是不同路径**。
3. **项目类型有两套独立算法**：`project-detect.detectProject`（renderer 用）与 `runners.kindOf`（运行入口用），
   外加 `renderer.js:826-828` 又解析一次。

### 各模块「自己找根」（技术债的核心）

| 模块 | 取根方式 |
|---|---|
| `main.js` | `moon`(186) / `moon:stream`(244) / `moon:format`(299) / `term:create`(420) / `diag:check`(580) / `outline:get`(589) / `search:files`(599) / `symbols:load`(659) / `symbols:hover`(696) —— **9 个 handler 各写一遍** `cwd && cwd.length>0 ? cwd : DEFAULT_CWD` |
| `project-detect.js:79` | 同上回退 |
| `backend.js` 108 / 143 / 158 | 同上回退（其中 `backend:build` **直接**用 `DEFAULT_CWD`）|
| **`api-debug.js:145`** | **固定用 `DEFAULT_CWD`，忽略传入的 cwd** ← 即接口面板永远读本仓库的 `conduit/openapi.yml`（**待迁移时修**）|
| `lsp-manager.js` | 用传入的 `root`，无回退（空 root 直接报错）|
| `runners.js:454` | `root \|\| process.cwd()` |
| `agent.js:154` | `cwd \|\| process.cwd()` |

### 已有的「单一来源」迹象（可以借力的）

- `resolveStartDir()`（`main.js:59`）—— 启动目录的集中解析；
- `detectProject()` / `project:info` —— 项目类型 + 能力可用性的集中解析；
- `boot(dir)`（`renderer.js:759`）—— 前端切换项目的集中入口；
- `refreshProjectInfo()` / `renderProjectKind()` —— 前端消费识别结果的集中点。

**结论**：识别与切换各有"半集中"的点，**但「根目录解析」没有单一来源** —— 这是 P2 要解决的核心。

## 二、P2-04 审计：`project-detect` 是否"只负责识别"

逐条核对清单要求：

| 要求 | 现状 |
|---|---|
| 只返回 ProjectInfo | ✅ `detectProject()` 返回 `{root, kind, label, features}` |
| 禁止启动 | ✅ 没有 spawn / 进程相关代码 |
| 禁止编译 | ✅ 无 |
| 禁止改 UI | ✅ 纯主进程模块，不碰 DOM |

**结论：已满足**。唯一可议之处是 `registerProjectIpc` 里那句 `cwd || DEFAULT_CWD` 回退 ——
它属于「根解析」，按 P2 的设计应由 ProjectContext 提供；**本轮只记录，迁移时处理**（RULE-02）。

## 三、P2-02 / P2-03 / P2-05 产出：`desktop/project-context.js`

| 任务 | 导出 | 说明 |
|---|---|---|
| P2-03 | `PROJECT_TYPE` / `ALL_TYPES` / `normalizeType` | 8 种类型（moonbit/node/python/rust/go/**java**/**static**/unknown）；大小写与奇怪输入都能归一 |
| P2-02 | `createProjectContext` / `emptyContext` / `withActiveFile` | 清单要求的 9 个字段 + `label` / `features` / `createdAt`；**整对象冻结** |
| P2-05 | 同上（Factory）+ `TYPE_SPEC` | 由 `detectProject()` 的产物推导：类型 → 语言 / 包管理器 / build / run / test 命令 |
| 辅助 | `hasProject` / `isSameProject` / `describeContext` / `normalizeRoot` | 无项目态判据（P2-16）、多项目切换判据（P2-17）|

两个刻意的设计：

1. **整体 `Object.freeze`** —— 既然要当"单一来源"，就不能让任何一处随手改它；要变就换一个新对象（`withActiveFile` 即此模式）。
2. **`hasProject(ctx)` 作为「无项目态」的唯一判据** —— 取代现在"看 `body.no-project` 类名 / 看 `rootDir` 真假"这类散落判断。

## 四、验证（RULE-01）

```bash
cd desktop && node test-project-context.js
```

**结果：36 通过 / 0 失败**

| 组 | 覆盖 |
|---|---|
| P2-03 | 8 种类型齐备、大小写归一、奇怪输入 → unknown、每种都有 spec |
| P2-02 | 9 个字段齐全、值正确、缺省是 `null` 而非 `undefined` |
| P2-05 | 类型/命令/features 的推导；`overrides` 覆盖；python 的无 build 用空串 |
| 归一化 | 尾斜杠、**驱动器根 `C:\` 不被截断**、空值 |
| 不可变 | `rootDir` 与 `features` 都改不动 |
| 无项目/切换 | `hasProject`（含 null 不抛）、`isSameProject`（尾斜杠算同一、同目录不同类型算不同）、`withActiveFile` 换出新的 |
| **集成** | 与**真实** `detectProject()` 对接：空目录 → unknown、`package.json` → node、`moon.mod` → moonbit，且 MoonBit 的 run 命令带 `--target native` |

**回归**：纯 Node 全量 18/12/25/29/48/51/**36**（0 失败）；`check-empty-catch` 95 = 基线；CI YAML 校验通过。

## 五、本轮**未做**（明确留给下一批）

| 任务 | 说明 |
|---|---|
| P2-06 / P2-07 | 迁移 Renderer 使用 ProjectContext + 回归 |
| P2-08 / P2-09 | 迁移 Runner |
| P2-10 ～ P2-14 | 迁移 LSP / Terminal / API Debugger / Problems / Agent |
| P2-15 | 逐个废弃旧变量（一次删一个 + 回归）|
| P2-16 / P2-17 / P2-18 | 无项目态 / 多项目切换 / 关闭项目 的验证 |

> 本轮**没有改动任何调用点**（`renderer.js` / `runners.js` / `main.js` / `lsp-manager.js` … 全部零改动），
> 只在系统里多了一个**未被引用**的纯逻辑模块 —— 这正是 RULE-04 要求的「先建新接口，再迁移一个调用点」。

## 六、顺带记录的一个疑似缺陷（未修，留给迁移）

`api-debug.js:145` 的端点清单路径**固定用 `DEFAULT_CWD`**、忽略传入的 `cwd` ——
即"打开别的项目时，接口面板仍然列本仓库的端点"。迁移 API Debugger（P2-12）时应一并处理。
