# Phase 2.1 第一批：P19 收尾（5 项）+ P5A Agent Context 真接线（5 项）

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：P19-15～19 **DONE**；P5A-01～05 **DONE**
- 规则：RULE-01（未验证=未完成）/ RULE-03（改前先看清对象）/ RULE-04（渐进迁移）

---

## 一、P19：把验证器做成可信基础设施（收尾 5 项）

### P19-15 盘点 16 个 `chk` 定义

全仓 33 个文件含 `chk` 定义。其中 `verify-*.js` 共 **17 个**，去掉公共模块
`verify-harness.js` 本身 = **16 个**，与清单说的 16 一致。**全部已有类型闸、全部尚未用 harness**。
（`test-*.js` 16 个是**相等语义**，结构上不会假通过，不在范围内。）

### P19-16 / P19-17 逐文件迁移（禁止一次批改 16 个）

一次只动一个文件、跑一次原测试：

| # | 文件 | 改动 | 迁移后 |
|---|---|---|---|
| 1 | `verify-run-url.js` | require harness；删局部 `chk`；结果行 → `H.summary()`；退出码 → `H.exitCode()` | **5/5** |
| 2 | `verify-run-dispatch.js` | 同上（它的定义在**顶层**，不是 `whenReady` 内） | **5/5** |

**已迁移 2/16**。剩余 14 个记进基线，用 P19-18 的扫描器保证只减不增。

### P19-18 禁止新增局部 `chk`

新增 `tools/check-local-chk.js`，形态与 `check-empty-catch.js` 一致（基线 + `--freeze`/`--ci`/`plain`）：

- 基线 `tools/local-chk-baseline.json` = 当前 14 个文件，**只允许减少**；
- CI 新增步骤 `No new local chk`（ci.yml 现 11 steps）；npm script `check:local-chk`。

**自测（双向）** —— 这一条很关键，否则又是个"没被验证的验证器"：

| 场景 | 期望 | 实测 |
|---|---|---|
| 新增一个带局部 `chk` 的脚本 | FAIL | **exit=1** ✓ |
| 写 `const chk = H.chk`（来自 harness 的别名） | PASS（不该误报） | **exit=0** ✓ |

> **自测当场抓到扫描器第一版的 bug**：它把 `const chk = H.chk` 也当成"局部定义"，
> 导致基线记成 16 而不是 14。已修为排除来自 `H.chk` / `harness` 的赋值。

### P19-19 脚本异常必须 exit != 0

**静态**（按类型区分，避免误报）：
- Electron 脚本（含 `app.whenReady()`）：必须有顶层 `.catch`；
- 纯 Node 脚本：必须有显式非 0 退出路径；
- `verify-harness.js`（公共模块）豁免。

结果：**全部通过**。此前静态列表里的 `verify-demo.js` / `verify-url-regex.js`
是**纯 Node 脚本**（未捕获异常 Node 默认 exit 1），不是假绿。

**动态**（真造一个 throw）：注入到 `verify-run-url.js` 的副本 →
**Electron 脚本 exit=1**（并打出 `[FATAL] script threw…`）；纯 Node 脚本同样 **exit=1**。
探测文件已清理。

### Gate P19 现状（如实）

```
16 chk 全迁移        ❌ 2/16
新增 chk = 0         ✅（扫描器守住）
假绿 = 0             ✅
异常 exit=0 = 0      ✅
环境型错误有 SKIP     部分（test-backend / test-api-debug 已有）
```

→ **P19 仍不能宣布 PASS**（迁移是渐进任务，本批只做清单要求的 #1/#2）。

---

## 二、P5A：Agent Context 真正接线（5 项）

### 为什么之前不算"接上了"

`agent-context.js` 的组装器（P5）早就建好，但它的输入是**调用方随手传的普通对象**；
配套的 `buildAgentContext(sources)` **建好后没有任何生产调用点**（只在它自己的单测里用过）。

### 做了什么

