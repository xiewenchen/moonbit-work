# 未接线的纯逻辑层清单（查缺补漏，2026-09-26）

## 怎么找到的

用脚本扫全仓：**一个模块的导出函数，如果只在 `test-*` / `verify-*` 里被调用过、
产品代码（含 `*-main.js` 与 renderer）从未调用**，就是"逻辑写好、也测过了，但用户点不到"。

> 注意：第一版扫描把 `x.fn(` 这种**方法调用**也排除了（正则里多了个 `.`），
> 结果报出 116 项、几乎全是误报。修正后才得到可信数字 —— **判据错的时候，
> 工具会帮你把错误盖住**。

## 结果：34 个模块 / 128 个函数

### A 类：影响用户可见路径（12 个模块）

| 模块 | 未接函数 | 说明 |
|---|---|---|
| `session-view.js` | 10 | 会话列表 / Resume / 归档 / 导出 |
| `db-context.js` | 12 | 数据库工作台上下文 |
| `memory-schema.js` | 9 | 项目记忆（规则/事实/经验） |
| `backend-profile.js` | 9 | 后端画像（状态机 / OpenAPI / 健康） |
| `agent-task.js` | 6 | Agent 任务模型与预算 —— **Gate G1 核心** |
| `ai-provider.js` | 6 | Provider（密钥脱敏等） |
| `relay-main.js` | 5 | 文件中转站（备份 / 版本） |
| `env-recovery.js` | 4 | 环境与崩溃恢复 |
| `quality-fact.js` | 4 | 工程状态事实层（含过期判定） |
| `agent-adapter.js` | 3 | 模型适配与工具循环 —— **Gate G1 核心** |
| `agent-verify.js` | 3 | 验证闭环 —— **Gate G1 核心** |
| `agent-sandbox.js` | 3 | 工具权限 / 沙箱 —— 安全门 |

### B 类：其余 22 个模块 / 45 个函数

纯逻辑与工具（`quality-result` 7、`backend-context` 6、`opencode-transport` 4、`commands` 4 …），
接不接取决于是否真需要。

## 已补的（本次）

| 项 | 结果 |
|---|---|
| `session-view.exportSession` / `replaySession` | ✅ **已接**：会话面板上「导出 Markdown」，走**白名单**取字段（不是把 session JSON 化，防止以后新增的内部字段漏出去）。验证 `verify-session-export.js` **15/0** |

## 未接的（如实登记，不假装做完）

**127 个函数仍未接线。** 其中 Gate G1 相关的三个（`agent-task` / `agent-verify` / `agent-adapter`）
与"真实模型跑一条完整路径"是同一件事 —— 需要用户提供 Provider 才能真正验收（见 `PHASE3.md` §19）。
其余按需再补，**不为了"清零数字"而接线**：接了没人用的代码比没接更糟，因为它看起来是活的。
