# P17 收尾：spawn-util 的参数拼接面

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**DONE**；`test-spawn-util` **27/0**；审计 MEDIUM **4 → 0**

## 先分析，别搞反了

`spawn-util.js` 有一处 `shell: true`（那 4 条 MEDIUM 都指向它）。但直接"把 shell 去掉"是错的 ——
那段注释写得很清楚：Windows 上 `npm` / `opencode.cmd` **必须**交给 shell，否则 `spawn EINVAL` /
`ENOENT`（实测踩过，表现是"IDE 里跑不起任何 npm 项目"）。

所以真正该看的是**拼命令行那一步**：

```js
const cmdline = [quoteForCmd(s), ...list.map(quoteForCmd)].join(' ')
```

分析下来三条结论：

1. **`%VAR%` 在命令行里其实不展开**（只有 `.bat` 里才展开）—— 所以现有实现**没爆**。
   但它的判据里没有 `%` `!`，**万一将来改成走 .bat 就会出事**。
2. **`^` 是 cmd 的转义符，但引号里不生效** —— 原判据已经包含它，包起来就安全。
3. **换行 / 回车才是真要挡的**：裸传时它在 cmd 里就是**命令分隔符**。

## 改了什么

- `quoteForCmd`：把 `%` `!` 一并纳入"需要加引号"的条件（命令行下无副作用，走 .bat 时就是救命的）；
- **控制字符（`\n` / `\r` / NUL）直接拒** —— 在 `quoteForCmd` 与 `resolveSpawn` 入口各挡一次，
  而不是"包个引号试试"。合法参数不可能含控制字符，所以拒绝是安全的。
- 判据与理由都写在注释里，免得下次有人看到 `%` 觉得多余又删掉。

## 验证（27 项）

包括"该加引号的加、不该加的不加"（加多了会把命令跑不起来）：
`hello` 不加、`C:\work\a` 不加、含空格/`&`/`|`/`^`/`%`/`!` 都加、`"` 双写；
以及`resolveSpawn` 在 Windows 上的四种分支（`npm` 走 shell、`.cmd` 走 shell、**`.exe` 不走**、带空格的参数被引起来）。

**回归**（改的是启动子进程的核心）：`verify-run-url` **5/5**、`verify-run-dispatch` **5/5**、
`verify-run-e2e` 通过（纯 Node）、纯 Node 全量 **36 个**全通过。

## 验证结果

| 项 | 结果 |
|---|---|
| `node test-spawn-util.js` | **27 / 0** |
| `verify-run-url` / `verify-run-dispatch` | 5/5 · 5/5 |
| `node tools/audit-desktop-security.js --ci` | 高危 **0**、中危 **0**、✓ 没有新增 |
| 纯 Node 全量 | 36 个脚本全通过 |
| 门禁 | 空 catch 93 ≤ 95 |
