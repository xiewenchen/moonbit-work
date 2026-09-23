# 实战验证报告（Live Verification）

本报告记录在**真实环境**（本机 Windows + Docker 依赖）上对平台的验证：
端到端功能、真实压测、故障注入。**不是**单元测试的复述。

环境：Windows / MoonBit `moon 0.1.20260915` + `moonc v0.10.13`（native 后端，MSVC 14.44）；
依赖：PostgreSQL 16（Docker，端口 55432，trust）、Redis 7（Docker，端口 6379）；
被测：`notes` 示例服务（应用框架 `app` + PG + Redis 全链路），监听 `127.0.0.1:8080`。

---

## 1. 端到端功能验证

| 请求 | 结果 | 状态 |
|---|---|---|
| `GET /health` | `ok` | ✅ 存活探针 |
| `GET /ready` | `ready` | ✅ 就绪探针（探测 PG + Redis） |
| `GET /metrics` | Prometheus 文本（`http_requests_total{...}`） | ✅ |
| `POST /notes` (JSON) | `{"id":22}` | ✅ 写 PG |
| `GET /notes` | JSON 数组 | ✅ 读 PG |
| 响应头 | `X-Request-Id: 4EG8sCq3F5g7ybH7PKFqNQ==` | ✅ 链路追踪 ID 回写 |
| stdout 日志 | `{"level":"info","method":"GET","path":"/health","status":200,"duration_ms":1,"request_id":"..."}` | ✅ 结构化 JSON |

## 2. 真实压测（`bench`，本机同机打本机）

| 场景 | 总量 | 并发 | 成功 | 失败 | 耗时 | 吞吐 | p50 | p95 | max |
|---|---|---|---|---|---|---|---|---|---|
| `/health` | 2000 | 50 | 2000 | **0** | 884 ms | **~2262 QPS** | 21 ms | 24 ms | 29 ms |
| `/health` | 5000 | 200 | 5000 | **0** | 2263 ms | **~2209 QPS** | 87 ms | 93 ms | 104 ms |
| `/notes`（含 PG 查询） | 500 | 20 | 500 | **0** | 400 ms | **~1250 QPS** | 15 ms | 18 ms | 25 ms |

**结论**：
- **零失败**（7500 个请求全部成功），稳定性正面。
- 吞吐在 50→200 并发间**几乎不变（~2.2k QPS）**，而延迟随并发线性上升（21ms→87ms）——
  这是**单线程协作式事件循环饱和**的典型特征：请求在队列里排队而不是并行执行。
  故 **QPS 天花板 ≈ 2.2k**（本机、单进程）。
- PG 查询路径 ~1.25k QPS（每次查库，比纯内存路由低约一半）。

## 3. 故障注入

| 注入 | 期望 | 实测 | 结果 |
|---|---|---|---|
| 停 Redis | `/health` 仍 200；`/ready` 503 | `ok [200]`；`{"error":"dependencies not ready"} [503]` | ✅ |
| 恢复 Redis | `/ready` 回 200（池自动重连） | `ready [200]` | ✅ |
| 停 PG | `/ready` 503；`/notes` 500(JSON)；`/health` 仍 200 | `[503]`；`{"error":"internal server error"} [500]`；`ok [200]` | ✅ |
| 恢复 PG | `/ready` 与 `/notes` 回 200 | `ready [200]`；`notes=200` | ✅ |

**意义**：依赖故障**不会**导致探针误报或服务假死；错误以 JSON 形式可控返回；依赖恢复后连接池自动重建。

---

## 4. 本轮实战**发现并修复的真实缺陷**（3 个）

这些是**只看单元测试发现不了、只有跑真实负载/故障才会暴露**的问题：

1. **计时单位 bug（严重）**：`@env.now()` 返回**毫秒**，而代码按纳秒假设除以 `1_000_000`，
   导致**所有耗时统计恒为 0**（日志 `duration_ms`、Prometheus 耗时指标、压测 p50/p95 全部失真）。
   修复：4 处改为直接用毫秒差值。（诊断方式：用「故意失败的断言」暴露 `now()` 差值 = 204 ≈ 200ms。）

