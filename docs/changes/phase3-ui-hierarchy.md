# PH3-UI-01/02/03/04/05/08/09/10/11：信息架构与状态摘要

- 日期：2026-09-26
- 新增：`ui-hierarchy.js` + `test-ui-hierarchy.js`（**53/0**，一次通过）+ `verify-ui-hierarchy.js`（真 DOM **32/0**）
- 已挂 CI；npm script `verify:ui-hierarchy`

## UI-01/02：先把结构盘清楚

实测：一级标签 **5 个** —— `home / project / ai / agent / tools`。
清单 §12 描述的是"Home/Project/Agent/Workbench/Tools"，实际是 **`ai`（AI Agent）而非 workbench**。

## UI-05：三层显示 —— 现在的问题不是"功能不够"，是**什么都一样显眼**

| 层 | 内容 | 权重 |
|---|---|---|
| **core** | 首页(Open Project) / 项目(Work) / AI Agent / 运行(Run) / 测试(Test) | 0 |
| **support** | 后端 / 数据库 / 工程状态 / 工作台 | 1 |
| **tool** | 文件中转站 / 工具 | 2 |

清单点名的五条核心路径里，**Run 与 Test 不占一级标签**（它们挂在项目页的动作里）——
这条写进了 `summarizeStructure().note`，并由断言守住。

## UI-11：工作台**不抢主视觉**

它被明确放在 support 层，且**不在**一级标签里（测试断言 `tabsOf()` 里没有它）。

## UI-08：Problem 徽标 —— **没有问题就不显示**

`problemBadge()` 在空列表时返回 **`null`**（"不该显示徽标"），而不是显示一个 "0"。
> 天天挂着一个红点数字反而是噪音。测试同时断言 **DOM 里也确实没有那个节点**。

严重度分档：有 `error` → `error`（红）；只有 `warning` → `warn`（橙）——
**不该用同一个红点**。

## UI-09/10：Quality 与 Backend 摘要

- **Quality**：沿用事实层三态语义 —— `NOT_RUN` → `info`（**不是 error**），`STALE` → `warn`。
- **Backend**：`DEGRADED`（进程在但不健康）**有自己的说法**，不混进 `RUNNING` 也不混进 `FAILED`；
  没探测过是"未启动"而**不是"失败"**。

## 一次快速修掉的失误（与上一批同型）

- `ui-hierarchy.js` **整个包在 IIFE 里** —— 因为上一批刚栽过"全局脚本顶层 const 撞名"。
  验证里专门断言了 `window.ENTRIES` / `window.TIER` **没有**冒出来。
- 我又一次把 `function` 写进了 `window.moonbitIDE = { … }` 内部（对象字面量里不能声明函数），
  用脚本把整块移到对象之前修好。
- 断言里两处**猜错了 API**：`TIER` 的键是**大写**（`CORE/SUPPORT/TOOL`）、`problems` **没有 `clear()`**。
  改成读真实条数再断言，不依赖"能清空"。
