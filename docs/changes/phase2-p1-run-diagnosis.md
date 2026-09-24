# Phase 2 / P1 Run 链路诊断报告

> 对应任务：**MBW-P1-01 ～ MBW-P1-06**（全部只读，**未修改任何业务代码**）
> 规则：RULE-01「未验证 = 未完成」、RULE-02「一个任务只解决一个问题」、RULE-03「修改前必须知道修改对象」
> 执行时间：2026-09-24 18:36 – 18:45（+08:00）

---

## P1-01 Run 入口与调用链

**UI 入口有 3 处**：

| # | 位置 | 触发 |
|---|---|---|
| ① | `renderer.js:477` | 命令面板「MoonBit: 运行当前项目」 |
| ② | `renderer.js:821` | 顶栏按钮 `c === 'run'` |
| ③ | `renderer.js:787 / 813` | Node 项目的 build/test/fmt/check → `runNpmTask()` → `startRunner()` |

```
① ② ─→ runProject()            renderer.js:678   ← ★ 第一入口
              │
              ├─ window.moonAPI.runnerList(cwd)          [IPC runner:list]
              ├─ 0 个入口 → logLine(提示「找的是哪个目录 + 支持哪些类型」)
              ├─ 1 个入口 → startRunner(spec)            renderer.js:739
              └─ N 个入口 → showRunnerPicker()           renderer.js:703（点选后再 startRunner）
                              │
                              ▼
                        startRunner(spec)
                              └─ window.moonAPI.runnerRun(spec)   [IPC runner:run]
                                              │
                                              ▼
                        主进程 runners.js:246  ipcMain.handle('runner:run')
                              ├─ spawnRunner()                     runners.js:215
                              ├─ onChunk → URL 检测 → openExternal  runners.js:255-267
                              └─ 事件回推 runner:start / data / url / end
                                              │
                                              ▼
                        renderer 侧监听                       renderer.js:2141-2160
                          onRunnerData → 输出面板
                          onRunnerUrl  → 「[服务已就绪] <url>」+ 状态栏   ← 只有这条会提示"已打开浏览器"
                          onRunnerEnd  → 结束
```

**结论（P1-01 验收）**：Run 的第一入口是 `runProject()`（`desktop/renderer.js:678`）。

## P1-02 Runner 职责表（`desktop/runners.js`，283 行）

| 职责 | 位置 | 说明 |
|---|---|---|
| 项目识别 | `kindOf():20`、`findRunners():115`、`javaNeeds():37` | moonbit / node / python / rust / go / java / static |
| 命令生成 | `findRunners()` 内 `add(...)` | 每个入口产出 `{label, hint, bin, args, cwd, kind}` |
| 入口命名 | `niceName():64`、`scriptLabel():87`、`needsBackends():102` | 中文标题 + 命令小字 + 外部依赖标注 |
| spawn | `spawnRunner():215` + `spawn-util.resolveSpawn` | 处理 Windows 不能直接 spawn `.cmd/.bat` |
| stdout | `229` 上一行：`child.stdout.on('data', …)` | — |
| stderr | `229`：`child.stderr.on('data', …)` | **stdout 与 stderr 都接**（非只接 stdout） |
| URL 检测 | `onChunk:255` → 剥 ANSI`:260` → `buf.slice(-2048)`:261 → 正则`:262` → 去尾标点`:265` | 累积 2 KB 缓冲以覆盖跨 chunk |
| process exit | `231`：`child.on('close', code => onEnd({ok:true, code}))` | — |
| 状态更新 | 主进程只 `send`；状态在 renderer `2141-2160` | 职责已分离 |
| browser open | `267`：`require('electron').shell.openExternal(url)` | 失败被 `try/catch(_)` 静默吞掉 |

> 备注（属 P1-21 范围，本轮只记录）：`openExternal` 失败被空 catch 吞掉 → 无法区分「服务没起来」与「浏览器没打开」。

## P1-03 IPC 图

```
renderer.js ──preload.js:54-60 (contextBridge)──▶ main.js:122 registerRunnerIpc ──▶ runners.js

  invoke  runner:list   →  handle  runners.js:242
  invoke  runner:run    →  handle  runners.js:246
  invoke  runner:stop   →  handle  runners.js:277
  on      runner:start  ←  send    248
  on      runner:data   ←  send    256
  on      runner:url    ←  send    266
  on      runner:end    ←  send    272
```

**重复调用检查**：`registerRunnerIpc` 全仓只在 `main.js:122` 注册一次；
`runner:run` 开头会先 `kill()` 掉上一个进程（`247`），保证同一时刻只有一个运行实例 → **无重复注册、无重复调用**。

## P1-04 现有 Run 相关测试

| 脚本 | 测什么 | 依赖 | 历史结果 | 本轮实测 |
|---|---|---|---|---|
| `test-runner-detect.js` | `findRunners` / `kindOf` 输入→输出（18 项） | 纯 Node | 通过 | **通过**（P0-06 快照） |
| `verify-url-regex.js` | URL 抓取正则（8 项） | 纯 Node | 通过 | **8 通过 / 0 失败**（本轮重跑） |
| `verify-run-dispatch.js` | 顶栏按钮按项目类型分派（5 项） | Electron | 5/5 | **5 通过 / 0 失败**（本轮单独重跑；②段输出里可见 `moon test (exit 1)`，再次印证 R12） |
| `verify-run-url.js` | 列出入口 → 运行 → 抓 URL → 访问页面 → 停止（5 项） | Electron + **native 构建** | 3/5 | **3 通过 / 2 失败** |
| `verify-run-e2e.js` | 点运行 → 有流式输出 | Electron + native | — | 未跑 |
| `verify-open-url.js` | 是否抓到 URL 并 `openExternal` | Electron + native | — | 未跑 |

