# MoonBit IDE（桌面壳）

Electron + Monaco 的桌面壳，用 VS Code 当参照物逐步补齐「像样的后端 IDE」该有的东西。
差距分析与优先级见 [`COMPARISON.md`](./COMPARISON.md)。

## 运行

```bash
cd moonbit-platform/desktop
npm install
export PATH="$HOME/.moon/bin:$PATH"   # 让壳能找到 moon
npm start
```

## 文件

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程：窗口 + IPC（跑 `moon`、文件读写、找模块、选目录） |
| `fsops.js` | **纯 Node** 的文件能力（列目录/读/写/找 moon.mod/判语言），可用 `node` 单测 |
| `preload.js` | `contextBridge` 暴露 `window.moonAPI` |
| `index.html` | 布局：标题栏 + 侧边栏文件树 + 标签 + 编辑器 + 输出面板 + 状态栏 |
| `renderer.js` | 交互逻辑：文件树、多标签、打开/保存、命令面板、状态栏、跑 moon |
| `moonbit-lang.js` | 给 Monaco 注册 `moonbit` 语言（关键词/注释/字符串高亮） |

## 已实现（本轮 P0）

- ✅ **文件资源管理器**：侧边栏树，点开文件（跳过 `node_modules/.git/_build` 等）
- ✅ **多标签编辑器**：每个文件一个标签，可关闭
- ✅ **打开 / 保存**：`Ctrl+S` 保存（回写磁盘）；工具栏「打开文件夹」
- ✅ **命令面板**：`Ctrl+Shift+P`，过滤 + 方向键 + 回车（moon check/build/test/fmt/info、保存、打开文件夹…）
- ✅ **状态栏**：当前模块（`name@version`）、当前文件、最近消息
- ✅ **输出面板**：命令/退出码着色显示
- ✅ **MoonBit 语法高亮**：Monaco `moonbit` 语言

## 数据流

```
renderer.js ──(window.moonAPI.*)──> preload.js ──(ipcRenderer.invoke)──> main.js
                                                        ├── spawn "moon" ...
                                                        └── fsops.js（文件读写）
```

## 下一步（见 COMPARISON.md）

- P1：集成终端、`moon ide` 接 LSP（补全/跳转/诊断）、跨文件搜索、设置面板
- P2：后端面板（一键起服务、看 PG 表 / Redis key）、扩展点、调试

---

## 集成终端（本轮新增）

底部面板「终端」标签内嵌一个**真 PTY 终端**（xterm.js + node-pty，与 VS Code 同源技术栈）。

- 支持交互式命令、ANSI 颜色、窗口缩放自适应（`resize` 会同步给 PTY）
- **双后端**：优先 `node-pty`（真 PTY）；若原生模块不可用则自动回退到 `child_process`（管道模式），保证一定能用
- 退出时统一清理所有终端会话（防子进程泄漏）

### 安装注意（Windows）

`node-pty` 是原生模块，Electron 下必须 rebuild（ABI 匹配）：

```bash
npm install node-pty
npx @electron/rebuild -f -w node-pty
```

若报 `MSB8040：需要缓解了 Spectre 漏洞的库`（VS Build Tools 缺该组件）：

- 方案 A（本项目采用）：临时从 `node_modules/node-pty/binding.gyp` 与
  `deps/winpty/src/winpty.gyp` 移除 `'SpectreMitigation': 'Spectre'`，再 rebuild；
- 方案 B（更正规）：用 VS Installer 安装「MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs」。

### 自检

```bash
npm run test:term      # 在 Electron 里起真 PTY 执行命令并校验输出
# 期望：[test] ✅ 真 PTY 工作正常
```


---

## LSP 能力 / 跨文件搜索 / 后端面板（本轮新增）

### LSP 能力（不引入完整 LSP 客户端，复用 `moon` 自带语义命令）
- **诊断**：跑 `moon check --target native`，把错误/警告解析成 Monaco markers（波浪线 + 悬停消息），
  同时填进底部面板的「问题」列表（点击跳转）。
