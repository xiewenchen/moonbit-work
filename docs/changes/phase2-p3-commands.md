# Phase 2 / P3-01 ～ P3-08、P3-13 ～ P3-15：Command Registry

> 对应任务：**MBW-P3-01 ～ P3-08**（注册表 + 六个项目命令）、**P3-13 ～ P3-15**（日志 / 超时 / 单测）
> 规则：RULE-01 / RULE-02 / RULE-04｜执行时间：2026-09-24（+08:00）
> **本批只建命令层**；UI / Menu / Shortcut / Terminal 改走命令（P3-09～P3-12）属下一批。

## 一、为什么要有 Command Registry

清单 Gate P3 的判据是：**同一个动作**（UI 按钮 / 菜单 / 快捷键 / 未来的 Agent）
最终都走**同一个 Command** —— 而不是各自实现一份。

现在的事实是：`renderer.js` 里「运行项目」有一套逻辑、命令面板里又有一套、
以后 Agent 还会再有一套。命令层就是把这些收敛成一处的**唯一入口**。

## 二、产出：`desktop/commands.js`（纯逻辑 + 依赖注入）

| 任务 | 导出 | 说明 |
|---|---|---|
| P3-03 | `commandResult(input)` | `ok / code / data / stdout / stderr / duration / error`；类型一律归一（`data` 缺省是 `null` 不是 `undefined`）|
| P3-01/02 | `createCommandRegistry({ logger })` | `register / list / has / get / execute` |
| P3-02 | Command 形状 | `name / title / permissions / timeoutMs / danger / handler`（整对象 `Object.freeze`）|
| P3-14 | `withTimeout(p, ms, name)` | 命令级执行超时；`ms <= 0` = 不限时 |
| P3-13 | 日志 | `register / start / finish / error / unknown` 五个阶段都记 |
| P3-04～08 | `registerProjectCommands(registry, deps)` | 六个命令：`project.open / close / build / run / stop / test` |

### 两个刻意的设计

1. **`execute()` 永不抛错** —— 任何异常都转成 `{ ok:false, error }`。
   UI 与（未来的）Agent 只有一条处理路径，不用到处写 try/catch。
2. **依赖全部注入**（`runner` / `runCmd` / `pathExists` / `rootOf`）——
   于是本文件**不 require electron、不 spawn**，能纯 Node 单测、进 CI。
   这一点很关键：真跑 `moon build` 的环境不在 CI 上，若把 spawn 写死在里面，这批就只能靠人手点。

### 架构决策：命令表放**主进程**

- UI 按钮 / 菜单 / 快捷键 → `IPC command:execute` → 主进程命令表 ✓
- Agent（主进程侧的 `agent.js`）→ 直接调同一个命令表 ✓
- 于是「UI 与 Agent 走同一条路」是**结构性保证**，不靠约定。

`project.open` / `project.close` 的主进程侧只做**能做的事**：
open = 校验目录 + 解析出 `rootDir`；close = **停掉还活着的运行实例**。
真正的 UI 动作（加载文件树、切视图）仍在渲染侧 —— 这一层不越界。

### 按项目类型选命令

| 类型 | build | test |
|---|---|---|
| moonbit（及未知）| `moon build --target native` | `moon test --target native` |
| node | `npm run build` | `npm test` |
| rust | `cargo build` | `cargo test` |
| go | `go build ./...` | `go test ./...` |

## 三、验证（RULE-01）

```bash
cd desktop && node test-commands.js
```

**结果：44 通过 / 0 失败**

| 组 | 覆盖 |
|---|---|
| CommandResult | 默认值、`ok→code`、类型归一、`data` 缺省为 `null` |
| 注册表 | 缺 name / 缺 handler / 重复注册 / 未知权限 **都报错**；默认权限 `read`、默认超时 60s；`list()` 不含 handler |
| 执行 | 未知命令 → `ok:false`；正常 → 规范化 + `duration` 是数字；handler 返回普通对象 → 包成 `ok:true/data`；**handler 抛错不冒泡** |
| **超时** | 60ms 超时对 400ms 的 handler → `ok:false` 且**立刻**返回（耗时 < 350ms）；`opts.timeoutMs=0` 可关闭 |
| 日志 | `register / start / finish / error` 四阶段齐全，`finish` 带 duration |
| 六个命令 | open 缺目录/目录不存在/正常；run 的 spec **透传** runner；stop 与 close 都调 `runner.stop`；build 按类型选命令且透传 stdout；test 选 `npm test`；未打开项目 → 失败；非 0 退出 → `ok:false + code + stderr` |

**回归**：纯 Node 全量 25 / 12 / 25 / 29 / 48 / 43 / **44** / 51 —— 全 0 失败；
`check-empty-catch --ci` **94 ≤ 基线 95**；CI YAML OK（`test-commands.js` 已挂进桌面纯逻辑段）。

## 四、未做（P3-09 ～ P3-12，下一批）

| 任务 | 说明 |
|---|---|
| P3-09 | UI 的「运行项目」按钮改走 `executeCommand('project.run')` |
| P3-10 | 菜单改走命令 |
| P3-11 | 快捷键改走命令 |
| P3-12 | Terminal 调用命令 |
| 接线前提 | 需要给主进程加 `command:list` / `command:execute` 两个 IPC，并在 renderer 侧暴露 `window.moonbitIDE.commands`（复用已有出口）|

> **Gate P3 提醒**：接线完成后，Agent **只建立调用接口，不允许自动执行**（P7 才开执行权限）。
