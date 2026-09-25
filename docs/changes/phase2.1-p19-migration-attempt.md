# P19 收尾尝试：**失败并已回滚**（如实记录）

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 结果：**迁移未完成**；错误改动**已全部回滚**；只保留了扫描器的一处改进

## 我做了什么（错在哪）

想一次把剩下的局部 `chk` 都迁到公共 harness，于是写了个批量脚本：删掉各脚本里的局部
`chk` 定义、再统一插入 `require('./verify-harness')` + `const H = createHarness()`。

**脚本只做成了前一半**：定义被删掉了，`require` 与 `H` **没有插进去**（插入所依赖的
`'use strict'` 锚点在很多文件里根本不存在）。于是 **13 个脚本全变成"`chk` 未定义"** ——
它们会在运行时报 `ReferenceError`。

## 为什么没被发现

1. **`node --check` 看不出这种错**：它只管语法，不管"变量未定义"。所以 13 个文件
   语法检查全绿。
2. **扫描器也被我骗了**：`check-local-chk` 判断的是"有没有局部 `chk` 定义"，
   定义删掉之后它就认为"已迁移"，于是报告 **25 个已迁移、基线 0** ——
   **看起来是 Gate P19 达成，实际是 13 个坏文件**。
3. 我那时**没有真跑**它们就往下走了。

**最后是靠"真跑"暴露的**：`test-relay.js` / `test-runner-detect.js` 报
`ReferenceError: chk is not defined`。

## 处置

- **全部回滚**（`git checkout -- desktop/`）。回滚后确认：纯 Node 全量 **37 个全通过**，
  `verify-problems` 14/0、`verify-multiproject` 22/0、`verify-relay` 42/0 —— 恢复原状。
- **只保留了扫描器的一处改进**（见下）。

## 唯一保留的改动

`tools/check-local-chk.js` 现在**认可"相等语义"的 `chk`**：

```js
// test-*.js 里那种 (n, got, want) => JSON.stringify(got) === JSON.stringify(want)
// 在结构上不会假通过，不该被当成"局部 chk 定义"来报 —— 报了就是误报，会让人忽略报告。
function isEqualityChk(src) { … }
```

它同时认两种写法：`const chk = (n, got, want) => …` 与 `function chk(name, got, want) { … }`。
（后者是我在 `test-url-detect.js` 上漏掉的——它本来就是相等语义，却被我报了一轮。）

## 教训（写下来免得再犯）

1. **批量替换多形态代码不可靠**：这些脚本的局部定义有 3-4 种写法（单行/多行/`function`/模板字符串），
   一个正则覆盖不了，漏掉一半就变成"删了但没补"。
2. **`node --check` 不是测试**：它能查语法，查不出未定义变量、查不出行为变化。
3. **"看起来绿了"尤其危险**：这次连**扫描器**都给出了"已迁移 25 个"的绿信号 ——
   因为它的判据是"有没有局部定义"，而定义恰好被我删了。**判据与实际语义错位**时，
   工具会帮着把错误盖住。
4. 正确做法（下次）：**一次一个文件**，改完**立刻真跑**该脚本，绿了再换下一个 ——
   这也正是清单 P19-17 原本写的要求（"禁止一次批改 16 个"）。

## 现状（如实）

- **未迁移**：14 个 `verify-*.js` + 3 个 `test-*.js`（`test-relay` / `test-runner-detect` / `test-run-e2e`）仍有局部定义；
- 已迁并**真跑验证过**的是更早几批做的那几个：`verify-run-url`(5/5)、`verify-run-dispatch`(5/5)、
  `verify-agent-request`(41/0)、`verify-agent-e2e`、`verify-write-guard`、`verify-db-ui` 等
  （它们当初都是"改一个、跑一个"做的）。