- **大纲**：`moon ide outline <file>` → 侧边栏「大纲」列表，点击跳到对应行。
- 保存文件后**自动**跑一次检查并刷新大纲。
- 解析器抽成 `lsp-parse.js`（纯函数，可单测）：`npm run test:lsp`。

### 跨文件搜索
- 侧边栏「搜索」框（输入防抖 250ms / 回车立即搜），遍历工作区文本文件，
  跳过 `_build` / `.git` / `node_modules` / `.mooncakes`，带**文件数/结果数/单文件大小上限**。
- 搜过的结果点击即跳到对应文件与行列。
- `search.js`（纯函数，可单测）：`npm run test:search`。

### 后端面板
- MoonBit 侧新增**只读管理服务** `admin/`（默认 `127.0.0.1:8081`）：
  - `GET /api/pg/tables`、`GET /api/pg/rows?table=&limit=`、`GET /api/redis/keys?pattern=`、`GET /api/redis/get?key=`
  - **表名是标识符不能参数化**，因此做了白名单字符校验（注入尝试实测返回 `400 invalid table name`）
- 桌面壳底部面板「后端」标签：列出 PG 表（点击看前 20 行）与 Redis keys（点击看值）。
- 请求走**主进程转发**（renderer 不能直接访问网络，且路径白名单限定 `/api/`），避免 CSP 放宽与 SSRF 面。

运行：`moon run --target native admin/cmd/main`（管理服务）→ 桌面壳「后端」标签。


### 符号补全 / 跳转定义（第三轮新增）

`moon-lsp` 能力很全（completion/hover/definition…），但**在本机始终返回 null**（试过大小写盘符 URI、等 9s、正确 capabilities 都不行）；
`moon ide peek-def` / `hover` 对本地 loc 一律报 `could not get package of loc`。因此改用**可用的 `gen-symbols`**：

```bash
moon ide gen-symbols --target native      # ⚠️ 必须带 --target native
```

- **⚠️ 关键**：`gen-symbols` **默认走 wasm target**，会**跳过 `supported_targets = "native"` 的包**（kernel/app/db/admin）——
  不带 `--target native` 只有 522 个符号（全是 wasm 可构建的包），带上后 **2246 个**（含 kernel/app）。
- 产出 `symbols.jsonl`（每行：kind/path/pkg/range/name_range）；`symbols.js` 负责解析与查询（纯函数，`npm run test:symbols`）。
- 桌面壳据此注册 Monaco：
  - **补全**（`registerCompletionItemProvider('moonbit')`）：按输入前缀匹配工作区符号
  - **跳转定义**（`registerDefinitionProvider`）：找到同名符号 → 跳到其文件与行列
- 另外实现了**轻量 LSP 客户端** `lsp-client.js`（LSP 帧编解码 + initialize/didOpen/completion/hover，`npm run test:lsp-client`，15 项，含与真实 `moon-lsp` 的握手）——为将来 `moon-lsp` 可用时预留。

依赖：`gen-symbols` 需要 `moon` 在 PATH；索引在首次打开工作区时自动生成并缓存 30s。


#### 悬停（hover）
`moon-lsp` 的 hover 与 `moon ide hover` 在本机都不可用，因此**降级实现**：
光标停在符号上 → 用 `symbols.jsonl` 找到同名符号 → 读其所在文件，提取
**文档注释 + 声明签名**（遇到 `{` / `=` 截断）→ 以 markdown 显示在 Monaco 悬停框里。

实测（`run_capture` / `build_router` / `find_header` 均正确显示文档与完整签名）。


## 启动方式

### 方式一：桌面快捷方式（推荐，双击即用）

```bash
powershell -ExecutionPolicy Bypass -File deploy/create-desktop-shortcut.ps1
```

会在桌面（和开始菜单）创建 **「MoonBit IDE」** 快捷方式。

- 快捷方式直接指向 `electron.exe`（GUI 程序），所以**双击不会闪出黑色控制台窗口**
- 双击后 IDE 会自动检查并拉起依赖容器（PostgreSQL / Redis），无需手动开终端

### 方式二：命令行

