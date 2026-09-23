///|
/// 简易并发压测：用我们的 HTTP 客户端并发打某个路径，统计 QPS 与延迟分位。

///|
/// 压测结果。
pub(all) struct BenchResult {
  total : Int
  ok : Int
  fail : Int
  elapsed_ms : UInt64
  p50_ms : UInt64
  p95_ms : UInt64
  max_ms : UInt64
} derive(Debug)

///|
/// 每并发协程的统计（局部累加，最后汇总，避免并发写共享数组）。
priv struct WorkerStat {
  mut ok : Int
  mut fail : Int
  latencies : Array[Int]
}

///|
fn percentile(sorted : Array[Int], p : Int) -> UInt64 {
  if sorted.length() == 0 {
    0UL
  } else {
    let idx = sorted.length() * p / 100
    let i = if idx >= sorted.length() { sorted.length() - 1 } else { idx }
    sorted[i].to_uint64()
  }
}

///|
/// 并发压测 `host:port` 上的 `path`，共 `total` 次请求、`concurrency` 并发。
pub async fn run_bench(
  host : String,
  port : Int,
  path : String,
  total : Int,
  concurrency : Int,
) -> BenchResult {
  let per = if concurrency <= 0 { total } else { total / concurrency }
  let results : Ref[Array[WorkerStat]] = Ref([])
  let start = @env.now()
  @async.with_task_group(fn(g) {
    for w = 0; w < concurrency; w = w + 1 {
      g.spawn_bg(async fn() {
        let c = @client.Client::connect(host, port)
        let stat : WorkerStat = { ok: 0, fail: 0, latencies: [], }
        for i = 0; i < per; i = i + 1 {
          let t0 = @env.now()
          let resp : @http.Response? = try c.get(path) catch {
            _ => None
          } noraise {
            v => Some(v)
          }
          // `@env.now()` 单位是毫秒
          let dt = (@env.now() - t0).to_int()
          stat.latencies.push(dt)
          match resp {
            Some(r) =>
              if r.status >= 200 && r.status < 400 {
                stat.ok = stat.ok + 1
              } else {
                stat.fail = stat.fail + 1
              }
            None => stat.fail = stat.fail + 1
          }
        }
        c.close()
        results.val.push(stat)
      })
    }
  })
  let elapsed_ms = @env.now() - start
  let mut ok = 0
  let mut fail = 0
  let all : Array[Int] = []
  for st in results.val {
    ok = ok + st.ok
    fail = fail + st.fail
    for d in st.latencies {
      all.push(d)
    }
  }
  all.sort()
  {
    total: ok + fail,
    ok,
    fail,
    elapsed_ms,
    p50_ms: percentile(all, 50),
    p95_ms: percentile(all, 95),
    max_ms: if all.length() == 0 {
      0UL
    } else {
      all[all.length() - 1].to_uint64()
    },
  }
}
