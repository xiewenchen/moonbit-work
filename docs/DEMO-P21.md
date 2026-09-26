# P21 产品级演示（真实项目 conduit，17 步）

- 脚本：`desktop/verify-demo-full.js`
- 运行：`cd desktop && npx electron verify-demo-full.js`
- 最近一次：**28/0**（真的跑了 **12 步**，**5 步如实标成因环境没跑**）

## 用什么项目演

清单 P21-01 要求"真实 MoonBit 项目，包含 HTTP / PG / Redis / 测试 / 一个故意错误"。
项目里的 **`conduit/`** 正好就是这个：`app.mbt` / `articles.mbt` / `auth.mbt` /
`comments.mbt` / `users.mbt` / `profiles.mbt` / `tags.mbt`，用 http + pg + redis，
自带 4 个测试文件（`auth_test` / `conduit_test` / `cors_test` / `slugs_test`），
还有 `openapi.yml` 与 hurl 套件。

故意错误注入在 `conduit/slugs.mbt`：把 `c.to_string()` 改成 **`c.to_stringX()`**。

## 演示了什么（12 步真的跑了）

| 步 | 内容 | 关键证据 |
|---|---|---|
| 1 | 注入故意错误 | 靶文件里精确替换一行 |
| 2 | IDE 打开项目 | `openProject(conduit)` |
| 3 | 报错进统一问题模型 | 用**真实 `moon check` 输出**当 message（不是编的） |
| 4 | Agent 查看（Context） | 相关文件 / 相关问题**非空** |
| 5 | Agent Explain | 给出计划，每条带 `rule` |
| 6 | Agent Read | 真调只读工具 `readFile` |
| 7 | Agent Patch（生成） | 拿一次性 token + 预览 |
| 8 | Preview | 人可读的改动预览 |
| 9 | Apply | **用户确认后**才落盘，且留了备份 |
| 10 | Check | 真跑 `moon check`，**由失败恢复为 0** |
| 16 | Quality | 聚合工程状态 |
| 17 | Agent 总结 → 便签 | **追加**到项目便签，不覆盖原有 |

第 10 步是整场演示的**硬证据**：注入后 check 失败 → 修好后恢复 0。

## 哪 5 步没跑（如实，不是"跳过不提"）

| 步 | 为什么 |
|---|---|
| 11 Test | **本机 R12**：`moon test` 零输出（退出码异常） |
| 12 Run | 失败即停 → 没跑到 run（同样 R12） |
| 13 Browser | 需要项目真跑起来并给出 URL；R12 让 serve 无法构建 |
| 14 API 调试 | 后端未运行（需 docker + PG/Redis）—— 且**如实报"连不上"**，不假装有数据 |
| 15 Database | 未装 psql 客户端 —— 且**如实报"未找到客户端"**，不说成"表是空的" |

脚本最后会打印"真的跑了 N 步 / 因环境没跑 M 步及原因"——
**不做"看起来全绿"的演示**。

## 这次排查抓到的两个"看起来全绿其实没检查"

写这个演示时栽了两跤，都是**同一类**问题（工具给了"没事"的信号，但其实没看）：

### 1. `moon check` 不带 `--target native` → 压根没检查 conduit

`moon.mod` 里 `preferred_target = "wasm"`，而 `conduit`（依赖 `moonbitlang/async`）
只在 **native 侧**被检查。于是：

```
moon check              → Finished. moon: no work to do     ← 看起来全绿
moon check --target native → Failed with 0 warnings, 1 errors  ← 真相
```

**注入了一个错误、check 依然 0**，我一度以为注入点选错了，白排查一轮。
脚本里现在固定带 `--target native`，并在注释里写了为什么。

### 2. 注入 `c.toString()` 是**合法**的

我原以为 MoonBit 没有 `toString`（只有 `to_string`）—— **错了**，`toString()` 能编译。
所以第一版注入完 `check` 依然是 0。改成**拼错方法名** `to_stringX()` 才有真报错：

```
Type Char has no method to_stringX.
```

> 这两条是同一个教训：**"命令跑完了没报错"不等于"它检查了我以为它检查的东西"**。

## 顺带修的三处（演示脚本自身）

- 报错文案正则只覆盖了 `The value identifier` / `Unknown method`，漏了
  **`has no method`** → 抓成了末尾的 `Error: failed to run check...`；
- 任务文本写了 `conduit/slugs.mbt`，而 workspace **已经就是** `conduit/` →
  `exists('conduit/slugs.mbt')` 为 false → `relevantFiles` 空。
  （看着像"Agent 找不到相关文件"，其实是**路径基准**弄错了。）
- `apiRequest` 属于**执行表**（`agentTools.exec.call`），不在只读表 —— 走错表会报"未知工具"。

## 边界

- **全程没有修改一行 MoonBit 业务代码**：注入的错误在演示结束前**已还原**
  （脚本先备份、任何退出路径都 restore），并断言"还原后 check 仍为 0"。
- 演示需要 **Electron**，所以和 `verify-*` 一样**留在本地**、不进 CI。
