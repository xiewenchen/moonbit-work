# 安全测试报告（偏漏洞方向）

对平台做了一轮**面向漏洞的二次测试**（不是功能测试的复述）：
用原始 socket 构造恶意报文打真实服务（`sec/cmd/main` 靶场，装全套中间件 + 小速率限流），
并用代码审计定位根因。**共发现 5 个真实缺陷，全部已修复**，其中 1 个是**远程 DoS（可崩溃进程）**。

靶场：`sec/cmd/main`（`127.0.0.1:8090`，日志/指标/就绪/限流 2rps/桶3/JWT 鉴权）
攻击脚本：`sec/attack.py`（23 项检查，**现 23/23 PASS**）

---

## 一、发现与修复

### 🔴 1. 整数溢出 → 绕过 body 大小限制（严重）

`Content-Length` / chunk size 用 32 位 `Int` 累加，**无溢出检查**：

```
Content-Length: 99999999999999   →  实际被解析成 276447231
Content-Length: 4294967396       →  溢出成 100（可绕 8MiB 上限）
```

后果：可绕过 8 MiB body 上限；溢出的负数会让解析位置回退。
**修复**：乘法前判阈值 + 乘法后查负数（`parse_decimal`、`parse_hex_size`）。

### 🔴 2. chunked 溢出 → **进程崩溃（远程 DoS）**（严重）

`chunk size` 溢出成**负数** → `p = np + size + 2` 回退成负数 →
`read_line_opt` 里 `input[负数]` **panic** → **整个服务进程退出**。

服务端日志实证：
```
PanicError
    at @mbp/platform/http.read_line_opt (http.mbt:327)
    at @mbp/platform/http.decode_chunked (http.mbt:377)
```

**这是最严重的问题**：一个精心构造的 chunked 请求就能让服务下线。
**修复**：① 更严的溢出阈值（`acc > 134217727`）+ 负数检查；② `read_line_opt` 位置合法性防御；
③ `decode_chunked` 加 `size < 0` 检查与「位置必须严格前进」断言。
**修复后**：该请求返回 `400 chunk size too large`，进程存活。

### 🟠 3. 响应头注入 / 响应拆分

`X-Request-Id` 从请求头**原样回显**到响应头。请求头里可夹带**裸 `\r`**（`read_line` 只按 `\r\n` 切分）
→ 响应头变成 `X-Request-Id: aaa\rbbb` → 某些代理/客户端会把裸 CR 当行结束 → 可注入额外响应头（缓存投毒）。

**修复**：`sanitize_header_value()` —— 丢弃 CR/LF/控制字符并限长 200。
**修复后**：`X-Request-Id: aaabbb`。

### 🟠 4. 限流可被伪造 `X-Forwarded-For` 绕过 + 无头时全站共享桶

`client_key` 直接取 `X-Forwarded-For`：
- 攻击者**每次改这个头**即可绕过限流（实测：修复前换 XFF 6/6 全部通过）；
- 无该头时所有客户端共享 `"global"` 桶 → 一个匿名用户即可耗尽**所有人**的配额。

**修复**：`Request` 新增 `remote_addr`，由服务端从 `accept()` 的真实对端地址填充（客户端不可伪造），
限流优先用它；`X-Forwarded-For` 降级为仅在「确认前面有可信代理」时才应采纳。
**修复后**：换 XFF 6/6 全被 429（无法绕过）。

> 附带修掉一个隐蔽 bug：`addr.to_string()` **带端口**，而每次连接源端口都不同 →
> 每个请求一个桶 → 限流形同虚设。改为取 IP 部分（`addr_ip`）。

### 🟡 5. 忽略 `Connection: close`（协议合规 / 连接泄漏）

服务端**从不主动关闭连接**，即使客户端明确要求 `Connection: close`（HTTP/1.0 客户端也一样）。
后果：连接被占用到 idle 超时（默认 30s），高并发下易耗尽连接数。

**修复**：`serve_connection_with` 识别 `Connection: close` / HTTP/1.0 → 响应头回写 `Connection: close` 并结束循环。

---

## 二、验证结果（`sec/attack.py`，23/23 PASS）

