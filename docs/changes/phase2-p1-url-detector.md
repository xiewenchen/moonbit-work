# Phase 2 / P1-07 ～ P1-13：URL Detector 抽离与单测

> 对应任务：**MBW-P1-07 ～ MBW-P1-13**｜规则：RULE-01 / RULE-02 / RULE-04（渐进迁移）
> 执行时间：2026-09-24（+08:00）

## 一、现状（RULE-03：修改前必须知道修改对象）

| 项 | 值 |
|---|---|
| 原实现位置 | `desktop/runners.js:255-267`，内联在 `ipcMain.handle('runner:run')` 的 `onChunk` 闭包里 |
| 正则 | `runners.js:262` `/https?:\/\/(?:localhost\|127\.0\.0\.1\|\[::1\])(?::\d+)?[^\s'"<>)]*/i` |
| ANSI 剥离 | `runners.js:260` |
| 跨 chunk 累积 | `runners.js:261` `buf = (buf + clean).slice(-2048)` |
| 去尾标点 | `runners.js:265` |
| 只触发一次 | `runners.js:254/264` 的 `opened` 标志 |
| 同逻辑副本 | `desktop/verify-url-regex.js:3`（同一正则 + 同一 stripAnsi） |
| 调用链 | 子进程 stdout/stderr → `onChunk` → 累积 → 匹配 → `send('runner:url')` + `shell.openExternal` |

**问题位置（为什么要抽离）**：
1. 检测逻辑与 IPC/Electron 耦合 → 无法脱离 Electron 单测；
2. 正则存在**两份副本**（runners.js 与 verify-url-regex.js），易漂移；
3. P1-11/12/13 三块此前**既无契约也无测试**（多 URL 取哪个、非法形态、重复 URL）。

## 二、修改边界

| 类别 | 内容 |
|---|---|
| **允许修改** | 新增 `desktop/url-detect.js`、新增 `desktop/test-url-detect.js`、`docs/` |
| **禁止修改** | `desktop/renderer.js`、`desktop/main.js`、**`desktop/runners.js`**（迁移留到 P1-19，符合 RULE-04 渐进迁移） |

## 三、产出

### 新增 `desktop/url-detect.js`（纯逻辑，不依赖 Electron）

导出：`LOCAL_URL_RE`、`stripAnsi`、`trimTrailingPunctuation`、`portOf`、`pickUrl`、`findAll`、
`detectUrl(text, opts)`、`createUrlScanner(opts)`。

**行为与生产保持一致**（P1-19 接线前不改语义）：只认 `http(s)://` + host ∈ {localhost, 127.0.0.1, [::1]}；
剥 ANSI；跨 chunk 累积（默认末 2048 字节）；去尾标点；命中一次即 `opened`。

**新引入的可注入规则（P1-11）**：`pickUrl` 支持 `preferPorts` ——
给了就优先选端口匹配的 URL，无匹配则回退第一个。「项目运行规则」由 Runner 在 P1-19 注入，
本模块不猜项目类型。

### 新增 `desktop/test-url-detect.js`（纯 Node，26 项）

| 组 | 覆盖 | 项数 |
|---|---|---|
| P1-08 | 单 chunk、句末标点 | 2 |
| P1-09 | 跨 3 段拼接 + 拼接对照 | 2 |
| P1-10 | ANSI 包裹、URL 后紧跟 ANSI、stripAnsi 幂等 | 3 |
| P1-11 | 默认取第一个 / preferPorts 命中 / preferPorts 落空回退 / 单数形式 / portOf | 6 |
| P1-12 | `localhost:`、`http://`、`http://foo`、无端口、尾冒号、外网地址、空输入、null | 8 |
| P1-13 | 首次命中 / 重复不触发 / opened / reset 复用 | 4 |
| 防漂移 | **`url-detect.js` 的正则 === `runners.js:262` 的正则** | 1 |

## 四、验证（RULE-01：写完 + 测试 + 回归 + 结果记录）

```bash
cd desktop && node test-url-detect.js
```

**结果：26 通过 / 0 失败 / 共 26 项（exit 0）**

关键是**防漂移断言**：它读 `runners.js` 源码，把 `buf.match(...)` 里的正则字面量取出来，
与 `url-detect.js` 的 `LOCAL_URL_RE.source` 做**逐字符比较** —— 两份副本一旦漂移立刻失败。

**回归**：`desktop/runners.js`、`main.js`、`renderer.js` **零改动**（`git status` 可验），
`verify-url-regex.js` 复跑仍 **8 通过 / 0 失败**。新增文件当前无任何生产代码引用 →
不存在运行时行为变化（符合 RULE-04：先建新接口 + 测试，再迁移调用点）。

## 五、未做（明确留给后续任务）

| 项 | 归属 |
|---|---|
| 把 `runners.js` 的 `onChunk` 改为调用 `url-detect.js`（接线） | **P1-19** |
| 让 Runner 按项目类型注入 `preferPorts`（真正的「项目运行规则」） | **P1-19** |
| 把 `test-url-detect.js` 挂进 CI 的桌面纯逻辑测试段 | 待排（CI 改动属另一任务） |
| `verify-url-regex.js` 改为 require `url-detect.js`（消除第二份副本） | P1-19 一并处理 |

## 六、已知边界（如实记录）

1. **端口未做范围校验**：`http://localhost:99999` 也会被匹配（与生产现状一致，P1-19 再决定是否收紧）。
2. **IPv6 端口不解析**：`portOf('[::1]:8080')` 返回 `null` → 该类 URL 在 `preferPorts` 规则下不参与匹配。
3. **`opened` 后不再检测新 URL**：即同一进程后续出现**另一个** URL 也不会触发（保持现状语义，P1-19 再评估）。
