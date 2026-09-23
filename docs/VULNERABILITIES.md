# 漏洞清单（系统化审计）

以**专业漏洞挖掘**方式对平台做的系统化审计：先枚举攻击面，再按 CWE/OWASP 类别用**并行子代理**
分块深挖 + 人工验证 + fuzz，最后逐条修复。

- 审计范围：`http/` `redis/` `pg/` `app/` `db/` `cluster/` `kernel/` `desktop/` + 配置/CI/容器
- 已完成轮次：实战测试 → 代码审计 → 安全测试 → panic 审计 → fuzz → 安全审查 → **本清单**
- **累计发现并修复 41 个缺陷**（含 1 个远程 DoS 崩溃、2 个 CPU 挂死、2 个注入、2 个资源泄漏）

---

## 一、攻击面枚举

| 面 | 入口 | 信任边界 |
|---|---|---|
| HTTP 服务端 | `http/server`（accept → 解析 → 路由 → 中间件） | **不可信**（公网/局域网客户端） |
| HTTP/Redis/PG 客户端 | 连到外部端点后解析对方报文 | **不可信**（对端可能恶意） |
| PG 认证 | `pg/sasl`（服务端返回的 server-first-message 等） | **不可信** |
| 配置 | `app::Config::from_env`（`MBP_*`） | 半可信（部署方） |
| 迁移 | `db/migrate`（目录 + 文件内容） | 半可信（仓库内容） |
| 进程编排 | `kernel`（`moon` / `moon ide` 子进程） | 半可信（工程路径来自用户） |
| 桌面壳 | `desktop`（IPC：renderer → main） | **不可信**（renderer 一旦被 XSS 即可控） |

---

## 二、已修复缺陷（按严重度）

### 🔴 CRITICAL / HIGH

| # | 位置 | 缺陷 | 影响 | 修复 |
|---|---|---|---|---|
| 1 | `pg/message.mbt` `decode_chunked` 系 / `http` `decode_chunked` | chunk size 32 位**溢出为负** → 解析位置回退 → `input[负数]` **panic** | **远程可让服务进程崩溃（DoS）** | 溢出阈值 + 负数校验 + 位置前进断言 |
| 2 | `db/migrate.mbt` | 迁移按**降序**执行（`0002_seed` 先于 `0001_create`）| 迁移失败 / 状态错乱 | 显式反转（实测 `sort=true` 为降序） |
| 3 | `db/migrate.mbt` | 注释声称「失败整体回滚」，实际**无事务** | SQL 执行了但未记录 → 半应用状态 | 包进 `with_transaction` |
| 4 | `pg/client/pool.mbt`、`redis/client/pool.mbt` | `sem.acquire()` 后**建连失败** → 名额不归还 | 池被永久耗尽（远程可触发的 DoS） | `errdefer self.sem.release()` |
| 5 | `http/server` `serve_tls*` | TLS 握手失败/处理中抛错时 socket **未关闭** | fd 泄漏，长期耗尽 | `defer tls.close()` + `errdefer tcp.close()` |
| 6 | `app/auth.mbt` `sign_jwt` | claim 键值**不转义** | **注入伪造 claim**（提权） | `json_escape_str` |

### 🟠 MEDIUM

