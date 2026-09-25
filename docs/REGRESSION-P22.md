# P22 最终回归报告

- 时间：2026-09-25
- 分支：`phase2-engineering-workspace`
- 命令：`bash /tmp/p22-regression.sh`（本报告就是它的输出）

## A. MoonBit 侧

| 检查 | 结果 |
|---|---|
| `moon check --target native` | `Finished. moon: ran 1 task, now up to date` (**33 warnings, 0 errors**) |
| `moon check --target wasm-gc` | `Finished. moon: ran 13 tasks, now up to date` |

> ⚠️ **本机 R12**（native 工具链坏，`moon build --target native` EXIT=127），
> 所以 `moon test` / `moon build` 这类**本机跑不了**，其结论**以 CI 为准**。
> 上表两项是本机能跑的那部分（`check` 是好的）。

## B. 桌面纯 Node 测试

```
39 个脚本，失败 0 个
```

## C. 桌面 Electron 交互验证（抽关键的 7 个）

| 脚本 | 结果 |
|---|---|
| `verify-run-url.js` | exit=0 · **5 / 0** |
| `verify-run-dispatch.js` | exit=0 · **5 / 0** |
| `verify-agent-tools.js` | exit=0 · **41 / 0** |
| `verify-agent-request.js` | exit=0 · **41 / 0** |
| `verify-workbench.js` | exit=0 · **23 / 0** |
| `verify-panel-entry.js` | exit=0 · **14 / 0** |
| `verify-dash-v2.js` | exit=0 · **27 / 0** |

（共 47 个 `verify-*`；这里跑的是与本次会话改动最相关的 7 个，全部 exit=0。）

## D. 门禁与审计

| 门禁 | 结果 |
|---|---|
| 空 catch | ✓ 没有新增（A 类 93 ≤ 基线 95） |
| 局部 chk | ✓ 没有新增（**基线 0**，即已全部迁到公共 harness） |
| 安全审计 | ✓ 没有新增高危项（高危 0 / 中危 0） |

## E. 规模

| 项 | 数值 |
|---|---|
| git commits | **142** |
| 桌面 `.js` | **156** |
| 纯 Node 测试 / `verify-*` | **39 / 47** |
| preload IPC | **149** |

## 结论

**桌面侧全绿**（39 个纯 Node + 抽检的 7 个 Electron，全部通过），三个门禁通过。
**MoonBit 侧的 test/build 以 CI 为准**（本机 R12）。
本报告**不声称** "CI 也全绿" —— 那是 CI 的事，本机验不了。