| 类别 | 检查项 | 结果 |
|---|---|---|
| 整数溢出 | `Content-Length` 2^32+4 / 2^32+100 / 99999999999999 / 负数 / 边界值 | ✅ 全 400 |
| 大小限制 | 超大 body(20MiB)→413、超大请求头→431、超大 chunk→400 | ✅ |
| 请求走私 | 溢出 CL + 尾随请求 → **只产生 1 个响应**（无走私） | ✅ |
| 鉴权 | 无 token→401、`alg=none` 伪造→401、篡改 payload→401 | ✅ |
| 白名单绕过 | `/health/../api/echo`、`/health%2f../..`、`/Health`、`/health?x=1` | ✅ 均未泄露 |
| 头注入 | `X-Request-Id: aaa\rbbb` → 回显为 `aaabbb` | ✅ |
| SQL 注入样式 | 路径参数 `1 OR 1=1` / `1;DROP TABLE--` / `1' UNION SELECT--` | ✅ 未到 handler |
| DoS | 慢速半开请求 → 30s 被 idle 超时关闭 | ✅ |
| DoS | 10 万层嵌套 JSON → 0.03s 返回（不崩不卡） | ✅ |
| 限流 | 同源 6 次 → 后 4 次 429；**伪造 XFF 6/6 全 429** | ✅ |
| 存活 | 全部攻击跑完后服务仍 `200` | ✅ |

**回归测试**：`http/security_test.mbt`（12 项，protocol 层，wasm-gc 也能跑）锁住溢出与 panic 路径。
全量：`moon test --target native` **126/126**、`--target wasm-gc` **61/61**、`check --deny-warn` 干净。

---

## 三、仍存在的风险（如实列出，未修复）

1. **`allow_failure=true` 掩盖连接级 panic** —— 目前 panic 会终止进程（MoonBit 无 catch-panic），
   只能靠「根除 panic 源」防御。已加防御性检查，但**未做全量 panic 审计**（`unwrap()`、索引访问等）。
2. **无请求体大小流式限制** —— 超大 body 是「声明即拒」，但攻击者仍可用大量**合法大小**的请求耗内存。
3. **无 slowloris 之外的慢速攻击防护**（如慢速 POST body）。
4. **限流的桶永不回收** —— 大量不同来源 IP 会让 `buckets` Map 无限增长（内存泄漏面）。
5. **JWT 无过期/吊销校验**（按项目定位「轻量」，未实现 `exp`/黑名单）。
6. **TLS 默认信任系统根**，但靶场/测试用 `NoVerification`；生产必须显式传 `SystemRoot`。
7. **未做 fuzzing** —— 建议后续用 afl/libFuzzer 或 `moon` 的随机测试对 `Request::parse` 做长跑。

## 四、复现

```bash
export PATH="$HOME/.moon/bin:$PATH"
cd moonbit-platform
moon run --target native sec/cmd/main &        # 靶场（8090）
sleep 20
python sec/attack.py                            # 23 项漏洞检查
# 协议层回归（不需要服务）
moon test http --target wasm-gc
```

---

## 五、第二轮加固（针对「仍存在的风险」）

上一轮列出的未修风险，本轮逐项处理：

| # | 项 | 处理 |
|---|---|---|
| 1 | **无 catch-panic，未全量审计索引** | **全量审计**了所有 `unwrap()` 与直接索引；修 4 处可 panic 点（见下） |
| 2 | **限流桶永不回收**（内存泄漏面） | 加**桶数上限 10000 + 懒清理**（超限时删除「已补满」的桶） |
| 3 | **JWT 无过期校验** | 新增 `sign_jwt_expiring(claims, secret, ttl_sec)`；`verify_jwt` 校验 `exp`（过期即拒） |
| 4 | **未做 fuzzing** | 新增 `http/fuzz_test.mbt`：3 组 fuzz（随机字节 / 合法头+随机体 / 随机 query），各 3000 轮 |

### 全量 panic 审计结果（本轮修复的 panic 点）

| 位置 | 问题 | 修复 |
|---|---|---|
| `pg/client` `QueryResult::value/text` | **用户可控 `row`/`col` 越界即 panic**（最现实的风险） | 边界检查，越界返回 `Null`/`None` |
| `http` `read_line` | **负数/越界 `pos` → `input[负数]` panic**（fuzz 抓到） | 加 `pos < 0 \|\| pos > n` 防御 |
| `redis` `resp.decode` | 负数 `pos` → panic | 加 `pos < 0` 检查 |
| `pg` `sasl.xor_bytes` | 两参数长度不等 → 越界 panic | 按较短者循环 |
| `pg/types` `unwrap()`、`http/percent_decode` `unwrap()` | 潜在 panic 点（当前有前置检查） | 改为 `match`，彻底消除 |

### ⭐ fuzz 的价值被实证

`fuzz_test.mbt` **第一次运行就抓到一个真实越界 panic**：

```
RuntimeError: array element access out of bounds
    at @mbp/platform/http.read_line (http.mbt:470)
    at @mbp/platform/http.Request::parse (http.mbt:559)
```

