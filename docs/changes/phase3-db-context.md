# PH3-DB-01/02/03/04/07/08/09/10：数据库工作流（连接状态 / 表结构进 Agent / 草案必须过闸）

- 日期：2026-09-26
- 新增：`desktop/db-context.js` + `test-db-context.js`（**73/0**），已挂 CI

`sql-guard.js`（analyzeSql / withRowLimit / analyzeRedisCommand）与 `db-explorer.js` 保持不动。

## ★ PH3-DB-08 是这批的骨头：**"自己生成的"不是豁免理由**

`executeDraft` 的第一件事就是 `analyzeSql` —— 哪怕 SQL 是**我们自己**由 schema 拼出来的。
理由很实在：草案可能被传进来的任务文本影响，而模型生成的 SQL 更不可信。

测试直接打三个点：
1. `DELETE FROM users` → **REJECTED**（且 `runQuery` 一次都没被调）
2. `SELECT 1; DROP TABLE users`（多语句）→ **REJECTED**
3. 注释绕过 `-- ' OR 1=1` → 不能静默通过

## 草案生成刻意**保守**

`draftSelect` 只做一件事：挑一张**名字在任务里出现过**的表，生成
`SELECT * FROM 表 LIMIT n`。**不做**"猜 JOIN / 猜条件" ——
猜出来的 SQL 看起来很像样，但**语义可能是错的**，那比不生成更糟。
任务里没提到任何已知表名时，它**不猜**，而是把候选表名列出来让人选。

## 连接状态五态（清单四态 + UNKNOWN）

`CONNECTED` / `NO_CLIENT` / `AUTH_FAILED` / `ERROR` / **`UNKNOWN`（还没试过）**。
后两个不能混：**"没装客户端"≠"连不上"**，**"没试过"≠"试了出错"**。
混了界面就会把"没做"说成"失败"。

## 表结构缓存必须能作废

`schemaAge` / `isSchemaStale`，且**"从没取过" 与 "过期了" 分开**（`unknown` vs `stale`）。
进 Agent 的文本是**紧凑**的（表名+列名+类型），限量时**如实说明省略了多少张表**。

## 一处我自己的疏忽

`withRowLimit` 返回的是 `{ok, sql}`（不是字符串），我没先看签名就按字符串用了 ——
这正是 RULE-03 要防的那类错。修的时候顺带发现它**内部也调了 analyzeSql**，
所以不需要我再调一次。
