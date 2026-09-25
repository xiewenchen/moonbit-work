# 版本与发布

## 当前版本：`0.2.0-alpha`

`desktop/package.json` 的 `version` 已改为 `0.2.0-alpha`（原 `0.1.0`）。

对照清单里的三档定义，**当前处在第一档**：

| 版本 | 清单定义 | 现状 |
|---|---|---|
| **`0.2.0-alpha`** | IDE Core **+ Agent Read** | ✅ **已达成** |
| `0.2.0-beta` | Agent Execute + Patch + Verify | ⏳ 能力已实现（P6/P7/P8/P9），但**"真接 LLM 跑通"未验**（见下） |
| `0.2.0` | IDE + Agent + Backend + Quality + Workbench | ⏳ 数据层与面板已在，产品化（P20-01～03/05/06）未完 |

## 为什么只标 alpha

"Agent Read"（读文件/列目录/搜索/符号/诊断/运行日志/工程信息）**已成立且有验证**：
`verify-agent-tools` **41/0**，且工具表在**结构上**没有写/执行工具。

而 **`0.2.0-beta` 要求 Agent 真的能执行并验证** —— 这部分：
- **能力齐了**：P6 只读工具 / P7 执行工具（经命令表）/ P8 Patch（用户确认后写）/ P9 验证闭环；
- **端到端跑通了**：`verify-agent-e2e` **39/0**（MockLLM 驱动整条链，含三态对照）；
- **但**": "Agent 真的用 LLM 修好一个真实项目" **没有验过** —— 本机没有可用的 Provider 额度，
  也受 R12（native 工具链坏）限制（`test`/`run` 跑不起来）。

所以 **不标 beta**：清单的 RULE-01 是"未验证 = 未完成"。

## 发布动作

已做：
- `desktop/package.json` → `0.2.0-alpha`
- `docs/REGRESSION-P22.md`（本机回归报告：桌面侧全绿，MoonBit test/build 以 CI 为准）

**未做（需要明确决定）**：
- **git tag**：没有打 `v0.2.0-alpha` 这个标签。打标签是"对外宣布版本"的动作，
  而且推 tag 与推分支不同 —— 按本项目一贯的做法，**等明确确认后再打**。
- **mooncakes 发布**：不需要（这次没有改 MoonBit 业务代码，`moon.mod` 的版本不动）。

## CI 与本地的关系（避免口径混乱）

- **CI 跑 Linux**：MoonBit 的 `check/test/build`、以及桌面**纯 Node** 测试。
- **本地（Windows）跑**：`verify-*` 交互验证（需要 Electron、需要真实窗口）。
  它们**不进 CI**（仓库里明说了原因：依赖 Windows 路径与显示环境）。
- 因此：**"桌面侧全绿"是本地结论**；**"MoonBit 侧全绿"是 CI 结论**。两者不要互相替代。