2. **统计中间件未隔离（严重）**：`notes` 的请求计数中间件直接调 Redis，**Redis 一挂 → 连 `/health` 都返回 500**。
   探针被非关键依赖拖下水。修复：新增 `@app.best_effort(default, f)`（异步「尽力而为」），
   统计/缓存这类副作用失败时忽略，绝不阻断主流程。

3. **依赖故障时的探针语义**：修复 2 之前，`/ready` 也返回 500（而非 503），因为计数中间件先抛错。
   修复后语义正确：**存活**（`/health`）与**就绪**（`/ready`）清晰分离。

## 5. 仍未验证 / 已知限制（如实列出）

- **Docker 镜像构建 / CI**：本机网络无法访问 apt 源（8 KB/s 超时），未验证；需在有外网处跑。
- **长时稳定性**（小时级、内存增长曲线）：未做；本轮最长单次运行约 15 分钟。
- **多进程压测**：`cluster::spawn_workers` 机制已验证，但未做「N 进程 + 反代」的联合压测。
- **Windows 优雅关闭**：`accept` 在 Windows/IOCP 下不响应取消（已在代码与文档标注）。
- 压测为**同机自打**（客户端与服务端抢同一 CPU），真实网络下数字会不同。

## 6. 复现命令

```bash
export PATH="$HOME/.moon/bin:$PATH"
cd moonbit-platform

# 依赖（若未起）
docker start mbp-pg mbp-redis

# 起服务（真实运行）
moon run --target native notes/cmd/main

# 压测（注意 git bash 需 MSYS_NO_PATHCONV=1，否则 /health 被转成 Windows 路径）
MSYS_NO_PATHCONV=1 BENCH_PATH=/health BENCH_TOTAL=5000 BENCH_CONCURRENCY=200 \
  moon run --target native bench/cmd/main

# 故障注入
docker stop mbp-redis && curl -i localhost:8080/ready   # → 503
curl -i localhost:8080/health                           # → 200（存活不受影响）
docker start mbp-redis && sleep 10 && curl -i localhost:8080/ready  # → 200
```

## 7. 结论

平台在**真实运行 + 真实负载 + 真实故障**下表现符合设计意图：功能正确、零失败、故障可控、依赖可恢复。
同时实战暴露了 3 个此前测试未覆盖的真实缺陷（均已修复），**印证了"实战验证"不可被单元测试替代**。

**距离"生产级"仍缺**：长时稳定性数据、多实例联合压测、真正的负载均衡部署、以及
**MoonBit 语言与 `async` 运行时仍处 Beta/experimental** 这一地基风险。

**现状定位**：可用于**内网服务 / MVP / 平台验证**；上公网生产前建议先在 Linux 上跑一轮长时压测。

---

## 8. 第二批修复：keep-alive 复用时的缓冲缺陷（代码审计发现）

上面的实战验证只覆盖了「功能正确」路径；随后做了一轮**代码审计**，在 keep-alive 复用路径上又找到 3 个真实缺陷：

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 4 | `http/client` `read_response` | 用 `buf.reset()` 清空缓冲 → **一次 read 里多出来的下一个响应被丢弃**（TCP 粘包时高发） | 改为 `pending : Bytes` + 保留 `consumed` 之后的字节 |
| 5 | `http/client` `send` | 无条件 `push(("Connection","keep-alive"))` → 同一 request 重复 send 时 **header 累加** | 改为仅在缺失时补 |
| 6 | `redis/client` `send_command` | 同样 `buf.reset()` → **丢弃未消费的 RESP 回复** | 同 4，改为 `pending` 方案 |

> PG client 从一开始就用正确的 `pending` 方案，故未受影响。

**回归测试**（`http/client/pipeline_test.mbt`、`redis/client/pipeline_test.mbt`）：
让服务端**一次性写出两个完整响应/回复**，客户端连续取两次。
- **有效性已验证**：把修复退回旧行为后，两个测试**立刻失败**
  （`OSError("@socket.Tcp::read(): The specified network name is no longer available.")`）；
  恢复修复后 3/3 通过。这证明测试确实锁住了该缺陷，而不是空转。

**测试数**：native **115/115**、wasm-gc **50/50**，`moon check --deny-warn` 干净。