| # | 位置 | 缺陷 | 影响 | 修复 |
|---|---|---|---|---|
| 7 | `redis/resp.mbt` | 数组**递归无深度上限** | 深层嵌套 → 栈溢出 | 深度上限 64 |
| 8 | `http/server` `serve_accept_loop` | 无并发连接上限 | 连接洪泛耗尽 fd/内存 | 上限 1024，超出直接关闭 |
| 9 | `pg/sasl.mbt` `pbkdf2_sha256` | `iterations` 取自**服务端**且无上限 | 恶意 PG 令其巨大 → **CPU 挂死** | 上限 50000 |
| 10 | `pg/types.mbt` `parse_double_str` | `exp` 无上限驱动循环 | `1e2000000000` → **CPU 挂死** | 饱和 + 幂次上限 400 |
| 11 | `pg/message.mbt` | `pos+1+len` / `pos+len` **溢出为负** | 绕过长度检查 | 改减法比较 |
| 12 | `redis/resp.mbt` | `len.to_int()` 截断 + `next+l` 溢出 | 绕过长度检查 | Int64 比较 |
| 13 | `kernel/kernel.mbt` | 参数**注入**：`file`/`symbol`/`target` 以 `-` 开头会被当**选项** | 可触发非预期行为 | `--` 终止 + 前缀校验 |
| 14 | `kernel/kernel.mbt` `parent_of` | 只识别 `/`，**Windows 下失效** | 路径边界判断错误 | 同时识别 `\` 与 `/` |
| 15 | `http/http.mbt` `decode_chunked` | chunked **trailer 长度不计入上限** | 占内存 | trailer 累计上限 |
| 16 | `Dockerfile` | **以 root 运行** | 容器逃逸后影响放大 | `USER appuser` |
| 17 | `Dockerfile` HEALTHCHECK | `CMD ["/usr/local/bin/app"]` → **会再启动一遍应用** | 探针错误、起多个进程 | 改为 `curl -f /health` |
| 18 | `.dockerignore` | 未排除 `.env` / `*.key` / `*.pfx` | 密钥可能被打进镜像 | 补充排除 |
| 19 | `.github/workflows/ci.yml` | 无 `permissions` | 工作流默认权限过大 | `permissions: contents: read` |
| 20 | `app/auth.mbt` `verify_jwt` | HMAC **非常量时间比较** | 计时攻击 | `ct_eq` |

### 🟡 LOW / 加固

| # | 位置 | 缺陷 | 修复 |
|---|---|---|---|
| 21 | `kernel/kernel.mbt` `unquote` | 只校验首引号 → **吞掉末字符** | 校验首尾引号 |
| 22 | `http/http.mbt` `parse_headers` | 无头数量上限 | 上限 200 |
| 23 | `http/http.mbt` `Response::to_bytes` | header 无 CRLF 过滤 | `strip_crlf` |
| 24 | `http/server` `addr_ip` | IPv6 处理未说明 | 注释 + 稳定性确认 |
| 25 | `kernel/kernel.mbt` `find_module` | 无上溯层数上限 | `MAX_ASCENT = 64` |
| 26 | `notes/app.mbt` `json_escape` | 不转义 `\r`/`\t`/控制字符 | 补全 |
| 27 | `desktop/main.js` | 缺 `sandbox` / `webSecurity` 显式声明 | 补上 |
| 28 | `pg/client` `QueryResult::value/text` | 用户可控 `row/col` 越界 → panic | 越界返回 Null/None |
| 29 | `http/http.mbt` `read_line` / `pg.parse_backend` / `resp.decode` | 只查上界、**漏下界** → 负 pos panic | 双边校验 + `safe_byte` 系统性替换 |
| 30 | `pg/sasl.mbt` `xor_bytes` | 长度不等越界 | 按较短者循环 |
| 31 | `app/app.mbt` | 统计/缓存副作用失败会阻断主流程（`/health` 500） | `best_effort` 隔离 |
| 32 | `http/client`、`redis/client` | `buf.reset()` 丢弃未消费字节 | `pending` 跨调用保留 |
| 33 | `app/guard.mbt` | 限流 key 用可伪造的 `X-Forwarded-For` | 改用真实 `remote_addr` |
| 34 | `http/server` | 忽略 `Connection: close` | 识别并关闭 |
| 35 | 计时/单位 | `@env.now()` 毫秒被当纳秒，所有耗时统计恒为 0 | 4 处修正 |

---

## 三、**未修复**（如实列出，附理由与建议）

| # | 位置 | 问题 | 为何未修 / 建议 |
|---|---|---|---|
| U1 | `app/app.mbt` `Config::default` | **不安全默认**：空密码、`pg_ssl=false`、`MBP_HOST=0.0.0.0` | 改默认会破坏开发便利；**建议生产用 env 显式覆盖 + `Config::validate`**（已有校验）。属产品决策 |
| U2 | `kernel.mbt` `run_capture`（pub） | 暴露**任意程序执行**能力 | 当前无外部输入源；建议收紧为白名单（仅 `"moon"`）或改为私有 |
| U3 | `kernel.mbt` `moon_ide(dir, args)`（pub） | **通用 args 仍可注入选项**（我只收紧了 `ide_outline`/`ide_peek_def`） | 建议把 `args` 改为枚举化的窄接口 |
| U4 | `http/client`、`redis/client` | `pending` 缓冲**无上限**（对端持续发送可致内存增长） | 连**非可信端点**时才有风险；建议加上限（如 8 MiB） |
| U5 | ~~`app/app.mbt` `access_log_line`~~ | **已确认非漏洞**：`path` 走 `json_escape`、`rid` 走 `sanitize_header_value`（去 CR/LF） | 已加固：`rid` 也过 `json_escape`（防破坏日志 JSON 结构） |
| U6 | `moon.mod` / `moon.pkg` 依赖 | **未钉版本**（`moonbitlang/async`、`x`） | 供应链风险；建议锁版本 + 校验和 |
| U7 | `Dockerfile` | `curl \| bash` 安装工具链 | 供应链；建议固定版本 + SHA256 校验 |
| U8 | `desktop/preload.js` | IPC API 面宽（任意路径读写 + 任意 moon 命令） | 桌面 IDE 固有设计；建议限制在**打开的工作区内** |
| U9 | `desktop/index.html` CSP | `script-src 'unsafe-inline'` | Monaco/Electron 常需；建议改 nonce |
| U10 | `http/server/testdata/` | 自签**私钥入库**；`.moon-lock` 空文件 | 测试专用，需在文档标注「仅测试用」 |

---

## 四、方法论沉淀（可复用的检查规则）

1. **上下界必须同时校验**：凡接受 `pos`/`index` 的解析函数，入口校验 `pos < 0 || pos >= len`。
   只查上界（`pos + n > len`）在负 `pos` 下失效 —— 此缺陷**在 3 个文件里各出现过一次**。
2. **字节读取一律走 `safe_byte`/`safe_get`**：漏校验也不会 panic（MoonBit 的 panic 会终止整个进程）。
3. **算术比较用减法**：`len > max - used` 优于 `used + len > max`（后者可溢出成负而绕过）。
4. **资源获取与释放配对**：`acquire` 后任何失败路径都要 `release`（用 `errdefer`）。
5. **外部数字都要有上限**：迭代次数、指数、嵌套深度、连接数、头数量。
6. **别信注释**：`db/migrate` 的「整体回滚」注释是假的 —— 注释与代码必须一致，最好用测试锁住。
7. **fuzz 优于人工审计**：3 个 panic 中 2 个是 fuzz 抓到、人工审计漏掉的。
8. **不确定性要实测**：`@fs.readdir(sort=true)` 的实际顺序与直觉相反 —— 我一度"修反"，实测才定位。

---

## 五、验证

```bash
export PATH="$HOME/.moon/bin:$PATH" && cd moonbit-platform
moon check --deny-warn --target native   # 干净
moon test --target native                # 148/148
moon test --target wasm-gc               # 79/79（协议层 + fuzz）
python sec/attack.py                     # 23/23（需先起 sec/cmd/main）
```

- fuzz：`http` / `pg` / `pg/sasl` / `redis` 共 4 处（随机字节 + 结构性畸形输入，零 panic）
- 攻击脚本：整数溢出 / 请求走私 / 鉴权绕过 / 头注入 / DoS / 限流绕过

---

## 六、稳定性专项（第二轮：长稳加固 + 实测）

用户要求「没有明显 bug、能流畅稳定长时间运行」。用 3 个并行子代理专审**内存增长 / 资源生命周期 / 长时间退化**，
共发现 **11 个稳定性缺陷**，全部已修：

### 🔴 严重（必然发生 / 外部可单请求触发）

| # | 位置 | 缺陷 | 影响 | 修复 |
|---|---|---|---|---|
| S1 | `app/app.mbt` `use_metrics` | metrics 计数器的**键含攻击者可控的 HTTP 方法**（`Method::Other(s)`） | **单个请求**即可让 Map 无界增长 + `/metrics` 渲染放大 → 内存 DoS | 方法名归一化（未知 → `"OTHER"`）+ 状态码归一 + 键上限 256 |
| S2 | `app/guard.mbt` | 限流桶「只删已补满的桶」→ **一请求一 IP 即绕过上限**，且超限后每请求 O(n) 扫描 | 内存 + CPU 双增长（文档曾声称已修，实为**可绕过**） | 改为**超限即淘汰一半**（摊还成本 1/5000 请求一次） |
| S3 | `pg/redis client` `close()` | `Tls::close()` **未关底层 socket**（库契约要求先关 TLS 再关 transport） | **每个 SSL 连接关闭必漏一个 fd** | `t.close()` 后再 `tcp.close()` |
| S4 | `pg/redis client` `connect` | 建连成功后握手中途失败 → socket 不关 | 每次失败漏一个 fd | `errdefer tcp.close()` |

### 🟠 中

| # | 位置 | 缺陷 | 修复 |
|---|---|---|---|
| S5 | `http/redis/pg client` | `pending` 缓冲**无上限** → 对端持续发送 → 内存暴涨 | 上限 8 MiB（三个客户端） |
| S6 | `pg/redis pool` | 建连**无超时** → 黑洞端点把池名额永久挂住 → 后续请求排队 | `with_timeout(10s)` |
| S7 | `pg pool` `release` | **脏连接归还**（事务未结束的连接入池）→ 下一借用者落入该事务 | `in_txn` 标志 + 脏连接直接关闭 |
| S8 | `pg/redis pool` `close` | 关不干净（在用连接遗漏 + 关闭后又被塞回） | `closed` 标志 + `release` 时关闭 |
| S9 | `http/server` | 响应**写无超时** + keep-alive **无请求数上限** | 写超时 + 单连接上限 1000 请求 |
| S10 | `desktop/renderer.js` | 输出面板 DOM **无界增长**（长时间跑 moon 命令 → 卡顿） | 只保留最近 2000 节点 |
| S11 | `desktop/main.js` | 子进程**无超时/无 kill**、stdout **无上限** | 120s 超时 + kill + 输出上限 2 MiB |

### 长稳实测（本机 Windows，native）

用 `notes` 服务（不限流）连打 3 轮 × 5 万请求（64 并发），并监控工作集内存：

| 轮次 | 请求 | ok | fail | QPS | p50 | p95 | 内存(WorkingSet) |
|---|---|---|---|---|---|---|---|
| 1 | 50 000 | 49 984 | **0** | 1452 | 43ms | 49ms | 11.44 MB |
| 2 | 50 000 | 49 984 | **0** | 1442 | 44ms | 48ms | 11.44 MB |
| 3 | 50 000 | 49 984 | **0** | 1456 | 44ms | 47ms | **11.48 MB** |
| + PG 读 | 5 000 | 4 992 | **0** | 638 | 50ms | 54ms | 11.72 MB |

**结论**：
- **15 万请求零失败**，QPS / 延迟 / **内存三轮无退化**（11.44 → 11.44 → 11.48 MB）→ 无内存泄漏
- 另行验证：**1 万个不同畸形方法名**请求后内存**未增长**（10498048 → 10489856 字节）→ metrics 归一化生效
- 全程**无 panic**，服务持续可服务

> 注：第一次尝试用 `sec` 靶场压测时 `fail=19952` —— 不是服务问题，而是靶场的 2 req/s 限流生效（压测来自同一真实 IP）。换掉限流后即 0 失败。
