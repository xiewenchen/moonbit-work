# P20-01 / 05 / 06：欢迎屏重排 + Settings + About

- 日期：2026-09-26
- 分支：`phase2-engineering-workspace`
- 状态：**DONE**；`verify-p20-ui` **20/0**

## 一律动态注入，不改 `index.html`

这三项都是界面改动，但 `index.html` 是 `translate-strapi.js` 的产物 —— 直接改它下次转译就没了。
所以全部走运行时注入，并有一条断言守着：**`index.html` 里搜不到 `ws-p20` / `settingsPanel` / `aboutPanel`**。

## P20-01 欢迎屏重排：四个入口

清单要的是"首页只突出 Recent Projects / New Project / Continue / Agent"。做法是**追加**一块
到 `.ws-card` 里 —— 原有的「打开项目 / 新建项目」**保留**（它们是既成入口，不该被替换掉）。

四个入口的数据**全部复用已有来源**，不新存一份：

| 入口 | 数据来自 |
|---|---|
| Recent Projects | **P13 工作台的 `recent`**（同一份数据，工作台里改了这里就跟着变） |
| New Project | 原有的 `#wsNew` |
| Continue | **P20 启动快照**（`startup:plan`）；异常退出时按钮文案会变成「继续上次（上次异常退出）」并给一句说明 |
| AI Agent | 切到现有的 `a[data-view="ai"]` 标签 |

「最近项目」那块是**每次重建**而不是"有了就跳过" —— 因为打开/关闭项目后列表会变。

## P20-05 Settings：只放真有作用的开关

不做摆设。面板里有：

- **Agent 直接执行**（写 `localStorage['ag-autostart']`）—— 这就是 P9A 那个开关，
  控制 aiagent 是否先弹理解卡；文案里写明"**不影响「改文件前必须确认」**"；
- **主题**（跟随时间 / 日间 / 夜间）；
- **数据存放位置**：把 `workbench.json` / `startup.json` / `office-links.json` 的真实路径列出来
  —— 少一次"我的数据去哪了"。它们都在 `~/.moonbit-work/`，**不进项目仓库**。

端到端里**真的勾了一下开关**，然后断言 `localStorage` 确实变成了 `1`（不是只看界面上有个勾）。

## P20-06 About：版本来自真实探测

新增 `app:about` IPC，返回 `package.json` 的版本 + 真实的 Electron / Node / Chromium / 平台。
端到端断言"界面上的版本字符串 == IPC 返回的版本"，也就是说**它不是硬编码的**。

面板里还写清了**为什么只标 alpha**：IDE Core + Agent Read 已成立，而
"Agent 用**真实 LLM** 端到端修好一个项目"未验 —— 按 RULE-01 不标 beta。

## 过程中修的两处（都值得记）

1. **`if (hint) x else y` 是语法错** —— JS 里这个写法必须带花括号。`node --check` 当场抓到。
2. **空 catch 门禁抓到了测试脚本里的一处** `catch(_){}`（在模板字符串里）→ 改成打日志。
   顺带说明：产品代码里那几个"没有快照很正常"的 catch **都写了注释**，属 B 类（可接受），
   所以 A 类反而从 95 降到 **93**。

另外我又用错了一次断言函数：`eq` 是**相等**语义，我传了布尔 → 报了个假 FAIL。
（反过来才危险：`chk` 传数组会**假通过** —— 那正是 P19 治的病。）