| 任务 | 产出 |
|---|---|
| P5A-01 | `createAgentRequest`：`requestId/sessionId/message/projectContext/activeFile/selection/createdAt`，带校验 + 归一化 + 整对象冻结 |
| P5A-02 | `createAgentResponse`：四态 `ok/need_confirm/failed/cancelled`（保住"Patch 必须先经用户确认"的语义）+ 摘要裁剪 |
| P5A-03 | **ProjectContext 真实接入**：渲染侧把它真正持有的 `projectCtx` 经 IPC 交给主进程组装 |
| P5A-04 | **Problems 真实接入**：从统一 Problem Model 取（上限 50 条） |
| P5A-05 | **Context Snapshot**：默认给摘要（项目/文件/问题分布/**取数四态**/上下文长度），`includeRendered` 时才带全文 |

**接线方式（架构判断）**：契约刻意留在**主进程**，渲染侧只负责"收集它才有的真实状态"。
理由：渲染侧不能 `require` 本地模块（P2 踩过——多个模块顶层 `const` 在同一全局作用域会重复声明）。
若把契约搬过去，就得把两个 CommonJS 模块改成双环境导出，风险大于收益。

**`sources` 四态**（这是本批最有价值的设计）：

```
absent     没注入这个来源
empty      注入了但没数据（null / 空数组）
ok         真的拿到了值
error: …   取数报错了
```

→ 让"**没数据**"与"**取数炸了**"分得开 —— 这正是空 catch 门禁要防的那类误会。

### 验证

| 测试 | 结果 |
|---|---|
| `node test-agent-request.js` | **44 / 0**（契约校验、摘要裁剪、四态、真实模块集成） |
| `npx electron verify-agent-request.js` | **19 / 0**（打开**真实**项目 → `projectType=moonbit`、`rootDir` 对得上；造一个问题 → 快照数量**真的增加**；无项目也能提问） |
| 全量纯 Node | **27 个脚本全通过** |
| 回归 | `verify-run-url` 5/5、`verify-run-dispatch` 5/5 |
| 门禁 | 空 catch 94 ≤ 95；local-chk 通过（已迁移 3 个） |

`verify-agent-request.js` 是**新脚本，直接用公共 harness**（P19-18 起的要求）。

---

## 三、本批踩的坑（都记下来）

1. **python 改 JS 源码翻车第三次**：`'\n'` 在 python 字面量里是**真换行**，写进 JS 就断行
   （前两次：30 个文件、2 个文件）。这次报废了 `test-agent-request.js` 一次。
   **教训已收紧为硬规则：改 JS 源码不用 python 拼字符串，直接用写文件工具。**
2. **`createProjectContext` 的输入字段是 `root` / `kind`**，输出才是 `rootDir` / `projectType`；
   我在测试里传了输出名 → 校验失败。**是测试错了，不是产品错了**（RULE-03 的反面例子，第三次同类）。
3. **顶层 `await` + `require` 冲突**：Node 直接抛 `ERR_AMBIGUOUS_MODULE_SYNTAX`
   （"both 'require' and top-level await are present"）。测试主体必须包进 `async function main()`。
4. **`edit_file` 没有 `replace_all`**（那是 `multi_edit` 的参数）；`multi_edit` 是**原子**的，
   一个锚点错整批不写。
5. **断言预期写错两次**：`activeFile`/`problems` 在"注入了但没数据"时是 `empty` 而非 `ok/absent`。
   —— 修的是**断言**，但顺带把 `sources` 的语义从三态细化成四态（产品更好）。

---

## 四、剩余风险 / 未做

- **P19：14/16 个 `chk` 未迁移**（基线已冻结，不会偷偷变多）。
- **P5A：`activeFile` / `selection` / `lastRun` / `lastTest` 尚未接线**，当前记为 `empty`/`absent`；
  调用方可显式传入。这四项属于 P5A 后续。
- **契约只在主进程**：渲染侧目前传的是普通对象，由主进程校验（若将来需要在渲染侧也校验，
  得做双环境导出）。
- 第一批**未触及** P9A（Ask/Understand）/ P9B（Mock LLM）/ P9C（Agent E2E）——
  按清单，那要等本批 PASS 后再进。
