# Phase 2 / P8-01 ～ P8-11：Agent 修改（Patch）

> 对应任务：**MBW-P8-01 ～ P8-11**｜规则：RULE-01 / RULE-04｜执行时间：2026-09-24（+08:00）
>
> ⚠️ **这是风险最高的一批**：Agent 第一次可能改动真实文件。

## 一、四条硬性防呆（不靠调用方自觉）

| 要求 | 实现 |
|---|---|
| **P8-02 Agent 只能产生 Patch，不能直接写文件** | 模块只导出 patch 相关能力（有一条断言检查导出键）；唯一入口是 `applyPatch()` |
| **P8-05 没有明确 `confirm` 就拒绝** | `const confirmed = typeof deps.confirm === 'function' ? await deps.confirm(...) : false` —— **默认拒绝**，不是默认通过 |
| **P8-07/08 `old` 必须精确匹配** | 在文件里找不到 → 拒；**出现多次 → 拒**（歧义）。绝不"猜到哪就写哪" |
| **P8-11 失败自动从备份恢复** | 写入失败 → `restore(backupPath)`，结果里带 `restored: true`；恢复也失败则明确说明两者都失败 |

顺序照清单 **P8-04**：`backup → calculate patch → preview`（**先备份，再算，再给人看**）。
测试里直接断言了调用顺序：`['read:a.mbt', 'backup:a.mbt', 'write:a.mbt']`。

## 二、P8-09 危险 Patch 判定表

| 目标 | 判定 |
|---|---|
| workspace 根本身 | 危险（禁止把整个工作区当 patch 目标）|
| `.git/` 下任意文件 | 危险 |
| `.env` / `.npmrc` / `.netrc` / `id_rsa` / `id_ed25519` / `credentials` / `.aws` | 危险（凭据）|
| `*.pem` / `*.key` / `*.pfx` / `*.p12` | 危险（密钥）|
| `old` 有内容而 `new` 为空 | 危险（等于清空文件）|
| 普通源文件 | 允许 |

另外两条规模闸：单次 patch 的字数与增删行数都有上限 —— **防住"整仓替换"伪装成 patch**。

## 三、`analyzePatch` 的两种"拒绝盲改"

```
old 在文件里找不到  → 拒（拒绝盲改）
old 出现多次        → 拒（有歧义，不知道改哪一处）
```

这两条是本批最重要的安全性质：**宁可拒绝，也不要在不确定的位置写入**。

## 四、写测试时抓到我自己的一个真 bug

`resolveInsideWorkspace` 返回的键名是 **`path`**，我在 `applyPatch` 里写成了 `g.abs`：

```js
const abs = g.abs        // ✗ undefined
```

后果：`abs` 是 `undefined` → 传给注入的 `readFile` → 里面对 `undefined` 取 basename 直接抛 →
**整个 patch 流程在第一步就静默失败**（返回值看起来像"文件不存在"）。

测试的 `calls` 数组为空把这条暴露了出来（"连一次 read 都没发生"）。
修法：`const abs = g.path`，并在旁边写清"键是 `path` 不是 `abs`"。

> 这也说明为什么这批要**注入式**设计：只有在假文件系统上，才能断言"调用顺序"与"一次都没写"。

## 五、验证（RULE-01）

```bash
cd desktop && node test-agent-patch.js
```

**结果：36 通过 / 0 失败**

| 组 | 关键断言 |
|---|---|
| P8-01/08 | 字段归一；`old==new` / 全空 / **找不到 old** / **old 出现多次** / 过大 → 全拒 |
| **P8-09** | workspace 根、`.git/config`、`.env`、`id_rsa`、`server.pem`、清空内容 → 全部判为危险；普通源文件允许 |
| **P8-05** | **不提供 confirm → 拒**，且 `calls === ['read:a.mbt']`（**没有备份、没有写入**）；`confirm` 返回 false → 同样拒 |
| **P8-04** | 调用顺序 **read → backup → write**；内容真的改了；结果带 diff 分析 |
| **P8-11** | 写入失败 → **restore 被调用**、`restored:true`；恢复也失败 → 明确说明；**备份失败 → 放弃修改（不写）** |
| P8-06/07 | 越界 / 文件不存在 / 危险目标 / old 不匹配 → 各自的 `reason` |
| P8-03/10 | preview 含文件/新旧/摘要；**每次尝试都留审计（含被拒的）**，含 `file/summary/duration/result` |
| P8-02 | 模块导出键里**没有**直接写文件的能力 |

**回归**：纯 Node 全量 **15 个脚本** —— 25/12/25/29/48/43/44/46/14/28/48/39/31/**36**/51，全 0 失败；
`check-empty-catch --ci` **94 ≤ 基线 95**；CI YAML OK。

> 本批**没有改动任何既有文件**（只新增 `agent-patch.js` + 测试 + CI 一行），所以没跑 Electron 回归 ——
> 也就没有引入 UI 层风险。

## 六、Gate P8 状态

| 判据 | 状态 |
|---|---|
| Preview | ✅ `renderPatchPreview`（文件 / 旧 / 新 / 摘要）|
| Confirm | ✅ 注入式确认；**缺省即拒绝** |
| Backup | ✅ 先备份再写入；备份失败则放弃 |
| Sandbox | ✅ 复用 `resolveInsideWorkspace` + 危险目标判定 |
| Audit | ✅ 每次尝试一条（含被拒的）|
| 失败回滚 | ✅ 自动 restore（P8-11）|

**GATE P8 通过。**

## 七、未做（下一批）

| 任务 | 说明 |
|---|---|
| **UI 接线** | 真正的"Patch 预览 + Apply/Cancel 对话框" —— 目前 `confirm` 只有注入点，**没有界面**。这是 Gate P8 在**产品意义上**的最后一环 |
| 接到 Agent | 让 Agent 产出 Patch 并走这条流程（P9 Verify 会紧接着做 Patch → Check → Test → Run → Health）|
| 备份存储 | 目前 `backup` 由调用方注入；落地时应接 `relay-main` 已有的 `~/.moonbit-backups` 机制 |
