# P9C：第一次真正的 Agent E2E

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**PASS** —— `verify-agent-e2e.js` **39 / 0**（本地 Electron；不进 CI，见下）

## 这条链终于整条走通了

```
Ask → Understand → Read → Diagnose → Patch → Confirm → Check → Test → Run → Health → Report
```

| 步 | 做了什么 | 结果 |
|---|---|---|
| ⓪ | **三态对照**：干净 → 注入 → 修好，各跑一次真 `moon check` | 0 / ≠0 / 0 ✓ |
| ① | 注入 `missingIdent`（未定义标识符） | ✓ |
| ② | IDE 打开靶项目（`openProject`） | 识别正确 |
| ③ | 产生 Problem（文案取自**真实 check 输出**） | ✓ |
| ④ | 获取 Context（快照能看到收到了什么） | ✓ |
| ⑤ | Ask → Understand（**可验证的任务理解**） | 相关文件/问题都对上 |
| ⑥ | MockLLM 分析 → 真调 `readFile` → 结果回灌 | ✓（回灌里有 `missingIdent`） |
| ⑦ | 生成 Patch（真 token + 预览） | ✓ 且 **propose 不写盘** |
| ⑧ | 用户确认 | 确认前文件仍是坏的 ✓ |
| ⑨ | Apply | **文件真的被改了** + 有备份路径 + 修好后 check 恢复 0 ✓ |
| ⑩～⑬ | 验证闭环（check → test → run → health） | check ✓；test 失败（见下）；run/health **未跑** |
| ⑭ | 报告 | 如实 `VERIFY_FAILED` + 具体原因 |

## 三态对照 —— 这条是 review 逼出来的

原来只在最后断言"steps 里有 check"，那**无法排除 check 恒返回 ok 的假阳性**。
现在脚本里直接 `spawnSync('moon', ['check'])` 跑三次：

- 干净版本 → 退出码 **0**
- 注入错误 → 退出码 **≠0**，且报错就是 `The value identifier missingIdent is unbound.`
- 修好之后 → 退出码 **0**

**"修好"这件事因此有对照**，而不是"跑完没报错"。

## 过程中修掉的 3 个真缺陷

1. **`runTest()` 没传 `root`** → `project.test` 的 handler 要求 `args.ctx`/`args.root`，
   传 `{}` 会直接报 **"未打开项目"**。这是 P9 接线时的遗漏：`check` 传了 root，`test`/`run` 漏了。
2. **`startRun({root})` 的"修复"其实是无效的**（review 抓到）：`project.run` **根本不读 root**，
   它要 `args.spec.bin`。我原先写的注释"命令表要求 args.ctx 或 args.root"**认知就是错的**。
   → 改成：没有可运行入口就**如实失败**，并在注释里写明"这不是已修好，闭环要自动 run
   必须把入口一起传进来"。
3. **我自己引入的 `projectCtx is not defined`**：`projectCtx` 是**渲染侧**变量，主进程里没有。
   → 改成主进程用 `detectProject(workspace)` 现场识别。**这个是 E2E 自己抓出来的** ——
   正是"端到端才有价值"的例子。

另修：`runTest` 现在带上 `projectType`（否则默认按 `moon test` 跑，打开 node/go 项目会跑错 ——
review 指出的跨类型副作用）；同轮工具调用消息合并；备份/还原加 `BACKED_UP` 标志
（原来 `if (!win) return dump(1)` 在备份**之前**，会把靶项目的源文件删掉 —— review 的 blocking）。

## 关于 test / run / health 的如实说明

- **test 失败是环境限制**：本机 `moon test` 零输出（红灯 **R12**），退出码表现为 `4294967295`。
  报告里如实给出 `测试失败（退出码 …）`，**没有**伪装成通过。
- **run / health 没跑** —— 因为闭环是**失败即停**。这**恰好验证了这条语义是真的**：
  E2E 断言"有失败步骤 → `ok=false`"且"失败之后不能再有成功步骤"。
- 因此本机跑出来的结论是 `VERIFY_FAILED`，而**不是**"E2E 全绿"。
  Gate M2-REAL 要的"Mock LLM E2E PASS"，本批达成的是：**链路完整 + 每步结果如实**
  （check 真通过、test 因环境失败、失败即停生效）。**要拿到 test/run 也绿，需要修 R12（本机工具链）**。

## 为什么这个 E2E 不进 CI

它需要 **Electron**（要真开 IDE、走 IPC、跑真 `moon check`），而 CI 是 Linux、无 `moon`。
所以它留在本地（`npm run verify:agent:e2e`），与既有 `verify-*` 交互层一致。
纯逻辑那部分（adapter / mock / 理解 / 补丁）已经全部在 CI 里（29 个 Node 测试）。

## 验证

| 项 | 结果 |
|---|---|
| `npx electron verify-agent-e2e.js` | **39 / 0**（含三态对照、失败不假绿、失败即停） |
| `verify-agent-verify.js` | **17 / 0**（改过 `agent-verify-main.js`，必须回归） |
| `verify-agent-request.js` | 41 / 0 |
| 纯 Node 全量 | **29 个全通过** |
| 门禁 | 空 catch 94 ≤ 95；local-chk 通过 |
| 靶项目 | 跑完**已还原**（`missingIdent` 计数 0；与备份逐字节一致） |
