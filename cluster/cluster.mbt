///|
/// 并发模型：两个可选方案。
///
/// 1. **多进程**（`spawn_workers`）：同一个可执行文件起 N 份，每份一个端口，
///    前面用反向代理（Nginx 等）分流 —— 这是绕开「单线程协作式」限制的正路。
/// 2. **单进程多监听**（`serve_ports`）：一个进程同时监听多个端口，共享连接池。
///
/// ⚠️ 限制：Windows/IOCP + experimental async 下 `accept` 不响应取消，
/// 因此进程收到 SIGTERM 后的「优雅退出」在 Windows 上不生效（需强制结束）；
/// 生产建议在 Linux/macOS 运行，或用容器编排的宽限期后强杀。

///|
/// 并发起 `instances` 个进程；第 i 个进程的环境变量 `port_env = base_port + i`。
/// 返回各子进程的退出码（顺序不保证）。
pub async fn spawn_workers(
  program : String,
  args : Array[String],
  instances : Int,
  base_port : Int,
  port_env? : String = "MBP_PORT",
) -> Array[Int] {
  let codes : Ref[Array[Int]] = Ref([])
  @async.with_task_group(fn(g) {
    for i = 0; i < instances; i = i + 1 {
      let env : Map[String, String] = Map([
        (port_env, (base_port + i).to_string()),
      ])
      g.spawn_bg(async fn() {
        let code = @process.run(program, args, extra_env=env)
        codes.val.push(code)
      })
    }
  })
  codes.val
}

///|
/// 同一进程内同时在多个端口上服务（共享连接池），配合反向代理分流。
pub async fn serve_ports(
  router : @server.Router,
  host : String,
  ports : Array[Int],
) -> Unit {
  @async.with_task_group(fn(g) {
    for p in ports {
      g.spawn_bg(async fn() { @server.serve(router, host, p) })
    }
  })
  println("[cluster] all listeners stopped")
}
