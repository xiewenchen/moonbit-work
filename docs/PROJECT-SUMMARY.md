# MoonBit 后端开发平台 + 桌面 IDE —— 项目全貌

> 用途：交接 / 回顾 / 申报素材。最后更新 2026-09-23。
> 所有数字均可复核，复核命令写在每节末尾。

---

## 一、背景与目标

**用户要的东西**（原话归纳）：
1. 一个**用纯 MoonBit 从零实现**的、兼容主流后端技术栈的开发平台；
2. 配一个**桌面 IDE**（对标 VS Code），要能**打开本机任意项目、编译运行、看到真实结果**；
3. IDE 分**多个标签**：主菜单（办公组件）、项目（代码）、文件中转站、AI Agent、工具；
4. 已参加 MoonBit 赛事，需满足章程（commits / 公开仓库 / mooncakes 发布 / 申报书）。

**明确排除的路线**（早期就否决）：
- 不做 `wasm` 调用主流语言的 FFI 包装（曾验证可行性，但放弃了）；
- 不做"两个项目的对比"式选题；
- 数据访问坚持**原生 SQL**，不造 ORM。

---

## 二、技术架构

```
协议层（零依赖，wasm-gc 可测）   redis/resp  http/http  pg/message
        ↓
连接层（仅 native）              redis/client  http/server+client  pg/client
        ↓
应用框架层（native）             app/  Config · Router · 中间件 · JWT · 限流 · 指标
        ↓
工具链                           db/(迁移)  bench/(压测)  cluster/(多进程)
        ↓
示例与验证                       notes/  demo/  conduit/(RealWorld)  sec/(靶场)  admin/(只读面板)
        ↓
桌面 IDE（Electron + Monaco）    desktop/  62 个 JS 文件
```

**重要事实**：桌面 IDE 是 **Electron + JavaScript** 实现的，**不属于 MoonBit 交付物**，是配套开发工具。申报材料里必须这样标注。

---

## 三、代码规模（实测）

| 项 | 数量 |
|---|---|
| MoonBit 包 | **28** 个 `moon.pkg` |
| MoonBit 源码 | **11209** 行 `.mbt` |
| 桌面 IDE | **65** 个 `.js` 文件 |
| git commits | **31** |
| 文档 | **11** 份（`docs/*.md`）|

**顶层模块**：`admin app bench cluster cmd conduit db demo deploy desktop docs http ide-backend kernel logs notes pg redis sec tools`

复核：
```bash
cd moonbit-platform
find . -name 'moon.pkg*' -not -path './_build/*' -not -path './.mooncakes/*' | wc -l
find . -name '*.mbt' -not -path './_build/*' -not -path './.mooncakes/*' | xargs wc -l | tail -1
find desktop -name '*.js' -not -path '*/node_modules/*' | wc -l
git log --oneline | wc -l
ls docs/*.md | wc -l
```

---

## 四、各模块现状

### 4.1 MoonBit 侧 —— 基本完整

| 模块 | 内容 | 状态 |
|---|---|---|
| `http/` | HTTP/1.1 协议 + 服务端（路由/中间件/keep-alive/超时限额/TLS）+ 客户端 | ✅ |
| `redis/` | RESP 协议解析 + 连接池 + 命令层 | ✅ |
| `pg/` | PostgreSQL v3 线协议 + SCRAM-SHA-256/MD5 + SSL 握手 + 类型系统 + 事务 | ✅ |
| `app/` | Config / Router / 中间件 / JWT(HS256) / 令牌桶限流 / Prometheus 指标 | ✅ |
| `db/` | SQL 迁移（幂等、事务包裹、按文件名升序） | ✅ |
| `bench/` | 压测（p50/p95/max） | ✅ |
| `cluster/` | 多进程启动器 | ✅ |
| `kernel/` | 工程模型 + `moon` 工具链编排 | ✅ |
| `conduit/` | 按 RealWorld 规范的后端（19 端点） | ✅ 通过官方 hurl 套件 13/13 |
| `sec/` | 安全靶场（装全中间件，限流设小）+ `attack.py`（14 小节 / 18 断言） | ✅ |
| `admin/` | 只读管理面板（PG 表 / Redis key） | ✅ |
| `notes/` `demo/` | 示例服务 | ✅ |
| `ide-backend/` | MoonBit 编译到 JS 的 JSON-RPC 后端 | ✅ |

