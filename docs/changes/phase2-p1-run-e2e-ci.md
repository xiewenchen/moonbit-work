# Phase 2 / 把 Run E2E 搬进 CI（P1-19 前置）

> 触发：用户在 P1-14～P1-29 被 **R12**（本机 `moon build --target native` 全目标 EXIT=127）阻塞后，
> 选择「把 Run E2E 搬进 CI（新增一个 Linux 作业）」。
> 规则：RULE-01（未验证=未完成）/ RULE-02（一个任务一个问题）/ RULE-03（改前先摸清）/ RULE-04（渐进迁移）

## 一、现状与问题（RULE-03）

| 项 | 值 |
|---|---|
| Run 链路实现 | `desktop/runners.js:235-275`，全部内联在 `ipcMain.handle('runner:run')` 里 |
| 依赖 | `ipcMain` / `webContents.send` / `electron.shell.openExternal` —— **离开 Electron 无法测** |
| 现有覆盖 | 只有本机 `verify-run-url.js`（Electron + 真跑 MoonBit） |
| 致命点 | 本机 MoonBit native 构建坏了（R12）→ 这条链路的**唯一验证手段同时失效** |
| 正则副本 | 两处：`runners.js:262` 与 `verify-url-regex.js:3` |

## 二、修改边界

| 类别 | 内容 |
|---|---|
| **允许修改** | `desktop/runners.js`（首次动生产文件，仅做「等价抽取 + 接线」）、`desktop/verify-url-regex.js`、`desktop/test-url-detect.js`、新增 `desktop/testdata/`、新增 `desktop/test-run-e2e.js`、`.github/workflows/ci.yml`、`docs/` |
| **禁止修改** | `renderer.js`、`main.js`、`preload.js`（IPC 契约不变）、所有 `*.mbt` |

## 三、改了什么

### 1. `runners.js`：抽出 `createServiceRunner`（等价重构）+ 接线 `url-detect.js`

```js
function createServiceRunner({ openUrl } = {}) {   // 纯 Node，不 require electron
  start(spec, { onStart, onData, onUrl, onBrowserOpen, onEnd })
  stop()
  get running()
}
```
- `registerRunnerIpc` 只保留「把回调转成 IPC 事件」+ 把 `openExternal` 注入进去 → **Electron 依赖降到最外层**。
- URL 检测改用 `createUrlScanner()`（来自 `url-detect.js`）→ **删掉了内联正则与 ANSI 剥离的副本**。
- 新增 `onBrowserOpen` 回调：浏览器打开结果**单独一路**上报（P1-21：browser launch status ≠ server status）。
- 行为保持一致：同一时刻只跑一个进程；URL 命中一次不再重复触发；`stop()` 无进程时返回 `{ok:false}`。

### 2. `verify-url-regex.js`：改为引用共享实现

不再本地复制正则，改用 `detectUrl` / `createUrlScanner`（7 项用例 + 跨 chunk 场景全部保留）。

### 3. `test-url-detect.js`：契约断言跟着升级

旧断言「`url-detect.js` 的正则 === `runners.js:262` 的正则」在迁移后已无意义（副本没了），
改为更强的新契约 —— **正则在生产代码里只有一处实现**：

| 断言 | 期望 |
|---|---|
| `runners.js` 已接线到 `url-detect.js` | true |
| `runners.js` 用 `createUrlScanner`（而非本地正则） | true |
| `runners.js` 不再保留本地正则副本 | false（检查 `buf.match(` 不存在）|
| `verify-url-regex.js` 也不再复制正则 | false |

### 4. 新增 `desktop/testdata/fixture-http-server.js`

零依赖 Node HTTP 服务，**端口由系统分配**（避免 CI 端口冲突），启动后打印
`Server at http://127.0.0.1:<port>` —— 与真实项目同格式，供 URL detector 抓取。
支持 `FIXTURE_SPLIT=1` 把这一行**拆成 3 次 write**，用来跑真实的跨 chunk 路径。

### 5. 新增 `desktop/test-run-e2e.js`（17 项，纯 Node）

