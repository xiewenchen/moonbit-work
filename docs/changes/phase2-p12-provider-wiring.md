# P12 接线：AI Provider（存储 + 面板 + 真实连通性检查）

- 任务：P12 接线段（P12-06/07/08/09 + 面板）
- 日期：2026-09-24
- 分支：`phase2-engineering-workspace`
- 状态：PASS（`verify-ai-provider.js` 23 / 0）

## 做了什么

新增 `desktop/ai-provider-main.js`（主进程接线）：

| IPC | 作用 |
|---|---|
| `aiProvider:list` | 清单，**读回来就已经是脱敏值**（`sk-****1234`） |
| `aiProvider:save` | 校验后保存（同名覆盖） |
| `aiProvider:remove` | 删除 |
| `aiProvider:test` | 真实连通性探测（注入 `simpleRequest`） |
| `aiProvider:storage` | 配置文件位置（给界面显示 + 便于验证"不在项目里"） |

渲染侧新增 `window.moonbitIDE.agentTools.provider`（list/save/remove/test/storage/openPanel）
与 **Provider 面板**（动态 DOM，不改 `index.html` 那个转译产物）：
列表 + 添加表单 + 每项"测试连接"/"删除" + 配置位置提示。

## 关键设计（P12 明确要求的三条）

1. **Key 不进项目目录**：存储位置固定为 `~/.moonbit-work/providers.json`，
   它是**用户目录**里的文件，所以 `git status` 永远看不到 Key，且项目之间共享同一份配置。
2. **完整的 Key 不出主进程**：`list` / `save` / `remove` 的返回值全部经 `listForUi()` 脱敏；
   面板上显示的也是脱敏值（输入框用 `type=password`）。验证里有一条断言是
   **"清单里不含完整 Key"**（拿真实 Key 去 `includes` 检查）。
3. **配置文件损坏不静默吞**：JSON 解析失败时把它备份成 `providers.json.broken-<时间戳>`，
   再当空处理 —— 不覆盖用户的配置。

## 顺手修的一个真缺陷

`ai-provider.js` 的 `testConnection` 原来是：

```js
error: ok ? null : String(maskKey(String(r.error || r.body || '连接失败')))
```

`maskKey` 是对**整串**做"前 3 位 + 后 4 位"处理 —— 用在错误信息上会把可读的错误**毁掉**
（`connect ECONNREFUSED 127.0.0.1:1` 变成 `****.0.0.1:1`）。改为 `redactText`
（**串内**把 `sk-…` / `Bearer …` 替换成 `****`），既保住可读性又保证不漏 Key。

## 验证：23 / 0（`npm run verify:ai-provider`）

六组：

1. **存储位置**：在 `~/.moonbit-work/`、**不在项目目录**（用路径前缀断言）。
2. **保存 + 读回来脱敏**：`item.apiKey === 'sk-****1234'`、清单整体不含完整 Key、
   `hasKey === true`；同时确认**磁盘上存的是原文**（本地配置要能用）。
3. **校验**：openai 类型缺 Key → 拒；`baseUrl: 'ftp://x'` → 拒。
4. **真实探测**（不假装成功）：
   - `http://127.0.0.1:1/v1`（必然没人听）→ `ok:false` + 结构化字段；
   - Ollama 默认端点 → 返回结构化结果（本机没装 → 失败也算正常结果，断言**只要求结构完整**）；
   - 探测失败的 `error` 里**不含 Key**。
5. **面板**：真打开、真渲染、列出了 provider、**显示的是脱敏值**、提示了配置位置、关闭后消失。
6. **删除**：删除成功、清单里消失、删不存在的明确失败。

## 没做的（诚实边界）

- **激活/切换 provider 未做**：需要把选中的 provider 写进 `agent.js` 使用的配置
  （opencode 的 jsonc 格式），这一步会触碰 Agent 的配置写入路径，留给 P12 的下一段。
- 面板**没有编辑已有项**（只能删除后重加）。
- Provider 是"能用的库 + 能用的面板"，但**还没驱动 `agent.js`** —— 也就是说
  现在配了 provider，AI Agent 标签页**还不会用它**。这是 P12 剩余部分。

## 剩余风险

- 存储文件是明文（本地配置必须能用）。若以后要加密，需要额外的密钥管理，
  不在本阶段范围。
- `testConnection` 会真实发起网络请求；在没有网络的环境下会走到超时分支（结构化失败，不抛）。
