# Phase 2 / run-url 换靶子 —— 顺带挖出一个「孤儿进程」真缺陷

> 触发：Gate M1-A 剩两项（run-url 5/5、demo rehearsal）卡在 **R12**。
> 用户选定路径：**把 Run E2E 的验证与 MoonBit native 工具链解耦**（先把单测挂 CI，再把 `verify-run-url.js` 的靶子换掉）。
> 执行时间：2026-09-24（+08:00）

## 一、为什么要换靶子（RULE-03）

`verify-run-url.js` 原来拿 MoonBit `hello` 当靶子 → 必须 `moon build --target native` 成功 →
本机工具链一坏（R12），这个测试**永远是红的**，于是**真正的 Run 链路回归被掩盖**。

但它要验的其实是「**IDE 的 Electron 集成链路**：点运行 → 抓 URL → 开浏览器 → 页面可访问 → 停得掉」，
不该被「本机 MoonBit 工具链是否可用」绑住。

**改法**：靶子换成 `desktop/testdata/fixture-http-server.js`（零依赖 Node 服务、端口由系统分配）；
①（入口识别）仍扫真实项目目录（只扫文件，不依赖构建）。

副作用（好的）：跑得也快了 —— 从「25 秒超时」变成 **0.6 秒拿到 URL**。

## 二、换靶子过程中挖出的**产品真缺陷**（本轮最有价值的发现）

新加的一条断言「停止后端口不再可连」**红了**，于是顺着证据链查下去：

| 步骤 | 证据 |
|---|---|
| ① stop 到底调没调？ | `runnerStop() → {"ok":true,"signal":"SIGTERM","status":"STOPPING"}` —— 调了 |
| ② 端口真的还开着吗？ | PowerShell 独立核对：`127.0.0.1:55041` 仍被 **PID 5340** 监听 |
| ③ 是 kill 本身失效吗？ | **对照实验**：同一段 spawn+kill 代码，用 `node` 跑和用 `electron` 跑，**都是 `alive=false`** → kill 没问题 |
| ④ 那杀的是谁？ | `spawn-util.js:36` `needsShell = /\.(cmd\|bat)$/i.test(s) \|\| !path.extname(s)` |

**根因**：

```js
// bin: 'node'（不带扩展名）→ 走 shell:true → 实际起的是 cmd.exe 包一层
// child.kill() 杀掉的只是 cmd.exe，真正的服务进程成为孤儿，继续监听端口
```

**影响面（关键）**：IDE 里跑 Node 项目用的正是 `bin: 'npm'` —— **同样不带扩展名** →
**真实用户路径上，「点停止」会留下一个孤儿服务进程**。「0 僵尸」这条红线在真实场景下**不成立**。

（纯 Node 的 E2E 之所以没抓到：那里传的是 `process.execPath`（带 `.exe`）→ 不走 shell → 看不出问题。
这说明**测试的靶子选择本身也会决定能不能发现缺陷**。）

### 修复

新增 `killTree(child, signal)`（`spawn-util.js`）：

```js
if (process.platform === 'win32' && child.pid) {
  const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  if (r && r.status === 0) return true            // /T = 连整棵进程树
}
return child.kill(signal)                          // 其它平台走原路
```

- `createServiceRunner` 的 `kill` 与兜底强杀都改走 `killTree`；
- 另加 **`stopGraceMs`（默认 3000ms）兜底强杀** —— 原来只有 SIGTERM，遇到「不理会信号 / 被 keep-alive 拖住」的服务会留僵尸。

> Windows 上 Node 的 `child.kill()` 本就是 TerminateProcess（子进程的 `process.on('SIGTERM')` 根本不会触发），
> 所以改用 `taskkill /T /F` **不丢什么优雅性**，却拿回了「整棵树都停掉」这个真正的语义。

## 三、第二个小修复：fixture 被 keep-alive 拖住

`fixture-http-server.js` 原来 `SIGTERM → srv.close(() => exit())`，
而 `srv.close()` **会等待现有连接结束** —— 客户端（IDE / fetch）默认 keep-alive → 进程迟迟不退。

改为：先 `closeAllConnections()`，再 `close()`，最后 300ms 兜底 `exit(0)`。

## 四、验证

| 项 | 结果 |
|---|---|
| `npx electron verify-run-url.js` | **5 通过 / 0 失败**（原来 3/5；且耗时从 25s 降到 0.6s）|
| 独立核对（PowerShell `Get-NetTCPConnection`） | 停止后该端口监听数 = **0** |
| `node test-run-e2e.js` | **51 通过 / 0 失败**（从 47 扩到 51，新增 ⑰ 兜底强杀、⑱ shell 孤儿）|
| 纯 Node 全量 | `runner-detect` 18 / `project-detect` 12 / `relay` 25 / `url-detect` 29 / `run-state` 48 —— 全 0 失败 |
| `check-empty-catch --ci` | **94 ≤ 基线 95** |
| `npm run verify:demo` | **7 步通过 / 0 步失败**（「运行项目」那一步从 31.9s 失败 → **8.8s 通过**）|

## 五、Gate M1-A 复评

| 要求 | 之前 | 现在 |
|---|---|---|
| run-url 5/5 | ❌（被 R12 阻塞） | ✅ **5/5** |
| run-dispatch 5/5 | ✅ | ✅ |
| 错误项目 PASS | ✅ | ✅ |
| timeout PASS | ✅ | ✅ |
| Run × 10 PASS | ✅ | ✅ |
| Run/Stop × 10 PASS | ✅ | ✅（并新增兜底强杀与 shell 孤儿两组断言）|
| demo rehearsal 不再因 run-url 失败 | ❌ | ✅ **7 步通过 / 0 步失败** |

### ✅ **Gate M1-A = 7/7 通过**

连带效果：**P1 全系列（P1-01～P1-29）至此全部 PASS** → 按 Gate A，可以开始 **P2（ProjectContext）**。

> **R12 本身没有消失**（本机 MoonBit native 构建仍然是坏的），但**它已经不再阻塞任何门禁** ——
> 因为 Run 链路的验证已经与 native 工具链解耦（纯 Node E2E + CI + 零依赖靶子）。

> **「测试靶子的选择」本身的教训**：纯 Node E2E 用带 `.exe` 的 bin，绕过了 `shell:true` 这条真实路径，
> 所以「0 僵尸」一直是绿的 —— 直到换成不带扩展名的 `'node'`（等价于真实的 `'npm'`）才暴露。
> 测试要与**真实调用路径**同构，否则绿灯是假象。
