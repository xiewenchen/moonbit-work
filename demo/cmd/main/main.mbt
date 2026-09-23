///|
/// demo 服务入口：`moon run --target native demo/cmd/main`
/// 默认监听 127.0.0.1:8080；PG 在 55432、Redis 在 6379。
async fn main {
  let backends : @demo.Backends = { pg_port: 55432, redis_port: 6379, }
  @demo.ensure_schema(backends)
  let router = @demo.build_router(backends)
  @server.serve(router, "127.0.0.1", 8080)
}
