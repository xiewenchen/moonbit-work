# Phase 2 / P8 补完：Patch 的 UI 确认对话框

> 承接上一批（Patch 核心层已建、36 项单测通过，但 `confirm` 只有一个注入点、**没有界面**）。
> 规则：RULE-01｜执行时间：2026-09-24（+08:00）

## 一、为什么做成**两阶段**

`applyPatch` 需要 `confirm` 回调 —— 而那本该是**用户点按钮**。
如果要在一次 IPC 里等用户点按钮，就得做双向 IPC（主进程 ⇄ 渲染侧来回问），复杂且容易漏掉超时/重入。

改两阶段后，「确认」天然由渲染侧的用户动作完成：

```
propose(patch)   → 校验（沙箱/危险/存在/old 精确匹配）+ 算 diff + 返回 token 与 preview
用户看对话框     → 点「应用」→ apply(token)  → 备份 → 写入 → 审计
                  点「取消」→ cancel(token) → 丢弃
```

两个安全细节：
- **token 一次性**（apply/cancel 后即失效）+ **有效期 10 分钟**（防止陈旧确认）；
- **备份路径 → 原路径**的映射留在主进程内存里，回滚时不靠猜文件名。

## 二、对话框实现的一个刻意选择

**用动态 DOM 创建，不改 `index.html`**。

原因：`index.html` 是**转译产物**（`ide-source.html` → `translate-strapi.js` → `index.html`），
直接改它会在下次转译时被覆盖（这个坑在 `docs/TECH-DEBT.md` 里记过）。
对话框是一次性 UI，动态创建最省事也最安全。

对话框内容：文件路径 + 摘要、`新增约 N 行 / 删除约 M 行 · 应用前会自动备份`、
新旧代码预览、`取消 / 应用` 两个按钮。

## 三、Agent 侧仍然**没有**"直接写文件"的能力

```
window.moonbitIDE.agentTools.patch = { propose, apply, cancel, proposeAndApply, audit }
```

有一条断言检查这个键集合 —— **没有 `writeFile` 这类入口**。
Agent 只能**提议**，落盘必须过用户那一下。这是 P8-02 在 UI 层依然成立的证据。

## 四、验证（RULE-01）

```bash
cd desktop && npm run verify:agent-patch
```

**结果：28 通过 / 0 失败**

| 组 | 关键断言 |
|---|---|
| ① | 打开临时 workspace（用 `mkdtemp` 造，不碰真实项目）|
| ② propose | 正常 → token + preview + diff；**越界 / `.git` / old 不匹配 → 各自的拒因** |
| ③ **取消** | cancel 成功；**token 立即失效**；**文件内容一个字节没变** |
| ④ apply | 真的改了；**备份存在且内容是改前的**；**token 一次性**（再 apply 被拒）|
| ⑤ **真实对话框（应用）** | `#patchDialog` 出现、按钮文案 `取消,应用`、标题含文件名与摘要；点「应用」后**文件真的改了** |
| ⑥ **真实对话框（取消）** | 点「取消」→ 结果是 `cancelled`；**文件一个字节都没变** |
| ⑦ 审计 | 同时含 `applied` 与 `cancelled` 两类记录 |
| ⑧ 结构 | patch API 的键集合固定，**没有 `writeFile`** |

**回归**：纯 Node 全量 **15 个脚本** —— 25/12/25/29/48/43/44/46/14/28/48/39/31/**36**/51，全 0 失败；
**`npm run verify:demo`** **7 步通过 / 0 步失败**（改了 main/preload/renderer，必须回归）；
`check-empty-catch --ci` **94 ≤ 基线 95**。

> 说明：验证会往 `~/.moonbit-backups/` 写几个 `.bak`（就是它该干的事）。
> 它们是无害的审计痕迹，没有清理。

## 五、P8 完成度

| 任务 | 状态 |
|---|---|
| P8-01 ～ P8-11（Patch 模型 / 默认拒绝 / 精确匹配 / 备份 / 危险目标 / 审计 / 回滚）| ✅ |
| **UI 确认对话框** | ✅ **本批补完**（预览 + Apply/Cancel，真点击验证）|
| Gate P8（Preview + Confirm + Backup + Sandbox + Audit）| ✅ **产品意义上也成立了** |

## 六、未做

| 任务 | 说明 |
|---|---|
| 接到 Agent | 让 Agent 产出 Patch 并走这条流程（`proposeAndApply` 已是现成入口）|
| 备份清理策略 | 目前备份只增不减 —— 将来要有保留策略（否则 `~/.moonbit-backups/` 会一直长）|
| P9 Verify | Patch → Check → Test → Run → Health 的验证闭环 |
