# P15：数据库工作台（安全闸部分）

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P15-07 + P15-08 DONE**；**P15-01～06（PG/Redis 只读数据层与面板）未做**（如实标注）
- `test-sql-guard` **67/0**、`verify-agent-tools` **41/0**

## 为什么先做安全闸

清单对 P15 的要求里，最要紧的一条是 P15-08：

> 危险 SQL 默认拒绝：默认只放 `SELECT`，默认拒绝 `DROP` / `DELETE` / `UPDATE` / `INSERT` / `ALTER`。

**"过滤关键词"是不够的** —— 真会出事的是下面这些，所以这一批把它们逐个封住：

| 手法 | 例子 | 现在 |
|---|---|---|
| 多语句 | `SELECT 1; DROP TABLE users` | 拒（`MULTI_STATEMENT`） |
| 注释绕过 | `SELECT 1 -- 换行后 DROP ...` | 拒（去注释后仍能看出写操作） |
| 块注释藏 / 未闭合 | `SELECT 1 /* ...` | 拒（`UNCLOSED_COMMENT`，防"注释掉检查"） |
| 字符串里的分号 | `SELECT 'a; b'` | **放行**（那是数据，不是分隔符） |
| CTE 里藏写 | `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` | 拒（`FORBIDDEN_KEYWORD`） |
| 挂着"读"名字的函数 | `pg_read_file` / `pg_ls_dir` / `pg_sleep` / `pg_terminate_backend` | 拒（`FORBIDDEN_FUNCTION`） |
| 名字里带保留字的正常查询 | `... OFFSET 10`、`LIKE '%set%'` | **放行**（词边界判定，不误伤） |

做法是**白名单**：只允许"单个以 `SELECT`（或 `WITH ... SELECT`）开头的语句"，
再把多语句 / 注释 / 写操作 / 危险函数依次挡掉。另有：
- 长度上限（防超长 SQL 拖垮解析）；
- 可选的表白名单（`allowedTables`）；
- **`withRowLimit`**：没写 `LIMIT` 就自动补一个默认上限 —— 免得一次拉全表。

**Redis 同理**（P15-05/06 的前置）：`analyzeRedisCommand` 只放只读命令（GET/MGET/KEYS/SCAN/
HGETALL/LRANGE/TTL/INFO…），`FLUSHALL` / `FLUSHDB` / `CONFIG SET` / `EVAL` / `SCRIPT` / `MODULE` /
`SET` / `DEL` / `SHUTDOWN` 一律拒。

## P15-07：Agent 侧

新增**只读**工具 `queryDatabase`（第 10 个只读工具）。它有两道关：

1. **先过 `analyzeSql`** —— 拒绝就不起查询（错误信息带原因码）；
2. 真正的执行能力由**外部注入** —— 本模块不自己连数据库。

这样"能不能查"（纯逻辑，可测）与"怎么连"（环境相关）分开了。端到端断言了
"多语句被拒 / 写操作被拒 / 非 SELECT 开头被拒"，以及"合法 SELECT 能过闸
（失败也只失败在'能力未注入'，不是被误拦）"。

## 未做（P15-01～06）

- **PG 侧**：表列表、列信息、分页读取、搜索 —— 没做；
- **Redis 侧**：Keys / Value 的读取数据层 —— 没做（安全闸有了，但没接真实读取）；
- **面板**：数据库工作台 UI —— 没做。

诚实说明：这几项是**没做**，不是"做完了没提"。它们都依赖"真的连上 PG/Redis"，
属于接环境的那一层；安全闸是它的前置，所以先做了这里。

## 验证

| 项 | 结果 |
|---|---|
| `node test-sql-guard.js` | **67 / 0** |
| `npx electron verify-agent-tools.js` | **41 / 0** |
| 纯 Node 全量 | **34 个脚本全通过** |
| 门禁 | 空 catch 93 ≤ 95；local-chk 通过 |
| CI | 新增 `node test-sql-guard.js`（11 steps） |