```bash
./启动IDE.sh            # 或 cd desktop && npm start
```

## 用 IDE 亲手启动后端（一键启停）

打开后：

1. 底部面板点 **「后端」** 标签
2. 点 **「▶ 启动后端」**
3. 日志区会实时显示：二进制路径 → 监听地址 → `[ready] /health → ok`
4. 顶部状态徽章由 `已停止` → `启动中…` → **`运行中`**（绿色）
5. 此时后端跑在 **http://127.0.0.1:8110**

工具栏功能：

| 按钮 | 作用 |
|---|---|
| ▶ 启动后端 | 检查依赖 → 定位/编译二进制 → 启动 → 轮询 `/health` 确认真的就绪 |
| ■ 停止 | 结束后端进程（Windows 下用 `taskkill /T` 连子进程一起收） |
| 编译 | 在 IDE 内执行 `moon build --target native --release` |
| 清空日志 | 清掉日志区的输出 |

设计要点：

- **就绪判定不是「进程起来了」，而是 `/health` 真的返回 `ok`** ——
  避免界面显示"运行中"但端口还没监听。
- **重复启动会被拒绝**，防止一不小心点出多个实例抢同一个端口。
- **依赖缺失先说清楚**：PostgreSQL / Redis 容器没起时，日志里直接给出启动命令，
  而不是让服务连不上库后抛一堆难懂的错。
- **日志节点有上限**（800 行），长期运行不会让 DOM 无限膨胀。

自动验证见 `desktop/test-backend.js`（19 项断言：依赖检查 / 启动 / 真实调 API /
重复启动被拒 / 停止 / 日志推送）。


---

## 附：快捷方式脚本的实现要点

`deploy/create-desktop-shortcut.ps1`

| 点 | 说明 |
|---|---|
| 目标 | 直接指向 `node_modules/electron/dist/electron.exe`，参数为 `.`，工作目录为 `desktop/` |
| 为什么不是 `npm start` | 那样会弹出一个控制台窗口；直接调 electron.exe 才是纯 GUI 启动 |
| 图标 | 用 Electron 自带图标（无自定义 .ico 时最省事） |
| 顺带 | 同时在开始菜单放一份，方便搜索启动 |
| ⚠ 编码 | 脚本必须存为 **UTF-8 with BOM** —— PowerShell 5.1 默认按 ANSI 读无 BOM 的 `.ps1`，中文注释会乱码并导致解析失败 |

## 附：启动时自动就绪依赖容器

`main.js` 的 `ensureDependencies()` 在窗口加载完成后执行：

1. `docker ps` 列出运行中的容器
2. 缺少 `mbp-pg` / `mbp-redis` 时：已存在则 `docker start`，不存在则 `docker run`
3. 等 6 秒（PostgreSQL 首次初始化需要时间）后把结果写进 IDE 的日志区

这样「双击快捷方式 → 点启动后端」是一条完整可用的路径，中途不需要开终端。


---

## 接口调试器（在 IDE 里直接调后端）

后端开发的闭环是「改代码 → 跑起来 → **调接口看对不对**」。
命令行 `curl` 能用但割裂；所以 IDE 内置了接口调试面板。

### 用法

1. IDE 启动后端（见上一节），或任意后端在 `http://127.0.0.1:8110`
2. 底部面板切到 **「接口」** 标签
3. 从下拉选一个端点（清单来自 `conduit/openapi.yml`，**19 个**）
4. 路径参数（如 `{slug}`）直接在路径框里改
5. 点 **「发送」** → 右侧显示状态码 / 耗时 / 响应体（JSON 自动美化）

### 贴心设计

| 点 | 说明 |
|---|---|
| **登录后自动填 token** | 响应里出现 `user.token` 时自动写进 token 框，后续受保护接口免手工复制 |
| **端点清单来自规范** | 解析 `conduit/openapi.yml`，改规范即改清单（不会和实现脱节） |
| **请求体模板** | 规范里写了 `example` 的端点会自动带出请求体，改两个字段就能发 |
| **请求走主进程** | 绕过浏览器 CORS、可跳过自签证书、能直接打 `https://` 的 nginx 入口 |
| **失败也说清原因** | 连不上会显示 `请求超时（15000ms）`，而不是静默无响应 |
| **响应体上限 512KB** | 防止超大响应把界面拖死 |

