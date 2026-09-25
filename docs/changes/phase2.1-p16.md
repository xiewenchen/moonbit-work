# P16：Quality Center（把已有验证系统变成"工程状态"）

- 日期：2026-09-25
- 分支：`phase2-engineering-workspace`
- 状态：**P16-01～09 + P16-13/14 DONE**；**P16-10～12（UI）未做**（如实标注）
- `test-quality-result` **69/0**、`verify-agent-tools` **36/0**

## 定位

清单说得很直接：

> 这一阶段的价值不是再做一个 Dashboard，而是：**把已经存在的工程验证系统变成 IDE 的「工程状态」。**

所以这一批**没有重跑任何测试**。适配器只把各来源**已有的产物**归一成同一个形状：

| Adapter（P16-02～08） | 从哪来 |
|---|---|
| `fromBuildResult` | `project.build` 的 CommandResult |
| `fromTestResult` / `fromWasmResult` | `project.test` 输出（native / wasm-gc） |
| `fromSecurityReport` | 靶场输出（`N/M 通过`） |
| `fromRealWorldReport` | hurl 套件结果 |
| `fromPerfReport` | bench / loadtest 输出 |
| `fromDesktopVerify` | **本项目自己的**验证脚本输出（`结果：N 通过 / M 失败`） |

好处很实际：**秒回**、能离线、能进 CI，而且"工程状态"不会因为刷新一下就重跑全量套件。

## 五个状态不是凑数（P16-01）

```
PASS / FAIL / WARN / SKIP / NOT_RUN
```

三条刻意的区分：

1. **`SKIP` ≠ `NOT_RUN`** —— "因为环境不满足而跳过"与"根本没跑"是两件事。
   合成一个，就会让"没跑过"看起来像"跑过了"。`overall()` 里全 SKIP 也**不算通过**。
2. **解析不出 → `NOT_RUN`，不是 PASS** —— 这是这类面板最容易犯的错。
   `fromSecurityReport('这里啥也没说')` 返回 `NOT_RUN`，并有断言盯着。
3. **性能默认 `WARN`** —— 性能没有天然的通过/失败标准。只有调用方给了 `budgetQps` 才判 PASS/FAIL，
   否则就是 **"跑出来了，但没人说它够不够快"** —— `WARN` 正是为它准备的。

## P16-13/14：Agent 读 Quality

新增**只读**工具 `qualityStatus`（第 9 个只读工具）。它现场聚合 `desktop/*-result.txt`，
返回 `overall / canProceed / stats / failures / describe`。

- **不重跑测试** —— 否则 Agent 每问一次"现在能不能继续"都要跑一遍全量套件；
- `canProceed`（P16-14）**拦住**三种情况：有 FAIL、全 SKIP（等于没验）、什么都没跑。
  WARN 允许继续，但说明"有需要人看的警告"。

## 未做（P16-10～12）

- **Quality UI 面板**没有做；
- 因此 **P16-11 点击失败项跳日志 / P16-12 跳文件**也没有做（数据层已经准备好了：
  每条 `QualityResult` 都带 `file` / `line` / `detail`，UI 接上就能跳）。

诚实说明：这三项是**没做**，不是"做完了没提"。

## 验证

| 项 | 结果 |
|---|---|
| `node test-quality-result.js` | **69 / 0** |
| `npx electron verify-agent-tools.js` | **36 / 0**（含 qualityStatus 真的能调） |
| 纯 Node 全量 | **33 个脚本全通过** |
| 门禁 | 空 catch 93 ≤ 95；local-chk 通过 |
| CI | 新增 `node test-quality-result.js`（11 steps） |

## 附带修的

新增第 9 个只读工具后，`test-agent-tools.js`（纯 Node）与 `verify-agent-tools.js`（Electron）
的工具清单断言都需要同步 —— 前者是被**纯 Node 全量先跑红**发现的，说明那条"全量跑一遍"的习惯有用。
