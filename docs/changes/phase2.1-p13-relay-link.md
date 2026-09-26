# P13-04 补：从「中转站」选文件 + 修掉办公面板的一个真 bug

- 日期：2026-09-26
- 状态：**DONE**；`verify-office` 由 25 项扩到 **32/0**

## 做了什么

办公面板原来只能**手填文件路径**。而中转站早就有文件列表了 —— `relay-main.js` 的
`listAll()`（返回 `{src, name, count, lastSavedAt, exists}`）与 `readOfficeMeta()`，
IPC 也都是现成的（`relayList` / `relayMeta`）。

所以在面板里加了一块「从中转站选（已备份过的文档）」：

- 每行显示 `文件名（N 个版本）`，原文件已不在时**标黄提示**；
- **[看元信息]** → 把 relay 解析出的元信息**直接喂给** P13-05 的预览（不重新解析 docx/xlsx）；
- **[关联到本项目]** → 一键关联，不再手填路径。

数据**不另做一份索引** —— 就是 relay 的 `listAll()`。

## ★ 过程中挖出的三个真 bug（全是"真跑"才暴露的）

### 1. 办公面板打开时永远是空的

`showOfficePanel()` 结尾只做了 `document.body.appendChild(mask)`，**从没调用 `refresh()`**。
本文件其余面板（workbench / memory / environment…）都有这一步，只有它漏了。
也就是说：这个面板挂上去之后**从来没显示过任何数据**。

⚠️ 值得记住的是 —— **怎么发现的**：我先前只验证了 IPC（`office.links()` 直接调，全对），
所以"面板能不能打开"过了、"关联/预览/便签"也过了，唯独**没有人看过面板里到底有没有东西**。
这次为了验证"从列表点关联"才第一次去读 `#officeRelay` 的 `textContent`，一读就是空的。

### 2. `refreshRelay()` 加错了面板

我先把它加在 `refresh()` 末尾 —— 但那个 `refresh()` 属于**工作台**（`showWorkbenchPanel`，第 1357 行），
而 `refreshRelay` 定义在**办公**面板内部（第 1604 行）。跨作用域调用 → `ReferenceError`
→ 被 `refresh().catch()` 静默吞掉 → 表现还是"空的"。

这文件里有 **5 个同名 `refresh()`**（每个面板一个），锚点找错一次就中招。

### 3. 最后是 TDZ

即使位置对了，`const ctx` 定义在调用**之后** → 抛
`Cannot access 'ctx' before initialization`。
**是我加的那个 `.catch` 把它打出来的**（"读中转站失败：Cannot access 'ctx' before initialization"）
—— 如果没有这个 catch，它会安静地失败，我又要猜一轮。

> 三个 bug 叠在一起，症状是同一个："列表是空的"。所以我一度以为是 relay 数据的问题，
> 甚至写探针去查 `listAll()`（结果它一直是对的，4 条）。**分层排查**（数据层 ✓ → 渲染层 ✗）
> 才是省时间的那条路。

## 验证

`verify-office` ⑦ 节：真造一个 `.docx` → `relayBackup` → 重开面板 → 断言列表里有它 →
点「看元信息」断言显示了内容（且对假 docx 如实说"没有可读的内置属性"）→
点「关联到本项目」断言 links 从 0 变 1 → 收尾解关联并删探针。

回归：`verify-workbench` 23/0（我动过它的 `refresh()`）、`verify-p20-ui` 20/0、纯 Node 39 个、门禁三项。
