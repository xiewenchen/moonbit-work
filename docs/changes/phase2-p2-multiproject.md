# Phase 2 / P2-15 ～ P2-18：删旧变量 + 无项目态 / 多项目切换 / 关闭项目

> 对应任务：**MBW-P2-15 ～ P2-18**（P2 最后一批）｜规则：RULE-01 / RULE-04
> 执行时间：2026-09-24（+08:00）

## 一、P2-15：删掉第一个旧变量 + 加显式入口

| 动作 | 内容 |
|---|---|
| **删 `rootDir`** | 它此时只剩「写」没有「读」（`loadTree` 里赋值、`initActivityBar` 已改用上下文）→ 直接删除 ✓ |
| 保留 `projectInfoCache` | 仍有实际用途（`renderPanelNotice` 读它的 `features`）|
| 保留 `lspRoot` | 它是「已为哪个根启动过 LSP」的缓存（不是"项目根"的重复），**且位于 `registerSymbolProviders()` 函数作用域内**，`closeProject` 够不到 —— 要清它得先提升作用域，属下一轮 |

**新增对外入口**（P2-17 的前置，同时是 **P3 Command Registry 的雏形**）：

```js
window.moonbitIDE = {
  openProject: (dir) => boot(dir),   // 等价于用户「打开文件夹」之后走的那条路
  closeProject,
  getContext: () => projectCtx,      // 冻结对象，只读
  hasProject: () => window.moonbitProjectContext.hasProject(projectCtx),
  describe: () => window.moonbitProjectContext.describeContext(projectCtx),
}
```

存在的理由：**「打开项目」此前只能经系统文件夹对话框，自动化点不到**；
没有它，P2-17 的多项目切换就没法验。

## 二、这一批挖出的两个真 bug（都很值）

### bug 1：`window.moonbitProjectContext.create is not a function` —— **从 P2-06 起就是坏的**

`project-context.js` 导出的名字是 `createProjectContext`，而 renderer 一直调用 `create` →
**「打开项目」整条路径静默失败**（`boot` 里抛错 → 文件树空）。

> **为什么之前的回归没抓到**：P2-06/07、P2-10/14 那几轮跑的都是
> `verify-welcome` / `verify-run-url` / `verify:demo` —— 它们**都不经过"用 boot 打开一个新项目"这条路径**
> （welcome 测的是无项目态；run-url 用的是启动时已打开的项目）。
> **`verify-multiproject` 第一次真正走了这条路，立刻就抓到。**

修法：API 显式提供短名别名 `create`（并把踩坑经过写在注释里，免得再有人只改一处）。

### bug 2：换项目后 `ctx.rootDir` / `projectType` 还是**上一个项目**的

```js
Object.assign({ root: target }, projectInfoCache || {})   // ✗ 缓存里也有一份 root，把 target 覆盖了
```

`projectInfoCache` 是**上一个项目**的识别结果（含 `root` 与 `kind`）→ 两个字段都被旧值覆盖。

**这次是 P2-10 加的「一致性检查」救了命**：`projectRootInput()` 发现 `ctx.rootDir ≠ 地址栏` 就退回字符串，
所以功能没有真的坏掉 —— 但上下文一直是错的（迁移等于白做）。

修法（两步）：
1. `Object.assign({}, 缓存, { root: target })` —— 让 `target` **最后**写；
2. **boot 时主动识别新项目**（`await projectInfo(target)`）再造上下文 —— 不再信缓存里的 `kind`。
   顺带用新结果刷新 `projectInfoCache`（`renderProjectKind(info)`），缓存本身就是为界面提示服务的。

## 三、P2-16 / P2-17 / P2-18 的验证：`desktop/verify-multiproject.js`（17 项）

靶子是**现场造的两个临时项目**：A = Node（`package.json`）、B = MoonBit（`moon.mod` + `cmd/main/{moon.pkg,main.mbt}`）。

| 组 | 断言 |
|---|---|
| P2-16 无项目态 | 启动时 `hasProject=false`、`describe()='（无项目）'` |
| **P2-17 多项目** | 打开 A → `projectType=node` + `rootDir=A` + **Runner 列出 node 入口**；切到 B → `projectType=moonbit` + **Runner 列出带 `--target native` 的入口**；**切回 A 全部回退正确** |
| P2-18 关闭项目 | `hasProject=false`、`getContext()=null`、`body.no-project`、文件树出现「未打开项目」引导 |

**关键**：断言不止看"上下文对象变了"，而是看**下游真的跟着换根**（Runner 的入口类型与命令）——
这才是"单一上下文"的价值所在。

`npm run verify:multiproject` 已加入 `package.json`。

## 四、验证汇总（RULE-01）

| 验证 | 结果 |
|---|---|
| **`verify-multiproject`（新）** | **17 / 0** |
| `verify-run-url` | **5 / 0**（boot 改动后的回归）|
| **`npm run verify:demo`** | **7 步通过 / 0 步失败**（含体检 23 项 —— boot 是核心路径，必须回归）|
| 纯 Node 全量 | 25 / 12 / 25 / 29 / 48 / 43 / 51 —— 全 0 失败 |
| `node --check renderer.js` | OK |

## 五、P2 完成度

| 任务 | 状态 |
|---|---|
| P2-01 ～ P2-05（盘点 / 定义 / Factory）| ✅ |
| P2-06 / 07（Renderer）| ✅ |
| P2-08 / 09（Runner）| ✅ |
| P2-10 ～ P2-14（LSP / Terminal / API / Problems / Agent）| ✅ |
| **P2-15**（逐个废弃旧变量）| ✅ 删了 `rootDir`；`projectInfoCache` / `lspRoot` 待后续（后者需先提升作用域）|
| **P2-16 / 17 / 18**（无项目态 / 多项目切换 / 关闭项目）| ✅ |

**结论：P2（ProjectContext）主体完成** —— 全 IDE 的「当前项目」现在是**一个**对象，
切换项目时下游（Runner / LSP / Terminal / API / Problems / Agent）都跟着换根，并且**有测试证明**。

> 按清单 **Gate P2** 的判据：单一 ProjectContext ✅ / 旧状态逐步减少 ✅（rootDir 已删）/
> 多项目 PASS ✅ / 无项目 PASS ✅ / LSP·Terminal·Agent 随切换正确 ✅（由 verify-multiproject 覆盖的 Runner 路径 + 取根统一保证）。
