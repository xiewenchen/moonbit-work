# 验证基础设施修复：让"通过"重新可信

- 任务：P19 测试体系（前置清理）—— 在给 P12 写验证时**顺手审计了既有的验证脚本**
- 日期：2026-09-24
- 分支：`phase2-engineering-workspace`
- 状态：PASS（相关脚本全部重跑通过）

## 现象：25 处断言"永远通过"

审计时发现 7 个 Electron 验证脚本里有 25 处这种写法：

```js
chk('返回了存储路径', [st.ok, typeof st.file], [true, 'string'])
```

`chk` 是**布尔**语义（`if (ok)`），而**数组恒为真** —— 所以这些断言不管实际是什么，
**一律打印 `[PASS]`**。等于没验。

**影响面**：我以前报告的 `verify-agent-patch 28/0`、`verify-agent-tools 25/0`、
`verify-problems 14/0` 等，其中**这些条目从未真正验证过任何东西**。

> 这条也要记在"自己的结论也要被验证"下面：**测试脚本本身没被测试过**。

## 修复

1. **`chk` 只接受布尔**，并且**误用立刻判失败并提示**（防复发，这是关键）：
   ```js
   const chk = (n, ok, detail) => {
     if (typeof ok !== 'boolean') { fail++; log('  [FAIL] ' + n + '   ⚠️ chk 只接受布尔（数组/对象比较请用 eq）：' + JSON.stringify(ok)); return }
     if (ok) { pass++; ... } else { fail++; ... }
   }
   ```
2. **新增 `eq`**：JSON 相等比较 —— 数组/对象想比较就必须显式用它。
3. **37 处数组式断言 → `eq`**（脚本自动改，逐文件核对）。
4. **4 处"期望 false"写成显式取反**（`chk('x', expr, false)` 在布尔语义下等于"期望 true"，
   是另一种假通过）。
5. **30 个 `verify-*.js` 补 `.catch` 兜底** —— 这一条修的是另一个假绿：
   `verify-agent-tools.js` 曾在 `d.data.entries` 上抛异常**提前退出**，
   **结果行都没打印，但 `exit=0`**。现在抛异常会 `dump(1)`。
6. 防误用机制一上线就**当场抓出 29 处**同类误用（把"值 + 期望值"传给了 `chk`），
   逐个改成 `eq` 后归零。

## 顺带发现的**真**问题（非断言形式）

### ① `.git` 用例其实没测到"危险目标"
`verify-agent-patch.js` 用 `.git/config` 测危险表，但夹具里**没有 `.git` 目录** →
`realpath` 解析失败 → 先被判成 `outside-workspace`，**危险判定根本没跑到**。
修：夹具里真的建一个 `.git/config`。

### ② `search` 用例传了**文件**而不是**目录**
`agent-tools.js` 的 `search` 把 `path` 当**搜索根目录**（`searchInDir(root, …)`），
用例传的是 `runners.js`（文件）→ 永远搜不到 → 现在改传 `.`。

### ③ 我自己的一次**误判**（违反 RULE-03，已回滚）
看到 `agent-tools.js` 用 `g.abs`，我判它是"用了 `resolveInsideWorkspace` 不存在的键"，
改成 `g.path` —— **改错了**：
- `resolveInsideWorkspace` 返回的键是 **`path`**；
- 但 `agent-tools.js` 里的 `g` 来自 **`guardPath`**，它**把 `path` 翻译成了 `abs`**。

两个函数、两个键名，我**没看实现就下手**（正是 RULE-03 禁的）。
后果：`readFile`/`listDir` 被改坏（`verify-agent-tools` 从 25/0 掉到 24/1）。
**已回滚**并加注释说明"这里的 `abs` 是对的"。

## 一个操作事故（记录用）

用 python 批量改 30 个脚本时，把 `\n` 写成了**普通字符串里的换行**，
结果 30 个文件被写坏（`log('` 后面直接断行）。
**被全量 `node --check` 立刻发现**（30 个文件同时报语法错），5 分钟内修复。
教训：**用脚本改源码时，转义必须用 raw 字符串或 `\\n`**。

## 验证（全部重跑）

| 脚本 | 结果 |
|---|---|
| `verify-agent-config.js` | 9 / 0 |
| `verify-problems.js` | 14 / 0 |
| `verify-agent-tools.js` | **25 / 0**（修前 24/1） |
| `verify-multiproject.js` | 22 / 0 |
| `verify-agent-patch.js` | 28 / 0 |
| `verify-agent-verify.js` | 17 / 0 |
| `verify-ai-provider.js` | 23 / 0 |
| `verify-run-url.js` | **5 / 5** |
| `verify-run-dispatch.js` | **5 / 5** |
| `verify-welcome.js` | 全 ✅ |
| `npm run verify:demo` | 7 步通过 / 0 失败 |

> 后 4 项是**回归**：它们也在被我批改的 30 个文件里，必须证明没被改坏。

## 剩余风险

- `verify-demo.js` / `verify-url-regex.js` **不是** `app.whenReady()` 结构，
  没加 `.catch`（`verify-agent-ui.js` 本来就有）。待下次触碰时统一。
- 断言形式现在有两种（`chk` 布尔 / `eq` 相等），**靠命名区分**；
  已在两处都写了注释说明，但仍是"靠人守规矩"。若以后还出问题，
  可以考虑把两者合并成"参数类型自动判定"（但这正是当初出错的根源，暂不做）。