### 自动化验证

```bash
cd desktop && npm run test:api     # 17 项断言
```

覆盖：从 openapi.yml 解析出 19 个端点（方法分布 GET 7 / POST 6 / PUT 2 / DELETE 4）、
公开接口 200、注册返回 token、带 token 调受保护接口 200、不带 token 401、
创建文章并回读、404 错误体能看清原因、连不上时给出可读错误。

## UI 主题：对齐 Strapi 设计语言

IDE 的视觉从"VS Code 风"改成了 **Strapi Admin 风**，做法是 **token 驱动**而不是逐个改色值。

### token 从哪来

从桌面那个 Strapi 项目的设计系统里**实际提取**的，不是凭印象：

```bash
# 颜色（从打包产物里按频次提取）
grep -oE "#[0-9a-fA-F]{6}" node_modules/@strapi/design-system/dist/index.js | sort | uniq -c | sort -rn
# 结构 token（圆角/间距/字重）
cat node_modules/@strapi/design-system/dist/themes/common-theme.d.ts
```

拿到的事实：**品牌色 `#7b79ff`**、中性色阶 `#f6f6f9 → #181826`、
语义色 success `#5cb176` / danger `#ee5e52` / warning `#f29d41` / info `#66b7f1`、
**圆角统一 4px**、间距是 4 的倍数、字重只用 400/500/600。

### token 层

集中在 `index.html` 的 `:root` 里（`--s-*`），上层 CSS **只引用变量**：

| 组 | 变量 |
|---|---|
| 品牌色 | `--s-primary` `--s-primary-dark` `--s-primary-dim` |
| 中性色阶 | `--s-n100` … `--s-n1000` |
| 语义色 | `--s-success` `--s-danger` `--s-warning` `--s-info` `--s-alternative` |
| 圆角/间距/字重 | `--s-radius` `--s-space-1..6` `--s-fw-regular/semi/bold` |
| 语义映射 | `--s-bg-deepest` `--s-bg-panel` `--s-bg-raised` `--s-bg-hover` `--s-bg-active` `--s-border` `--s-text` `--s-text-dim` `--s-text-faint` `--s-text-bright` |

**为换主题留的口**：上层只引用「语义映射」那一组，想加浅色模式只需在
`:root[data-theme="light"]` 里重新映射这一组，组件 CSS 一行都不用改。

> ⚠ 两个踩过的坑：`#fff` 的 `replace_all` 会**按子串**命中 `#ffffff`（曾把
> `--s-text-bright: #ffffff` 改成 `var(--s-text-bright)fff`）；把
> `#f29d41` 也替换会写出 `--s-warning: var(--s-warning)` 的**自我循环**。
> 批量替换 token 时，**别把变量自己的定义值放进映射表**。

### 组件（按清单只做骨架需要的那些）

| 组件 | 实现要点 |
|---|---|
| **Panel** | 侧栏深底 + 底边框；面板标签**下划线式**（active 底部 2px 主色条） |
| **Tabs** | 同样下划线式（原来是 VS Code 的块状 + 顶部条） |
| **Button** | 主按钮实心主色；**次按钮改成描边式**（Strapi 的 secondary 就是描边，不是灰底）；字重 500 |
| **Tree** | 节点 hover/active 用 token；行高紧凑 |
| **EmptyState** | 空文件夹 / 无搜索结果时给标题 + 提示，不留白 |
| **Toast** | 右下角浮层，左边框按语义着色（success/danger/warning），自动消失，最多同时 4 条 |

另外：输入框**聚焦时主色 2px 描边**（Strapi 的显著特征）、滚动条改细并用中性色、
窗口 `backgroundColor` 也改成 `#181826`（否则启动瞬间会闪 VS Code 的灰）。

### Monaco 主题对齐（消除"两个世界"）