**测试**：`moon test --target native` → **156 通过 / 0 失败**；`moon check --deny-warn` 无警告。

### 4.2 桌面 IDE —— 逐项现状

**✅ 完整**：
- 项目工作台：文件树、多标签编辑、Monaco、命令面板、状态栏
- 跨文件搜索、大纲
- **集成终端**（xterm + node-pty 真 PTY，双后端回退）
- 后端面板（一键启停 + 就绪探针 + 日志）
- 接口调试器（从 `openapi.yml` 解析端点，登录后自动填 token）
- **运行链路**：识别入口 → 运行 → 流式输出 → 从输出抓 URL 自动开浏览器
- 问题面板 + 运行时堆栈行高亮
- **文件中转站**（Office 文档备份 / 版本 / 还原，自写 ZIP 元信息解析）
- 主菜单办公组件（时钟/待办/日历/便签/日程，可拖拽、localStorage 持久化）
- 主题：日间/夜间/自动（Monaco 跟随）
- LSP 客户端：补全 / 跳转 / 悬停 / 引用 / 大纲 / 重命名 / 诊断
- 工具标签（6 个工具入口卡，点击切到对应面板）
- **AI Agent 标签**（P1 补上）：`aiagent.js` 对话界面（输入框 / Ctrl+Enter 发送 / 停止 /
  状态行 / 流式文本 / 错误提示），后端 `agent.js` 接 opencode —— 已实测收到回复正文

**⚠️ 半成品**：
- LSP 的 hover/跳转依赖本机 `moon-lsp`，部分能力走符号索引降级

**❌ 未做（AI Agent 的刻意边界）**：
- 多轮对话、模型切换、token 统计
- 调试器（断点）

---

## 五、交付状态

| 项 | 状态 |
|---|---|
| **mooncakes 发布** | ✅ 已上线：`xiewenchen/moonbit-platform@0.1.0` |
| **GitHub 仓库** | ✅ 公开：`xiewenchen/moonbit-work`（29 commits） |
| LICENSE | ✅ Apache-2.0 |
| CI | ✅ `.github/workflows/ci.yml` |
| 申报书 | ✅ `docs/SUBMISSION.md` |
| 查重与差异说明 | ✅ `docs/DIFFERENTIATION.md`（**如实承认**与 `moonbitstack` 系列重合） |

**发布过程中的坑**（都已解决，记在这里避免重踩）：
1. **mooncakes 要求模块名以账号名开头** —— `mbp/platform` → `xiewenchen/moonbit-platform`（改动 = `moon.mod` + 22 个 `moon.pkg` 里 55 处 import + 1 个测试断言）
2. **GitHub `workflow` scope** —— 缺它会**整体拒绝** push（不是部分失败）；需 `gh auth refresh -s workflow`
3. **git 代理配置失效** —— `~/.gitconfig` 与系统代理都指向 `127.0.0.1:7890`；代理没开时全超时
4. Git Bash 的 `/dev/tcp` 检测端口**不可靠**，要用 `curl -x` 实测

---

## 六、运行环境的已知边界（不是 bug）

| 情况 | 现象 |
|---|---|
| Node 项目未 `npm install` | `npm run dev` 报模块缺失，IDE 不自动装依赖 |
| 项目需要 `go` | 本机未安装 go |
| MoonBit 入口是 js/wasm target | 运行命令一律带 `--target native`，这类入口会失败 |
| 项目启动不打印 URL | 不会自动开浏览器，但输出面板里能看到地址 |

---

## 七、我做错的地方（如实记录）

### 7.1 把"我的测试环境能跑"当成了"能跑"

`spawn('moon')` 一直失败，因为**从桌面快捷方式启动时 PATH 不含 `~/.moon/bin`**。我所有测试都从 Git Bash 启动 Electron（PATH 恰好带着），所以这个 bug 长期被掩盖。**用户看到的现象是"任何项目都跑不起来"**。

修复：`main.js` 启动时主动补 PATH。A/B 对照验证过（不修补 → `ENOENT`）。

