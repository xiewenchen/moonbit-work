# 技术债

## moon.pkg 的 warnings = "-79"（10 处）
- **现状**：临时收窄，压住 Windows/Linux 平台差异警告
- **风险**：新版 moon 会强制改；升级工具链时必须处理
- **处理时机**：下次 moon 升级前

## CI 的 Check 不 --deny-warn
- **现状**：宽松模式，warning 不阻塞合并
- **风险**：0079 那类"警告藏真问题"的情况会被放过
- **处理时机**：等 -79 收窄清理后再开

## 空 catch 基线（95 处 A 类）
- **现状**：冻结存量，禁止新增
- **风险**：基线里的 95 处可能有"该报错却静默"的
- **处理时机**：不定期抽查，优先处理"影响用户判断"的那类

## AI Agent 布局：保持独立第 5 标签（已决策，勿再当悬案）
- **决策**：AI Agent 继续做左侧独立标签，**不**改成「项目」标签的右侧面板
- **理由**：
  1. 申报书已提交，写的正是 5 标签结构；改实现会让材料与实现对不上
  2. UI 改动只能在本地 Electron 手点验证（CI 不跑桌面壳），而本地 `~/.moon` 已坏
     —— 风险恰好全压在「只能手点」的地方
  3. 成本≈0
- **若将来真要改成右侧面板**（成本清单，别漏）：
  - `desktop/translate-strapi.js`：`TABS` 数组 + `MAINVIEWS` 结构 + CSS（`.ag` 从整屏改侧栏）
  - `desktop/renderer.js:16`：`VIEW_ORDER`
  - 3 个验证脚本：`verify-agent-ui.js`（断言「导航 5 项 + `data-view="ai"`」）、
    `verify-agent-config.js`（点 `a[data-view="ai"]`）、`verify-demo.js:24`
  - `docs/DEMO.md:30`：5 个标签表格
  - 必须重新生成转译产物 `desktop/index.html`
  - **已知坑**：`mainview-project` 里的 `#welcomeScreen` 会被浏览器解析时挤到「内容区
    容器」外层（见 `translate-strapi.js` 内注释），把面板塞进 project 时得靠
    `div:has(> #welcomeScreen)` 之类定位真正的父容器，别指望 `mainview-project`
