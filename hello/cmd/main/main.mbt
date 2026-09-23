///|
/// hello —— **零依赖**的示例服务，用来验证「运行项目 → 看到效果」这条链路。
///
///   moon run --target native hello/cmd/main
///   然后打开 http://127.0.0.1:8123
///
/// 为什么单独做这么一个：仓库里的 `demo/` 与 `notes/` 都要先连上 PostgreSQL + Redis
/// 才会开始监听（环境没起来时会一直静默等待）—— 那样「打开就能看到运行效果」就无从谈起。
/// 这个示例只用本项目的 `http/server`，不依赖任何外部服务。
///
/// 端口用 8123：避开 `demo` 的 8080 与安全靶场 `sec` 的 8090。
const PORT : Int = 8123

///|
/// 首页：给一个像样的页面（而不是一行 "ok"），这样"运行起来的样子"是看得见的。
/// 注意：MoonBit 的多行字符串 `#|` **不做插值**（`{x}` 不会替换），要显示动态值必须用 `+` 拼。
fn page(path : String, hits : Int) -> String {
  let head = #|< !DOCTYPE html>
  #|<html lang="zh-CN"><head><meta charset="utf-8">
  #|<meta name="viewport" content="width=device-width,initial-scale=1">
  #|<title>MoonBit 后端平台 · 示例服务</title>
  #|<style>
  #|  :root{--p:#4945ff;--bg:#0f0f16;--panel:#181822;--line:#2a2a38;--tx:#e8e8f0;--dim:#9a9aae}
  #|  *{box-sizing:border-box}
  #|  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  #|       background:radial-gradient(1200px 600px at 50% -10%,#1d1b3a,var(--bg));
  #|       color:var(--tx);font:15px/1.7 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
  #|  .card{width:min(680px,92vw);background:var(--panel);border:1px solid var(--line);
  #|        border-radius:16px;padding:36px 40px;box-shadow:0 18px 60px rgba(0,0,0,.45)}
  #|  .logo{width:54px;height:54px;border-radius:14px;display:flex;align-items:center;justify-content:center;
  #|        font-weight:800;font-size:20px;color:#fff;letter-spacing:.5px;
  #|        background:linear-gradient(160deg,#4945ff,#7b6fe0)}
  #|  h1{margin:18px 0 6px;font-size:24px}
  #|  .sub{color:var(--dim);margin-bottom:22px}
  #|  .row{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--line)}
  #|  .row .k{color:var(--dim)}
  #|  code{background:#0c0c14;border:1px solid var(--line);border-radius:6px;padding:2px 7px;
  #|       font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#cfc9ff}
  #|  .ok{color:#4ec27a;font-weight:600}
  #|  .tip{margin-top:20px;color:var(--dim);font-size:13px}
  #|</style></head><body><div class="card">
  #|  <div class="logo">MB</div>
  #|  <h1>MoonBit 后端平台 · 示例服务</h1>
  #|  <div class="sub">纯 MoonBit 实现的 HTTP 服务，<b>零外部依赖</b> —— 起服务就能看到这一页。</div>
  #|  <div class="row"><span class="k">服务状态</span><span class="ok">● 正在运行</span></div>
  #|  <div class="row"><span class="k">监听地址</span><code>http://127.0.0.1:8123</code></div>
  #|  <div class="row"><span class="k">本次访问路径</span><code>
  let mid = #|</code></div>
  #|  <div class="row"><span class="k">已处理请求</span><code>
  let tail = #|</code></div>
  #|  <div class="row"><span class="k">实现</span><span>http/server（Router · 中间件 · keep-alive）</span></div>
  #|  <div class="tip">试着访问 <code>/health</code> 与 <code>/api/time</code>；<br>
  #|     这个文件在 <code>hello/cmd/main/main.mbt</code>，改完重新运行即可。</div>
  #|</div></body></html>
  head + path + mid + hits.to_string() + tail
}

///|
async fn main {
  let hits : Ref[Int] = Ref(0)
  let router = @server.Router::new()
  router.get("/", fn(_req) {
    hits.val = hits.val + 1
    { status: 200, reason: "OK", headers: [("Content-Type", "text/html; charset=utf-8")],
      body: @utf8.encode(page("/", hits.val)) }
  })
  router.get("/health", fn(_req) { @http.Response::text(200, "ok") })
  router.get("/api/time", fn(_req) {
    @http.Response::json(200, "{\"service\":\"hello\",\"port\":8123,\"hits\":" + hits.val.to_string() + "}")
  })
  // 打印一行「可点的地址」—— IDE 会从输出里抓它并自动打开浏览器（runners.js）。
  // 必须写 **stderr**：stdout 在管道下是全缓冲的（底层 C stdio），而服务一直不退出，
  // 这行就永远不 flush —— IDE 自然抓不到 URL（实测：用 println 时前台跑都看不到输出）。
  @stdio.stderr.write("hello 已启动 → http://127.0.0.1:\{PORT}\n")
  @server.serve(router, "127.0.0.1", PORT)
}