之前外围改成紫色了，**编辑器里还是 `vs-dark`** —— 视觉割裂。现在注册了 `strapi-dark`：

```js
monaco.editor.defineTheme('strapi-dark', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'keyword', foreground: '7B79FF' },  // --s-primary
    { token: 'string',  foreground: '5CB176' },  // --s-success
    { token: 'number',  foreground: 'F29D41' },  // --s-warning
    { token: 'comment', foreground: '666687' },  // --s-n600
    { token: 'type',    foreground: '66B7F1' },  // --s-info
  ],
  colors: {
    'editor.background': '#181826',              // --s-bg-deepest
    'editorError.foreground': '#EE5E52',         // 诊断色也对齐语义色
    // ...
  },
})
```

**实测证明无缝**：编辑器容器背景 / Monaco 内部背景 / 行号区背景
**都是 `rgb(24, 24, 38)`**（`#181826`），外壳背景也一致。

### 验收

```bash
cd desktop && ./node_modules/.bin/electron verify-strapi-final.js "<项目目录>"
```

13 项断言：Monaco 与外围无断层、Toast（颜色/圆角）、EmptyState、主/次按钮态。

---

## 关于「断点调试」（当前缺口，如实说明）

| 能力 | 状态 |
|---|---|
| 在 IDE 里调接口验证行为 | ✅ 已完成（接口面板） |
| 看服务日志 / 错误 | ✅ 已完成（后端面板日志区） |
| 看数据库 / Redis 实际数据 | ✅ 已完成（后端面板） |
| **源码级断点 / 单步 / 变量查看** | ❌ **未做** |

为什么没做：断点调试需要外部调试器接入。现状是：

- `moon build -g` **能生成调试信息**（已验证），所以 MoonBit native 二进制**是可调试的**；
- 但本机 **没有 gdb / lldb / cdb**（`command -v` 均未找到），
  Windows 下要走 MSVC 工具链的话还需要 Windows SDK 的 Debugging Tools；
- MoonBit 官方 VS Code 扩展也未安装（`~/.vscode/extensions` 下没有）。

要补这块，路径是：装 `cdb` 或 `lldb` → 用 **DAP（Debug Adapter Protocol）** 接一层
→ IDE 用 DAP 客户端驱动（Monaco 已经有断点/调用栈的 UI 基础，VS Code 那边也是这么做的）。
这是一项独立工作量，没有在这轮里假装做成。


---

## 用这个 IDE 打开**别的**项目

IDE 不只能开本仓库 —— 它也支持命令行指定目录：

```bash
cd desktop
./node_modules/.bin/electron . "<项目目录>"
```

桌面也加了一个入口：**「用 MoonBit IDE 打开 Strapi」**（指向 `Desktop\strapi-backend`）。

### 打开非 MoonBit 项目时的能力边界（实测）

以桌面的 **Strapi 后端项目**（Node/TypeScript）为例：

| 能力 | 是否可用 | 说明 |
|---|---|---|
| 文件树 / 多标签 / 编辑 / 保存 | ✅ | 通用，与项目类型无关 |
| 语法高亮 | ✅ | `.ts/.js/.json/.yml/.md` 等已映射到 Monaco 语言 |
| 集成终端 | ✅ | 真 PTY，与项目无关 |
| 跨文件搜索 | ✅ | 通用 |
| **补全 / 跳转 / 悬停** | ❌ | 基于 MoonBit 的 `symbols.jsonl` 索引，对非 MoonBit 项目不适用 |
| **后端面板一键启停** | ❌ | 针对本仓库那套 MoonBit 后端（需 `_build` 下的二进制） |
| **接口面板** | ❌ | 端点清单来自 `conduit/openapi.yml`，其它项目没有 |

### 关键改进：识别项目类型 + 优雅降级

以前打开别的项目时，这些能力会**静默失效**（面板空白、按钮点了没反应），容易误以为"坏了"。
现在 `project-detect.js` 会识别项目类型并在界面上**说清原因**：

