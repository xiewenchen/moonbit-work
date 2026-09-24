# P12 接完：激活 Provider → 真正写进 opencode 配置

- 任务：P12 剩余段（激活/切换 + 驱动 agent.js）
- 日期：2026-09-24
- 状态：PASS（`verify-ai-provider.js` 38 / 0）

## 补的是哪一段

P12 上一段做完后，Provider 是"能用的库 + 能用的面板"，但**配了也没用** ——
AI Agent 跑的是 `opencode run`，它读的是 `~/.config/opencode/opencode.jsonc`，
而 P12 的 Provider 存在 `~/.moonbit-work/providers.json`。**两份配置互不相通**。

这一段把桥搭上：**激活** = 把 P12 的 Provider 翻译成 opencode 的配置片段并**合并**写回。

## 格式从哪来（不自己发明）

以既有「配置模型」弹窗（`aiagent.js`）为**唯一权威**，两边必须一致：

```jsonc
{
  "provider": {
    "<id>": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "…", "apiKey": "…" },
      "models": { "<model>": {} }
    }
  },
  "model": "<id>/<model>"
}
```

- **`id` 由 provider 名派生**（`pidOf`：只留小写字母/数字/`_`/`-`，空则 `custom`）——
  中文名会被整段替换掉，必须兜底，否则会写出一个坏配置键。
- **合并而非覆盖**：`provider` 里已有的其它条目、以及其它顶层字段（`$schema` 等）全部保留。

## 复用而不是抄一份

`agent.js` 原本只导出 `CFG_FILE`，读写函数是私有的。这一段把它俩也导出：

```js
module.exports = { registerAgentIpc, findOpencode, CFG_FILE, configPath, readConfig, writeConfig }
```

`ai-provider-main.js` 直接 require 复用。**理由**：如果面板和弹窗各写一份读写逻辑，
迟早格式漂移 —— 那正是这次要消灭的问题。

新增 IPC：`aiProvider:activate`（激活，返回 `{id, model, file}`）与 `aiProvider:active`（查当前生效）。
面板每行多了「激活」按钮，顶部显示「当前生效：`<id>/<model>`」。

## 验证（38 / 0），关键几条

| 断言 | 为什么关键 |
|---|---|
| `apiKey` 真的写进去了 | 不写进去就**驱动不了**（等于没接） |
| **原有 provider 一个都没丢** | 合并语义 —— 覆盖掉用户的 `deepseek` 就是事故 |
| 原有顶层字段（`$schema`）保留 | 同上，只加不改 |
| `model` = `<id>/<model>` | opencode 靠这一行决定用谁 |
| `ollama` 类型（不需要 key）也能激活 | 校验分支不能一刀切 |
| 激活不存在的 → 拒 | 失败要明确 |
| 面板有「激活」按钮 + 显示「当前生效」 | UI 真的接上了 |

### 测试会写用户的真实配置 —— 所以做了还原

第 ⑦ 组要写 `~/.config/opencode/opencode.jsonc`（**用户真实在用的、含真 Key 的配置**）。
处理方式：

1. 进测试前备份整个文件；
2. `dump()` 里**无条件** `restoreCfg()` —— 正常结束、断言失败、脚本抛异常，**任何退出路径都还原**；
3. 原本不存在的文件就删掉，不留下空壳。

实测结果：跑完后配置仍是 362 字节、`provider` 只有 `deepseek`、`model` 仍是
`deepseek/deepseek-chat`、`$schema` 在 —— **原样还原**。

## 诚实边界

- **"真跑一次模型"没验**：端到端要真 Key / 真额度（而且要能连上），这一段验证到
  **"写进 opencode 配置的内容是正确的"** 为止。也就是说：配置这条路通了，
  但"Agent 真的用这个模型回答了一句话"**没有**被验证过。
- **切换语义**：现在是"激活谁就把 `model` 指向谁"，旧 provider 条目**保留**在配置里
  （不删除）。没有"取消激活"。
- **`writeConfig` 会丢掉 `.jsonc` 里的 `//` 注释**（它写纯 JSON）。
  文件扩展名仍是 `.jsonc`，opencode 照常读（JSON 超集），但用户写的注释会消失。
  这是既有行为，本次未改 —— 记在这里免得忘。
- 面板仍**不能编辑已有项**（只能删除后重加）。