### 7.2 同一个 `spawn` 坑踩了三次

Node 在 Windows 上**不能直接 spawn `.cmd`/`.bat`** → `EINVAL`。而 `npm`、npm 全局装的 `opencode` 都是 `.cmd`。
- 尝试 1（换 `cmd.exe` + 参数数组）：失败 —— cmd 拿空格当分隔符
- 尝试 2（自己拼命令行按数组传）：失败 —— Node 再转义一次，引号加倍
- 尝试 3（整条命令作字符串 + 空 args + `shell:true`）：成功

抽成 `spawn-util.js`，`runners.js` 与 `agent.js` 共用。

### 7.3 "无项目态"做过头（用户明确指出）

用户要的是：**没项目时只影响「项目」这一个标签**，主菜单/中转站/工具照常可用。
我第一版写成**全局 `body.no-project`**，把 `#body`/`#panel` 一起锁了 → **其它标签的功能入口点进去一片空白**。

已修：CSS 收窄为 `body.no-project[data-view="project"]`；工具标签的卡片在无项目时**改为提示"请先打开项目"**；未打开项目时**忽略上次记忆的标签、强制落在主菜单**。

### 7.5 P1 期间又暴露两个真缺陷（都已修）

**`agent.js` 的 args 从未包含 `--format json`**（只在注释里写了）。opencode 默认输出人类可读
文本，下游那段 JSON 事件解析全部落空 —— 界面只会得到一个空气泡。实测：修复前 `busy` 归
`false` 但气泡为空；补上参数后正确收到回复正文。**教训：注释里写了不等于代码里写了。**

**`renderer.js` 的初始化时序**：`initActivityBar` 用 `body.no-project` 类判定「有没有打开
项目」，但它在 `showWelcome()`（由后者添加该类）**之前**执行，所以「无项目时强制落主菜单」
一直失效。改用权威状态 `rootDir` 判定。

### 7.6 测试脚本之间会互相污染

`verify-agent-ui` 点击标签会写 `localStorage['moonbit-view']`，导致后续 `verify-welcome`
误报（启动落在别的标签，欢迎页本就不该显示）。已在两个脚本里显式清理，`verify-welcome`
也改成先切到「项目」标签再断言 —— **测试不应依赖上一次运行留下的状态。**

多次出现"改完没跑验证就往下走"（如 stdio 修复、`askMask` 进产物）。用户对此明确不满。**本项目里凡是没实测过的改动，都应视为未完成。**

---

## 八、下一步（按优先级）

| 优先级 | 事项 | 状态 |
|---|---|---|
| P0 | 验证「无项目态」修正 | ✅ 完成（53e7bb4）：转译幂等 + verify-welcome 三场景实测通过 + e2e 23 PASS |
| P1 | AI Agent UI | ✅ 完成（081cf27）：新增第 5 个标签 + 对话界面；顺带修掉 2 个真缺陷（见 7.5）|
| P2 | 补 `docs/` 与 README 的复核命令 | ✅ 完成：申报书第六节复核表补齐，README 重写 |
| P3 | 调试器 | ✅ 已评估（结论：**不可行**）：Windows 上 MoonBit native 走 MSVC → 调试信息是 PDB 无 DWARF，`llvm-dwarfdump` 读不出；官方也不支持 MinGW、无 `moon debug`/DAP。详见 `docs/DEBUGGER-FEASIBILITY.md` |

---

## 九、给接手者的最短上手路径

```bash
# 1. MoonBit 工具链（已装则跳过）
export PATH="$HOME/.moon/bin:$PATH"
moon version

# 2. 编译与测试
cd moonbit-platform
moon check --deny-warn --target native
moon test --target native          # 期望 156 通过

# 3. 启动桌面 IDE（注意：必须从 desktop/ 目录）
cd desktop && npm start            # 或双击桌面「MoonBit IDE」快捷方式

# 4. 改 UI 的注意：界面是**转译**出来的
#    改 ide-source.html → 跑 node translate-strapi.js → 生成 index.html
#    （index.html 是产物，直接改它会被下次转译覆盖）

# 5. 桌面端回归
cd desktop && npx electron e2e-features.js "<项目目录>"   # 期望 23/23
```