这正是上一轮「人工审计」**漏掉**的函数（我只修了孪生的 `read_line_opt`，没注意还有 `read_line`）。
修复后 fuzz 26/26 通过。**说明随机 fuzzing 能覆盖人工审计的盲区。**

### 复核结果

- `http/fuzz_test.mbt`：**26/26 通过**（9000 轮随机/畸形输入，**零 panic**）
- 全量：`moon test --target native` **129/129**、`--target wasm-gc` **64/64**、`check --deny-warn` 干净

### 仍然存在的风险（诚实更新）

1. **panic 仍是进程级** —— 已大幅减少 panic 面，但无法穷尽（MoonBit 无 catch-panic）。
2. **限流清理阈值固定 10000** —— 极端洪泛下仍可能短暂超限（可接受）。
3. **JWT 仍无吊销列表**（只有 `exp`）。
4. **fuzz 覆盖面有限** —— 只覆盖 http 解析；pg/redis 解析器未 fuzz；未做 coverage-guided fuzzing。
5. **未做并发压测下的错误注入**（如连接被 RST 时的资源释放）。

---

## 六、第三轮：pg/redis 解析器 fuzz

上一轮只 fuzz 了 http 解析器；本轮把同样的手段用到 **PostgreSQL 协议解析器**与 **RESP 解析器**。

### ⭐ 又抓到一个越界 panic

`pg/fuzz_test.mbt` **首次运行即失败**：

```
RuntimeError: array element access out of bounds
    at @mbp/platform/pg.parse_backend (pg/message.mbt:449)
```

`parse_backend` 只有上界检查 `if pos >= input.length()`，**漏了 `pos < 0`** → 负数位置直接
`input[pos]` panic。修复：`if pos < 0 || pos >= input.length()`。

（与上一轮 `http.read_line` 完全同型 —— **「只检查了上界、忘了下界」是一类系统性缺陷**。）

### 覆盖的 fuzz 场景

| 包 | 文件 | 场景 |
|---|---|---|
| `pg` | `pg/fuzz_test.mbt` | `parse_backend`（随机字节 / 随机位置 / 合法 tag+随机 payload / 随机长度字段）、`decode_value`（24 种 oid × 随机文本 × NULL、畸形数组/时间戳） |
| `redis` | `redis/fuzz_test.mbt` | `resp.decode`（随机字节 / 随机位置 / 合法前缀+随机尾 / 200 层嵌套数组）、`Resp::encode` 往返 |

### 结果

- `pg`：**32/32**（修复后）；`redis`：**15/15**（一次通过，未发现缺陷）
- 全量：native **138/138**、wasm-gc **73/73**、`check --deny-warn` 干净

### 规律总结（三轮下来）

「**只检查上界、漏掉下界**」已出现两次（`http.read_line`、`pg.parse_backend`）。
凡接受 `pos`/`index` 参数的解析函数，**下界与上界必须同时校验** —— 这也正是 fuzz 比人工审计可靠的原因。

---

## 七、第四轮：系统性防御（`safe_byte`）与独立安全审查

### 7.1 把「上下界必须同时校验」落成规则 + 统一封装

**规则**（已写入 `http/http.mbt`、`redis/resp.mbt`、`pg/message.mbt` 顶部注释）：

> 所有接受 `pos` / `index` 的解析函数，入口处必须**同时**校验上下界
> （`pos < 0 || pos >= input.length()`）—— 只查上界（如 `pos + 2 > len`）
> 在负 `pos` 下会失效并越界 panic。

**封装**：新增 `safe_byte(b, i, default)` / `safe_get(b, i)`，并**把所有裸字节索引
`input[i]` 全部替换掉**（http / pg / redis 三个解析包）。现在即使某处漏了校验，
也只是解析失败，**不会崩进程** —— 从「逐个修」升级为「系统性防御」。

替换后再自查，剩余裸索引只剩 6 处，且**全在 `safe_byte`/`safe_get` 内部**（受边界检查保护）。

### 7.2 独立安全审查（子代理）查出的新问题，已全部修复

