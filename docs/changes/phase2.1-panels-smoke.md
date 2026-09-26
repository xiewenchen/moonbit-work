# 面板冒烟测试：10 个面板"打开就得有东西"

- 日期：2026-09-26
- 状态：**DONE**；`verify-panels-smoke` **25/0**
- npm：`npm run verify:panels-smoke`

## 为什么加它

上一批修掉的那个 bug 有个危险特征：`showOfficePanel()` 结尾**从没调 `refresh()`** →
面板挂上去了、IPC 也全对，**但打开永远是空的**。而本文件其余 4 个面板都有加载调用，
**只有它漏了**。「漏一处」型的错误，靠读代码很难穷尽 —— 但"打开一个面板，看里面有没有东西"
一秒就能验。

所以我把这件事变成一条**会自己跑的**测试：

对每个面板：
1. 调它的入口（`window.moonbitIDE.*.show()` / `agentTools.provider.openPanel()`）；
2. 断言**根节点存在**；
3. 断言 **`textContent` 有实质内容**（> 40 字符）—— 这是关键那条：
   `≤ 40` 就直接提示"打开就空，疑似漏了加载调用"；
4. 对有关键容器的面板（`#providerList` / `#qualityList` / `#officeRelay` / `#aboutInfo`）再单独断言非空。

另外全程监听 `error` 与 `unhandledrejection`，最后断言**零未捕获异常** ——
面板里的 bug 常常先在这里冒头。

## 结果

**10 个面板全部通过，没有发现新的空白面板**（含：Provider / Quality / 数据库 / 工作台 /
会话 / 项目知识 / 办公 / 环境 / 设置 / 关于）。也就是说那一处确实是唯一的 ——
但这条结论现在**有据可依**了，而不是"我看了下觉得别处没问题"。

## 顺带修掉的三处**测试自身**的错

我对面板 id 是**猜的**，真跑前先核对了一遍，猜错 3 处：

| 我写的 | 实际 |
|---|---|
| `sessionPanel` | **`sessPanel`** |
| `memoryPanel` | **`memPanel`** |
| `agentTools.provider.show()` | **`agentTools.provider.openPanel()`** |

（`providerPanel` / `qualityPanel` / `dbPanel` / `wbPanel` / `officePanel` / `envPanel` /
`settingsPanel` / `aboutPanel` 猜对了。）—— 又一次说明：**id 和 API 名该查就别猜**。

## 为什么不进 CI

它是 Electron 脚本（要窗口、要 DOM），而 CI 跑 Linux 无显示环境 —— 按仓库既有规矩
（`verify-*.js` 不进 CI），只挂 npm script，本地/发布前跑。
纯逻辑那部分（面板数据）仍由各自的 `test-*.js` 在 CI 里守着。
