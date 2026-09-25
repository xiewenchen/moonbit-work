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

---

## 后续：用 `edit_file` 接着做（8/10）

换回 `edit_file` 之后，剩下 5 个里有 **3 个一次就对**：

| 文件 | 真跑结果 |
|---|---|
| `verify-components-theme.js` | **19 / 0** |
| `verify-widget-size.js` | **8 / 0** |
| `verify-widgets.js` | **15 / 0** |

**另外 2 个有问题，已回滚**（不是"没做"，是"做了但不对所以退回"）：

1. **`verify-dash-v2.js`** → `ReferenceError: log is not defined`。
   它内部用了 `log(...)`，而我在迁移时给 harness 传的是默认（`console.log`），
   没把它的 `log` 一起处理 —— **说明这 5 个"同型"其实并不完全同型**，我按同一个模子套了。
2. **`verify-dash.js`** → 跑出 **10 通过 / 7 失败**。**失败原因尚未查清** ——
   可能是迁移引入的，也可能是它**本来就有 7 项不通过**（本机环境相关）。
   没有结论的东西不留在仓库里，所以先退回原状。

   （这两条值得单独查一次：尤其 `verify-dash.js` 的 7 个失败，如果本来就是红的，
   那就是又一个"长期红灯"；如果是迁移引入的，那说明机械替换对这类脚本仍然不安全。）

## 进度

```
基线 30 → 10 → 5 → 2
已改用公共 harness：32 个
仍带局部 chk：verify-dash.js ｜ verify-dash-v2.js（由门禁守着只减不增）
```

**至此 P19 的"chk 全迁移"是 14/16**（按最初那 16 个 `verify-*.js` 算），
差的正是上面这两个需要单独查的。

---

## 收尾：那两个"长期红灯"的真相

### `verify-dash.js` 的 7 个失败 —— **测试过时**，不是实现坏了

用 `git show HEAD:` 跑原版对比，**原版同样 10 通过 / 7 失败**，失败项是：
日历 0 格、今天高亮 0、待办输入框没有、便签 textarea 没有、日程区空……

查下去发现根因很直白：

```
脚本期望的 id：dashCalendar / dashTodos / dashNoteArea / dashAgenda
实际 UI 的 id：dashClock  / dashDate / dashGrid / dashAdd      ← index.html 里就这几个
```

那四个 id 在 `dash.js` 里**出现 0 次** —— **工作台 UI 早就重写了，这个脚本没跟上**。
所以它不是"实现坏了"，是**测试在测一套不存在的 UI**。

处置：给它加了 **UI 版本检查**，检测到新 UI（`dashGrid` 在、`dashCalendar` 不在）就明确报

```
[SKIP] 工作台 UI 已重写（现在是 dashClock/dashDate/dashGrid/dashAdd）
结果：0 通过 / 0 失败 / 共 0 项（SKIP：被测 UI 已变更）
SKIP_REASON=ui-rewritten
```

**为什么不直接删掉它**：脚本本身记录了"工作台该有哪些行为"，按新 UI 重写还有用；
**为什么不是让它继续报 FAIL**：`SKIP` 与 `FAIL` 是两件事 ——
"测试没跟上实现"不该伪装成"实现坏了"，也不该让人以为它验过了（这正是 P19-24 的语义）。

### 顺带又发现一处坏兜底

`verify-dash.js` 既没有 `log` 也没有 `dump`，所以它的 `.catch` **也是坏的**
（异常时会报 `dump is not defined` 而不是给出原本的 FATAL 原因）。
前面那轮"修 30 个兜底"的批量替换**没覆盖到它**（它的写法略有不同）。
这次把剩下的写法差异也统一了（又 11 个），复查"引用了不存在符号的兜底"= **0**。

> 这条值得记：**批量替换"看起来一样"的代码时，总有几种变体会漏掉** ——
> 所以每次批量之后都要用**不同的判据**复查一遍（这次是"跑起来看"才发现漏的）。

### `verify-dash-v2.js` —— **仍未解决**（如实）

它跑不通（`exit=1` 且没有结果行），修完兜底后依旧。已回滚，是门禁基线上
**唯一剩下**的那个（基线 1）。它前半段是能通过的（节假日解析、标红都对），
问题集中在**交互部分**（翻月、点选日期），报 `Cannot read properties of null
(reading 'getBoundingClientRect')` —— 需要一个独立的排查，没有结论前不留在仓库里。
