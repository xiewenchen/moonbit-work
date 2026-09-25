# P10：Session —— 会话与项目绑定

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P10-01～11 全部 DONE**；`test-session` **68/0**、`verify-session` **25/0**

## 起点：一个真实存在的跨项目污染

改之前，渲染侧只存了**一个全局字符串**：

```js
localStorage.getItem('moonbit-agent-session')   // 没有和项目绑定
```

于是换项目之后会**继续复用同一个会话** —— A 项目的上下文就漏给了 B。这正是清单 P10-11 要防的。
（这不是我猜的：`aiagent.js` 里原来就这几个 `currentSession` 的读写点。）

## 做了什么

| 任务 | 做法 |
|---|---|
| P10-01 | `session.js` 生成会话 id（`sess-<base36>-<seq>`；可注入 idFactory 便于测试） |
| P10-02 | 绑定 ProjectContext：记 `projectRoot` / `projectType`；**没打开项目也能建**（`projectRoot=null`，不与任何项目匹配） |
| P10-03～07 | 四类记录：消息 / 工具调用 / 工具结果 / 补丁 / 验证。**不可变**（每个 add 返回新对象）、有上限（200/200/100/50）、单条正文裁剪 |
| P10-08 | `session-store.js`：**按项目分文件**存 `~/.moonbit-work/sessions/<根派生名>.json`，原子写；`load` 会校验文件里的 `projectRoot` 与请求一致 |
| P10-09 | `findOrCreateForProject`：同项目复用、异项目新建；渲染侧**每次发送都按当前项目重读**会话 id |
| P10-10 | `endSession`：结束后状态为 `ended`，不再接受新记录；`resume` 时已结束的会话**不复活**（会新建） |
| P10-11 | 跨项目隔离 —— 三层都验（见下） |

**存哪里**：用户目录，**不进项目**。理由和 P12 的 Provider Key 一样：会话含对话内容与文件片段，
放项目里就会出现在 `git status` 里、可能被误提交。

**一个概念区分**：`session.id` 是**我们自己的**会话标识（用来绑定项目与归档）；
`opencodeSessionId` 是 **opencode 那边**的会话 id（用于 `--session` 续接）。两者不是一回事，
`setOpencodeSessionId` 单独记它。

## P10-11：跨项目隔离在三层分别验证

| 层 | 验的是什么 |
|---|---|
| 模型层 | `isSameProject`（根相同即同项目，类型变化不算换项目）；`listForProject` 只返回本项目的；`findOrCreateForProject` 切项目时**新建**而不是复用 |
| 存储层 | 一个项目一个文件；`load('别的根')` → `null`（它只读自己那个文件）；文件里 `projectRoot` 不匹配也返回 null（防文件名碰撞） |
| 渲染侧 | `sessionKey()` **真调**（`window.moonbitAgentSessionKey` 是只读调试口），断言"当前项目的键含项目根"、"切到 B 键也跟着变"、"旧全局键从未被写入" |

端到端用的是**两个真实项目**来回切：`moonbit-platform` ↔ `testdata/agent-e2e-project`。

## review 抓到的问题（都修了）

1. **我本批引入的功能回归**：`newChat()` 删的还是**旧全局键**，而 `send()` 每次按项目重读新键
   → **"新对话"实际上无效**（旧 id 会被读回来）。已改成 `removeItem(sessionKey())`。
2. **恒真断言**：`test-session` 里写了 `s.messages.every(() => true)`（等于没验）→ 改成对各类记录检查 `typeof x.at === 'number'`。
3. **自证式验证**：`verify-session` 原来在脚本里自己拼 `'moonbit-agent-session:'+A` 再读回，
   **根本没调用被改的 `sessionKey()`**。已改为真调（并给 `aiagent.js` 加了一个只读调试口）。
4. **store 层零覆盖**：`load/save/clear/resumeOrCreate` 之前没有任何测试（verify 走的是内存缓存）。
   已补 13 条：真写盘、真读回、换根读不到、clear、损坏文件当没有、未绑定项目的会话拒绝落盘。
5. nits：`legacy === null || 'oc-A' || 'oc-B'` 近乎恒真 → 直接断言 `=== null`；
   `restored` 的文案从"从磁盘恢复"改成"命中已有会话（内存缓存或磁盘）"（原来名不副实）。

## 诚实边界

- **多窗口**下 `session-main` 的 `sessions` Map 缓存可能 stale（resume 命中缓存时不重读磁盘）。
  当前是单窗口，可接受；记录在此。
- 会话文件**没有轮转/清理策略**（按项目分文件所以不会无限长，但删项目后文件仍在用户目录）。
- 会话内容**明文存盘**（本地会话，与 Provider Key 同样的取舍）。

## 验证

| 项 | 结果 |
|---|---|
| `node test-session.js` | **68 / 0**（含 store 层 13 条真覆盖、⑦ 跨项目污染 7 条） |
| `npx electron verify-session.js` | **25 / 0**（两个真实项目来回切） |
| 纯 Node 全量 | **30 个脚本全通过** |
| 门禁 | 空 catch 94 ≤ 95；local-chk 通过 |
| CI | 新增 `node test-session.js`（11 steps） |
| 探针清理 | 跑完 `~/.moonbit-work/sessions/` 里无残留 |
