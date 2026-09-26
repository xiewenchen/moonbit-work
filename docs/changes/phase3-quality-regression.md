# PH3-Q-10/11：退化检测接进 Quality

- 日期：2026-09-26
- 改动：`quality-main.js`（新增 `compareWithLast` / 基线读写）、`renderer.js`（面板显示 + `saveBaseline`）
- 新增：`test-quality-regression.js`（**29/0**），已挂 CI
- 端到端：`verify-quality-ui` 43 → **49/0**

## 两个设计约束（想清楚才写的）

**① 默认不推进基线。**
如果每次 `snapshotQuality` 都比完就把当前存成新基线，那么"发现退化"这个结论
下次就复现不了（已经被覆盖了）。所以推进由调用方**显式**要求：`{ save: true }`
（界面上的入口是 `saveBaseline()`）。测试专门验证了"不显式 save 时，连比两次结论一样"。

**② 只存"可比的最小集合"。**
落盘的是 `{ name, state, passed, failed }`，**不是整个快照** ——
存整份会把 `detail` 全文写进用户目录，既大又可能含源码片段。测试断言
落盘里**没有** `detail` 文本、**没有** 文件路径，体积 < 300 字节。

## 第一次跑时不能说"无退化"

没有基线时 `first: true`，面板显示"**还没有上次记录**"，
而不是显示"无退化" —— 那两句含义完全不同：一个是"**比过了没事**"，一个是"**还没法比**"。
（与 Quality 一贯的 `NOT_RUN` ≠ `FAIL` 是同一条原则。）

## 面板

`#qualityRegression` 一行三态：
- 有基线且退化 → `⚠️ 发现退化：…`（橙）
- 有基线且没退化 → 绿色
- 没基线 → 灰色 + 提示可用 `saveBaseline` 建基线

## 一处真 bug（验证抓到的）

`compareWithLast` 里用了 `compareQuality`，但**忘了 import** ——
`test-quality-regression` 第一次跑就 `ReferenceError`。
（另：同一处我第三次把 `eq` 与 `chk` 的参数用反了，`eq` 是相等语义。）

## 不污染真实数据

测试用**临时 userDir**（`mkdtempSync`）并清理，验证了跑完 `~/.moonbit-work/` 里
**没有**多出 `quality-last.json`。