- 状态栏左侧显示 **`项目：MoonBit 模块`** / **`项目：Node / JavaScript 项目`**（非 MoonBit 时显示为橙色）
- 鼠标悬停状态栏可看到完整的能力清单
- 「后端」「接口」面板顶部会插入一行说明，例如：
  > ℹ 接口面板的端点清单来自 conduit/openapi.yml，当前项目下没有这个文件

识别顺序：`moon.mod.json` → MoonBit；`package.json` → Node；`pyproject.toml`/`requirements.txt`/`manage.py` → Python；
`Cargo.toml` → Rust；`go.mod` → Go。

验证：`cd desktop && node test-project-detect.js` → **12/12**（含 Strapi 与 MoonBit 两个真实项目）。


---

## 踩过的两个「界面看起来只是个壳子」的坑（已修）

这两个问题的共同点是：**界面能打开、按钮都在，但核心功能全废**，而且完全静默。

### 1. 编辑器根本不出现 —— MoonBit 语言定义里一行正则引发崩溃

`moonbit-lang.js` 里这行是从 VS Code 的 Monarch 示例抄来的：

```js
[/[<>](?!@symbols)/, '@brackets'],
```

它引用了语言配置里的 `symbols` 属性，但我们从未定义 → Monaco 直接抛：

```
moonbit: language definition does not contain attribute 'symbols', used at: ^(?:[<>](?!@symbols))
```

→ `monaco.editor.create()` 失败 → **编辑器连 DOM 都建不出来**。

而且这行**语义上也是错的**：MoonBit 泛型用 `Array[String]`（方括号），`<` `>` 是比较运算符不是括号。
修复就是删掉它（`<>` 已由后面的 operator 规则覆盖）。

> 教训：`create()` 抛错时界面**没有任何提示**。后来加了 try/catch + 把错误写进「输出/问题」面板，
> 这类问题才能一眼看到。

### 2. 终端永远空白 —— UMD 包被 Monaco 的 AMD `define` 截胡

`xterm.js` 是 UMD 包，分支判断是：

```
有 exports/module → CommonJS
有 define.amd     → AMD          ← 走了这条
否则              → 挂到 window
```

而 `index.html` 里 Monaco 的 `loader.js` **先加载并定义了全局 `define`** →
xterm 被当成 AMD 模块注册 → **`window.Terminal` 永远不存在** → 终端面板一直是空的。

修复：**把 xterm / addon-fit 的 `<script>` 放到 loader.js 之前**（那时还没有 `define`）。

### 3. 核心初始化不能依赖 Monaco（架构修正）

上面两个问题还叠加了一个更严重的：`wireUI()` / `boot()`（加载文件树）/ 各个面板的初始化
**全都写在 Monaco 的加载回调里** —— Monaco 一失败，**文件树、按钮、面板全废**。

现已把核心初始化独立成 `initCore()`，与 Monaco 解耦：

```js
// renderer.js 末尾
function initCore() {
  step('installErrorReporting', ...)   // 前端错误兜底
  step('wireUI', ...)                  // 按钮/面板绑定
  step('initBackendControl', ...)      // 一键启停
  step('initApiDebug', ...)            // 接口调试器
  step('refreshProjectInfo', ...)      // 项目识别
  window.moonAPI.defaultCwd().then(boot).catch(...)  // 打开起始目录
}
```

每一步独立 try/catch —— **一个失败不影响其他**。Monaco 只管编辑器本身，加载失败也不拖垮别的。

### 4. 前端错误兜底（新增）

以前渲染层任何异常都是**静默的**，界面某块不工作时用户只能干看着。
现在统一抓到「问题」面板显示（含文件:行号），状态栏也会提示。

## 其它已记录的事项

- **`AttachConsole failed` 刷屏**：node-pty 在 Windows 上执行 `kill()` 时会 fork 一个子进程
  去枚举 console 进程树，而那时 shell 刚被杀掉 → `AttachConsole` 必然失败。
  **它发生在子进程里**（不是主进程），不影响功能；只能等 node-pty 自身修。
- **`desktop/e2e-shots/`** 里有自动操作时留下的截图，便于回看界面状态。
