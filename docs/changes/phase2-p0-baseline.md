# Phase 2 / P0 基线快照

> 对应任务：**MBW-P0-06**（建立初始验证快照）｜规则：RULE-01「未验证 = 未完成」
> 执行方式：脚本 `/tmp/p0-baseline.sh`（串行执行，输出重定向到 `/tmp/p0-baseline.log`）

## 一、环境

| 项 | 值 |
|---|---|
| 时间窗 | 2026-09-24 18:32:34 → 18:35:58（+08:00，共 204 秒） |
| 目录 | `C:\Users\33567\AppData\Roaming\reasonix\global-workspace\moonbit-platform` |
| git | `796fd05` @ 分支 `phase2-engineering-workspace` |
| 工具链 | `moon 0.1.20260920`；Node v24.15.0；Windows |

## 二、命令与结果

### [1/3] `moon check --target native`

- **时间**：18:32:34 → 18:32:36（约 2 秒）｜**exit code：0** ｜ **result：PASS**
- stdout（末尾）：
  ```
  Finished. moon: ran 1 task, now up to date (33 warnings, 0 errors)
  ```
- stderr：无（33 条 warning 走 stdout，多为 `test_unqualified_package` 风格类）

### [2/3] `npm run verify:desktop`（cwd = `desktop/`）

- **时间**：18:32:36 → 18:33:34（约 58 秒）｜**exit code：1** ｜ **result：FAIL（且提前中止）**

| 子步骤 | 结果 |
|---|---|
| `node test-runner-detect.js` | PASS（无 FAIL 输出） |
| `node test-project-detect.js` | PASS |
| `node test-relay.js` | PASS（`[relay] 初始扫描 Downloads：2 个文档 / Desktop：4 个文档`） |
| `electron verify-welcome.js` | PASS（无项目态 3 场景：home/agent/tools 正常显示；项目标签只留打开/新建） |
| `electron verify-agent-config.js` | **9 通过 / 0 失败** |
| `electron verify-run-url.js` | **3 通过 / 2 失败** ← 红灯 R1 |
| `electron verify-run-dispatch.js` | **未执行** |
| `electron verify-relay.js` | **未执行** |
| `electron e2e-features.js` | **未执行** |

- 失败详情（`verify-run-url.js`）：
  ```
  === ② 运行它，并从输出里抓到本地 URL ===
     {"url":null,"chunks":2,"waited":25208}
    [FAIL] 运行后抓到了本地 URL（IDE 据此自动开浏览器）
    [PASS] 运行过程中收到了输出流
  === ③ 那个地址真的能访问（服务确实起来了）===
    返回片段：""  fetchErr=Failed to fetch
    [FAIL] 页面能打开且内容正确
  结果：3 通过, 2 失败 / 共 5 项
  ```

> ⚠️ **本次快照新发现**：`verify:desktop` 的 npm script 用 `&&` 串联 9 个脚本，
> 因此 **`verify-run-url` 一失败，后面 3 个脚本（含 23 项功能体检）根本没跑**。
> 即「verify:desktop 通过」与「功能体检 23/23」当前**无法在同一次运行中获得**。
> 已登记为 Red R11（见 `PHASE2.md`），按 RULE-02 只记录、不顺手修。

### [3/3] `npm run verify:demo`（cwd = `desktop/`）

- **时间**：18:33:34 → 18:35:58（约 144 秒）｜**exit code：1** ｜ **result：6 步通过 / 1 步失败**

| 彩排步骤 | 结果 | 耗时 |
|---|---|---|
| 启动：5 个标签 + 无项目态落地 | 通过 | 5.9s |
| **运行项目 → 抓到 URL → 页面能打开** | **失败** | 31.9s |
| 项目类型识别（含 RuoYi→java） | 通过 | 0.3s |
| 顶栏按钮按类型分派 | 通过 | 42.8s |
| 文件中转站全流程 | 通过 | 30.5s |
| AI Agent 配置弹窗（真点击） | 通过 | 10.4s |
| 功能体检（23 项） | 通过 | 19.7s |

- 失败详情（同一步，比 `verify:desktop` 更差 —— 这次连输出都没有）：
  ```
  [FAIL] 运行后抓到了本地 URL（IDE 据此自动开浏览器）  {"url":null,"chunks":0,"waited":25114}
  [FAIL] 运行过程中收到了输出流  chunks=0
  [FAIL] 页面能打开且内容正确   Failed to fetch
  结果：2 通过, 3 失败 / 共 5 项
  ```
- 产物：`desktop/demo-rehearsal-result.txt`（已更新）
- 耗时基准：**全部在基准内** ✓

## 三、结论

| Gate P0 项 | 状态 |
|---|---|
| TAG | PASS（`hackathon-final-2026-09-24`，本地） |
| BRANCH | PASS（`phase2-engineering-workspace`） |
| **BASELINE** | **PASS（本次快照已完成并落盘）** |
| DOC | PASS（`PHASE2.md` / `PHASE2-TASKS.md` / 本文件） |

**基线绿灯**：`moon check` 0 error；桌面端 welcome / agent-config(9/9) / relay / 项目类型识别 / 顶栏分派 / 功能体检(23/23) 均通过。

**基线红灯（与 `PHASE2.md` §5 一致）**：`run-url` 3/5（R1）；`verify:demo` 1 步失败（R2）；
`moon test` 本机零输出（R3）；**新增：`verify:desktop` 的 `&&` 串联导致失败后静默跳过后续 3 个脚本（R11）**。

## 四、下一步

按第一批任务继续 **P1**（只读诊断 Run 链路），在 P1-06 给出「第一次出现错误的位置」之前，
**不修改任何业务代码**。
