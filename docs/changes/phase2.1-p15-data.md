# P15 数据层：把数据库工作台接上（构造 + 执行）

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P15-01～06 的数据层与执行层 DONE**；**面板未做**（如实标注）
- `test-db-explorer` **58/0**、`verify-db-explorer` **14/0**

## 分两层，因为"拼 SQL"和"连数据库"是两件事

| 层 | 文件 | 性质 |
|---|---|---|
| 构造层 | `db-explorer.js` | **纯逻辑**：把"想看的"翻成 SQL / Redis 命令。可穷举测试，能进 CI |
| 执行层 | `db-explorer-main.js` | **环境相关**：用注入的 `runCommand` 去调 `psql` / `redis-cli` |

拆开的好处很实际：界面能随口说"给我看看 users 表第 3 页"，而**这句话变成什么 SQL
是可测的**——不用先连上数据库才能验证。

## 拼 SQL 就一定会遇到注入，所以每一处外部输入都处理了

| 输入 | 处理 |
|---|---|
| 表名 / 列名 / schema | **只允许标识符**（`^[A-Za-z_][A-Za-z0-9_]*$`），否则**直接抛**；再用双引号包住 |
| 搜索词等字面量 | `escapeLiteral`：单引号双写 + 拒绝 NUL |
| 搜索里的 `%` `_` | **转义掉**（否则用户输入的 `%` 变成通配——那不是"搜索"该有的语义），并声明 `ESCAPE` |
| 生成结果 | **再过一遍安全闸**（构造层错了也会在 `verify()` 被拦下） |

对应的攻击用例都在测试里：`users; DROP TABLE x`、`a' OR 1=1 --`、`100%`、`a_b`、
`x'; DROP TABLE users; --`。

**这条挖出一个真 bug**：`verify()` 一开始返回的是 `analyzeSql` 的 `normalized`（**骨架化文本**：
标识符变 `<id>`、字面量变 `<str>`）—— 那 SQL 拿去执行**根本跑不了**。测试当场抓出来了。

## Redis 侧

- **用 `SCAN` 不用 `KEYS`**：`KEYS *` 在大库上会阻塞 Redis（生产事故常见原因）；
- 读值**先 `TYPE`**，再按类型选只读命令（hash→HGETALL、list→LRANGE 0 99、zset→ZRANGE WITHSCORES…）
  —— 不知道类型就 `GET` 会直接报错；`list`/`zset` 也带范围，不会把大 key 整个拉出来；
- 每个命令都过 Redis 白名单（只读）。

## 一个 Windows 上的坑（修了）

"客户端没装上"最初只判 `code === -1` —— 但 **Windows 上 cmd 找不到命令返回的是 `code 1`**，
而且**不同客户端的码值还不一样**（psql 与 redis-cli 就不同），错误文案还是**本地化/乱码**的。
结果"没装 psql"被误报成"数据库返回错误" —— 语义完全错了。

改成：先看几种已知文案，再兜底判据（**非零退出 + 输出很短 + 完全不像数据库自己的错误**
——数据库错误通常带 `ERROR`/`FATAL`/`DETAIL`）。判据导出为 `looksLikeMissingClient`。

**为什么这件事重要**：面板上"连不上客户端"和"这张表没有数据"必须分得开，
否则用户会以为表是空的。所以这里返回的是 `NO_CLIENT` 而不是空 `rows`。

## 未做

- **数据库面板（动态 DOM）**：没做。数据层与 6 个 IPC 都已就绪，面板接上即可。

## 验证

| 项 | 结果 |
|---|---|
| `node test-db-explorer.js` | **58 / 0**（含 6 类注入尝试） |
| `npx electron verify-db-explorer.js` | **14 / 0**（安全闸在 IPC 层生效 + 如实报没客户端） |
| 纯 Node 全量 | **35 个脚本全通过** |
| 门禁 | 空 catch 93 ≤ 95；local-chk 通过 |
| CI | 新增 `node test-db-explorer.js`（11 steps） |