> `verify-url-regex.js` 里的正则与 `runners.js:262` 的生产正则**逐字符相同**、ANSI 剥离逻辑也一致 →
> 它的 8/8 结果**可以直接代表生产 URL detector**。

## P1-05 失败复现记录（只复现，不修）

| # | 场景 | 命令 | 实测结果 |
|---|---|---|---|
| 1 | IDE 自动化 | `npm run verify:desktop` → `verify-run-url.js` | `{"url":null,"chunks":2,"waited":25208}` → **3 通过 / 2 失败** |
| 2 | IDE 彩排 | `npm run verify:demo` | `{"url":null,"chunks":0,"waited":25114}` → 该步 **2 通过 / 3 失败** |
| 3 | 同一条命令（Git Bash） | `moon run --target native ./hello/cmd/main` | 12 秒内只输出编译进度（`watch_inotify.c`…`backtrace.c`），**无 URL**；`8123` 探测 `code=000` |
| 4 | 直接构建（Git Bash） | `moon build --target native hello/cmd/main` | **EXIT=127**，6 秒，`Failed with 0 warnings, 0 errors.` / `Error: failed to run build for target Native` |
| 5 | 直接构建（PowerShell 原生环境，非 MSYS） | 同上 | **EXIT=-1**，`failed when building project` → **排除 Git Bash PATH 干扰** |
| 6 | 其它 native 可执行目标 | `moon build --target native {demo,notes,cmd}/cmd/main` | **全部 exit=127** |
| 7 | 单元测试 | `moon test --target native http` | exit=1，**0 行输出** |

**对照实验（排除误判）**：

| 检查 | 结果 |
|---|---|
| `cl.exe` 是否存在 | **在**：`…/BuildTools/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/cl.exe` |
| Windows SDK | **在**：`…/Windows Kits/10/bin/10.0.26100.0/` |
| 非可执行目标能否构建 | **能**：`moon build --target native http` → `Finished. moon: no work to do` |
| 静态检查 | **能**：`moon check --target native` → `0 errors`（2 秒） |
| 失败的具体一步（`--verbose`） | `moonc.exe link-core … -o …\hello\cmd\main\main.c …` 失败；**`main.c` 未生成** |
| 产物目录 | `_build/native/debug/build/hello/cmd/main/` 只有 `main.core` + `main.mi`（2026-09-23 生成），**无 `.c` / `.obj` / `.exe`** |

## P1-06 判定：失败属于哪一层

按清单的 A–J 逐层排查：

| 层 | 判定 | 依据 |
|---|---|---|
| **A** spawn 失败 | ✗ 不是 | `runner:run` 正常返回，verify 侧确实收到 `chunks=2`（进程起来了） |
| **B 进程启动失败** | ✅ **是（错误就出现在这里）** | `moon build --target native` **EXIT=127** |
| C 进程没有监听 | 未触达 | B 之前就断了 |
| D stdout 没输出 | 未触达 | — |
| E stdout 跨 chunk | ✗ 不是 | `verify-url-regex` 跨 chunk 用例通过 |
| F ANSI 干扰 | ✗ 不是 | 同上（ANSI 用例通过） |
| **G URL detector** | ✗ 不是 | 正则与生产**逐字符相同**，8/8 通过（含跨 chunk、ANSI、多形态、非本地地址不该匹配） |
| H browser.open | 未触达 | — |
| I 页面本身失败 | 未触达 | — |
| J state machine | 未触达 | — |

### 🎯 第一次出现错误的位置

> **构建阶段（B）**：`moon build --target native` 在 **`moonc link-core`（生成可执行文件）** 这一步失败，
> 退出码 **127**，报 `Failed with 0 warnings, 0 errors.` → `failed when building project`。
>
> 该失败位于 Run 链路的**第 0 步（spawn 之前）**：服务从未启动 ⇒ 永远不会有 URL 输出 ⇒
> IDE 的 25 秒窗口必然超时 ⇒ `url=null`。**URL detector、browser.open、状态机都还没有被触达。**

### 边界与诚实说明

1. **这是本机 MoonBit 工具链的环境故障，不是项目代码缺陷**。它与已登记的环境问题同源：
   `moon check` 可用（0 error），但 `moon test` 零输出、`moon build --target native`（可执行目标）失败。
   （记忆库中已登记：「本地 `~/.moon` 环境已手工改坏 → 验证只信 CI」。）
2. **因此 Run 链路的 C–J 层在本机无法被验证**：P1-14～P1-29（状态机 / ProcessHandle / Run×10 /
   Run-Stop×10）全部 **BLOCKED**（阻塞于本机工具链，而非代码）。
3. **不受影响的批次**：P1-07～P1-13（URL Detector 抽离与 6 类单测）是**纯逻辑**，可在 Node 上跑，
   **不需要 native 构建** → 可以照常推进。
4. **不能据此宣布 Run 链路"没有缺陷"**：只能说「在本机，故障点在最上游，下游未被触达」。
   Run 链路（尤其状态机与浏览器失败区分）仍需在能构建 native 的环境里验证。

## 本轮未修改任何业务代码

改动仅限文档：`docs/PHASE2.md`、`docs/PHASE2-TASKS.md`、`docs/changes/phase2-p0-baseline.md`、
本文件。`desktop/` 与 `*.mbt` **零改动**（`git status` 可验）。
