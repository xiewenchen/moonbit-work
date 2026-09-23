///|
/// 压测入口：`moon run --target native bench/cmd/main`
///
/// 环境变量：BENCH_HOST / BENCH_PORT / BENCH_PATH / BENCH_TOTAL / BENCH_CONCURRENCY
async fn main {
  let host = env_or("BENCH_HOST", "127.0.0.1")
  let port = env_int("BENCH_PORT", 8080)
  let path = env_or("BENCH_PATH", "/health")
  let total = env_int("BENCH_TOTAL", 1000)
  let concurrency = env_int("BENCH_CONCURRENCY", 20)
  let r = @bench.run_bench(host, port, path, total, concurrency)
  let qps = if r.elapsed_ms == 0UL {
    0UL
  } else {
    r.ok.to_uint64() * 1000UL / r.elapsed_ms
  }
  println(
    "bench http://\{host}:\{port}\{path}  total=\{r.total} conc=\{concurrency}",
  )
  println("  ok=\{r.ok} fail=\{r.fail}")
  println("  elapsed=\{r.elapsed_ms}ms  qps~=\{qps}")
  println("  latency ms: p50=\{r.p50_ms} p95=\{r.p95_ms} max=\{r.max_ms}")
}

///|
fn env_or(key : String, default : String) -> String {
  match @env.get_env_var(key) {
    Some(v) => v
    None => default
  }
}

///|
fn env_int(key : String, default : Int) -> Int {
  match @env.get_env_var(key) {
    Some(v) => parse_int(v, default)
    None => default
  }
}

///|
fn parse_int(s : String, default : Int) -> Int {
  let mut acc = 0
  let mut any = false
  for i = 0; i < s.length(); i = i + 1 {
    match s.get_char(i) {
      Some(c) =>
        if c >= '0' && c <= '9' {
          acc = acc * 10 + (c.to_int() - '0'.to_int())
          any = true
        } else {
          return default
        }
      None => ()
    }
  }
  if any {
    acc
  } else {
    default
  }
}