| 组 | 断言 |
|---|---|
| ① 主链路 | start 返回 pid / 抓到本地 URL / `openUrl` 恰好一次 / 有输出流 / **页面 200 且内容正确** / stop 返回 ok / `running=false` / **停止后端口不再可连** |
| ② P1-23 | 第二次 stop 返回 `ok:false` 且不抛 |
| ③ 跨 chunk | URL 被 3 次 write 拆开仍抓全（真实链路，非手工拼接）|
| ④ 不误报 | 无 URL 输出时 `onUrl` 不触发 |
| ⑤ **P1-21** | 浏览器抛错时：`onBrowserOpen` 上报 `ok:false` + 原因，**且服务仍在运行** |
| ⑥ P1-24 | 可执行文件不存在 → `onEnd` 报 `ok:false` 且带原因 |
| ⑦ P1-26 | 提前 `exit 1` → 上报退出码 1、`running=false` |
| ⑧ | 第二次 start 会换掉上一个进程（同一时刻只跑一个）|

### 6. `.github/workflows/ci.yml`：新增一个 step

```yaml
      - name: Run E2E (pure Node)
        run: |
          cd desktop
          node test-run-e2e.js
```

## 四、验证（RULE-01）

| 验证 | 命令 | 结果 |
|---|---|---|
| **Run E2E（新）** | `node desktop/test-run-e2e.js` | **17 通过 / 0 失败** |
| URL 检测 + 契约 | `node desktop/test-url-detect.js` | **29 通过 / 0 失败**（26 + 4 契约 − 1 旧） |
| 真实样本回归 | `node desktop/verify-url-regex.js` | **8 通过 / 0 失败**（改为共享实现后） |
| 运行入口识别 | `node desktop/test-runner-detect.js` | 18 / 0 |
| 项目识别 | `node desktop/test-project-detect.js` | 12 / 0 |
| 中转站 | `node desktop/test-relay.js` | 25 / 0 |
| 空 catch 门禁 | `node tools/check-empty-catch.js --ci` | **95 = 基线 95，没有新增** |
| CI YAML | `python -c "import yaml; yaml.safe_load(...)"` | **YAML OK**（10 个 step） |
| Electron IPC 回归 | `npx electron verify-run-dispatch.js` | 见下方「回归」 |

**关键意义**：Run 链路的核心（spawn → 抓 URL → 浏览器 → 页面 → 停止）现在**不依赖 Electron、
不依赖 MoonBit native 构建**，因此**本机工具链坏掉也能验，CI 每次 push/PR 都能验** ——
这正是 R12 阻塞的解药。

## 五、覆盖映射（诚实）

| 任务 | 状态 |
|---|---|
| P1-19（链路：spawn → 输出 → URL → 浏览器） | **核心已覆盖**（顺序、跨 chunk、单实例）；**状态机部分仍缺**（P1-14～P1-18） |
| P1-20 浏览器打开单独测试 | ✅ 覆盖（可注入 `openUrl`） |
| P1-21 浏览器失败不得标 FAILED | ✅ 覆盖 |
| P1-22 Stop 测试 | ✅ 覆盖（含端口不可连） |
| P1-23 重复 Stop | ✅ 覆盖 |
| P1-24 启动失败 | ✅ 覆盖 |
| P1-26 提前退出 | ✅ 覆盖 |
| **P1-25 无监听超时** | ❌ **未覆盖** —— 需要状态机/超时语义 |
| **P1-27～P1-29 连续 10 次 / 红线** | ❌ **未覆盖** —— 需要状态机 |
| P1-14～P1-18（状态枚举/转换/ProcessHandle/RunResult） | 仍 **BLOCKED**（改动只做了「可测化」，未引入状态机）|

## 六、本轮首次修改生产文件 —— 风险与回归

本任务是**第一次改动 `desktop/runners.js`**（此前只新增文件）。改动性质是**等价抽取**，
但按 RULE-01 必须回归：

- 纯 Node 侧：`test-runner-detect` / `test-url-detect` / `verify-url-regex` / `test-run-e2e` 全绿；
- **Electron 侧**：跑 `verify-run-dispatch.js`（它会真的点「跑测试」，走 `runner:run` IPC）
  —— 结果见 `changes/` 与提交说明。

**已知未消除的风险**：本机仍无法跑 `verify-run-url.js`（它依赖 `moon build --target native`，R12），
所以「Electron 壳里真的点运行 → 浏览器真的打开」这一段**依旧只能靠人**。本轮补的是**核心逻辑的自动验证**，
不是把 Electron 集成也自动化。