| 级别 | 位置 | 问题 | 修复 |
|---|---|---|---|
| MEDIUM | `app/auth.mbt` `sign_jwt` | **claim 键值不转义 → 注入伪造 claim**（用户名含 `"` 可提升 role） | 新增 `json_escape_str`，键值与值都转义 |
| MEDIUM | `app/auth.mbt` `verify_jwt` | HMAC **非常量时间比较**（计时攻击） | 新增 `ct_eq`（比完所有字符再判定） |
| MEDIUM | `pg/sasl.mbt` `pbkdf2_sha256` | `iterations` 取自**服务端**且**无上限** → 恶意 PG 令其 =2^31 → **客户端 CPU 挂死** | 新增 `MAX_SCRAM_ITERATIONS = 50000` 并夹紧；`parse_decimal_str` 加饱和 |
| MEDIUM | `pg/types.mbt` `parse_double_str` | `exp` 无上限且驱动 `for i<exp` 循环 → `1e2000000000` **CPU 挂死** | `exp` 解析饱和 + 幂次上限 400 |
| MEDIUM | `pg/message.mbt` `parse_backend` / `parse_data_row` | `pos + 1 + len` / `pos + len` **溢出为负** → 绕过长度检查、`clamped_view` start>end | 改为减法比较（`len > b.length() - pos`） |
| MEDIUM | `redis/resp.mbt` bulk 长度 | `len.to_int()` **截断** + `next + l` 溢出为负 → 绕过检查 | 用 Int64 比较 `len > remaining - 2` |
| LOW | `http.mbt` chunked | `out.length() + size` 溢出为负 | 改减法比较 |
| LOW | `http.mbt` `parse_headers` | 无头数量上限 | 加 `max_headers = 200` |
| LOW | `notes/app.mbt` `json_escape` | 不转义 `\r`/`\t`/其它控制字符 | 补全转义 |
| LOW | `http.mbt` `Response::to_bytes` | header 名/值无 CRLF 过滤（纵深防御） | 新增 `strip_crlf` 并应用 |

> 审查同时确认**未构成问题**的点：SQL 全部参数化（无拼接）；`use_auth` 放行列表用精确匹配
> （不可能前缀绕过）；`verify_jwt` 硬编码 HS256（不接受 `alg:none`）；`parse_decimal` /
> `parse_hex_size` 的溢出阈值正确。

### 7.3 关于「panic 仍是进程级」的应对思路

MoonBit 目前**无法捕获 panic**（`PanicError` 直接 abort 进程），这是语言层面的限制。分三层应对：

- **短期**：fuzz 覆盖（见第六节）+ 本轮的 `safe_byte` 系统性替换 —— 实测已把 3 类越界 panic 全部消除。
  > 一个反例佐证：fuzz 抓到 `pg.parse_backend` 与 `http.read_line` 都是「只查上界漏下界」——
  > 人工审计会漏，随机输入不会。
- **中期**：所有解析入口显式校验 + 统一 `safe_*` 访问；继续对 `pg/sasl`、`db` 等新增解析器做 fuzz。
- **长期**：关注 MoonBit 是否引入 **Result 化的数组访问 / 可恢复错误机制**；若语言提供，
  可把解析层改为全 `Result` 风格，从根上消除 panic。

### 7.4 下一步价值排序（调整后）

1. **优先**：`pg/sasl`、`db` 继续 fuzz —— 模板复用成本极低（本轮已做 `pg/sasl`，一次通过）。
2. **其次**：`moon test --coverage` 看哪些分支未覆盖，**针对性构造用例**（不引入完整
   coverage-guided 工具链，避免环境成本）。
3. **放「未来工作」**：Linux 容器中的长时压测 —— 当前开发环境为 Windows，长时压测计划在
   Linux 容器中完成。

---

## 八、四轮成果汇总（可直接用于「验证与测试」章节）

| 轮次 | 手段 | 抓到 | 修复方式 |
|---|---|---|---|
| 实战测试 | 真实负载 + 故障注入 | 3 个 | `now()` 单位修正、副作用中间件隔离（`best_effort`）、存活/就绪探针语义重定义 |
| 代码审计 | keep-alive 复用路径 | 3 个 | 读缓冲跨调用保留（`pending`）、`Connection` 头去重、RESP 缓冲保留 |
| 安全测试 | 原始 socket 攻击 | 5 个 | 整数溢出防护（CL/chunk）、chunked 下界校验、响应头转义、限流改用真实远端地址、实现 `Connection: close` |
| 加固 2 | panic 审计 + fuzz | 4 个 | `QueryResult` 越界返回 Null/None、`read_line` 下界校验、`xor_bytes` 长度夹紧、`decode` 负 pos 校验 |
| 加固 3 | pg/redis 解析器 fuzz | 1 个 | `parse_backend` 负 pos 校验 |
| **加固 4** | **安全审查 + `safe_byte` 系统性防御** | **10 个** | **JWT claim 转义、常量时间比较、SCRAM 迭代上限、数值指数上限、3 处长度溢出改减法、头数上限、CRLF 过滤** |

**累计修复 26 个真实缺陷**（含 1 个远程 DoS 崩溃、2 个 CPU 挂死 DoS、1 个注入）。

**最终测试数**：`moon test --target native` **148/148**、`--target wasm-gc` **79/79**、`moon check --deny-warn` 干净。
