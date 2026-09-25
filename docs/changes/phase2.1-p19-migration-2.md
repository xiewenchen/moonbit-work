# P19 逐个迁移（进行到 5/10）：两次踩同一个坑

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 基线：10 → **5**（已迁 29 个）

## 做对的部分（5 个，每个都真跑过）

按清单 P19-17 的节奏来：**一次一个文件 → `node --check` → 立刻真跑 → 绿了再下一个**。

| # | 文件 | 真跑结果 |
|---|---|---|
| 1 | `test-runner-detect.js` | **25 / 0** |
| 2 | `test-relay.js` | **25 / 0** |
| 3 | `test-run-e2e.js` | **51 / 0**（顺带把自维护的 `failures` 换成 `H.failures`） |
| 4 | `verify-theme.js` | **20 / 0**（退出码藏在 `setTimeout` 里，一并修了） |
| 5 | `verify-relay.js` | **42 / 0** |

这 5 个都是**用 `edit_file` 精确替换**做的（能看清原文，不会"删多了"）。

## 做错的部分（第 6-10 个，已回滚）

剩下 5 个是同型的，我想"它们完全一样，用 python 批量替换省事"。结果：

```
console.log('          ← 换行断了，语法直接坏
```

**又是 `\n` 转义**：我写在 python 字符串里的 `\n` 最终变成了**真换行**，
于是 `console.log('\n' + H.summary())` 被写成 `console.log('` + 换行 + `' + H.summary())`。
5 个文件语法全坏，**已 `git checkout` 回滚**。

### 这是第四次了

前三次分别是：30 个文件（`.` 里的 `\n`）、2 个文件（正则多括号）、
`test-agent-request.js`（顶层 `await` 那次顺带）。

**而且我的记忆里就有一条"改 JS 源码禁用 python 替换（必须用 write_file / edit_file）"** ——
我没守住。原因很直接：**图省事**。这次的代价是 5 个文件的改动全部作废。

### 对照：用 `edit_file` 的 5 个一次就对

同样是"精确字符串替换"，`edit_file` 把内容当**内容**（不经过 shell → python → 文件的
三层转义），而 python 拼字符串要同时穿过 heredoc、python 字面量、目标语言三层。
**结论：改 JS 源码只用 `edit_file` / `write_file`，不用 python 拼。**

## 现状（如实）

- **已迁并验证**：29 个（含上面 5 个）；
- **未迁**：5 个 `verify-*.js`（`components-theme` / `dash-v2` / `dash` / `widget-size` / `widgets`），
  它们仍然带局部 `chk`，由门禁的基线守着（只减不增）；
- 这 5 个本身**没被改坏**（回滚后 `node --check` 全 OK、基线回到 5）。
