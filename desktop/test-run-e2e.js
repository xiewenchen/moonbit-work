'use strict'

/**
 * Run 链路 E2E（Phase 2 / MBW-P1-19 前置）—— 把「点运行 → 服务起来 → 抓到 URL → 打开浏览器 → 停止」
 * 这条链路放到**纯 Node** 里验证，因此：
 *   · 不依赖 Electron（不需要显示环境）
 *   · 不依赖 MoonBit native 构建（本机 R12 坏掉也能跑）
 *   · 能在 Linux CI 上跑 → 这就是「把 Run E2E 搬进 CI」
 *
 * 靶子是 desktop/testdata/fixture-http-server.js（零依赖 Node 服务，端口由系统分配）。
 *
 * 覆盖（对应清单里的原子任务）：
 *   P1-19 链路：spawn → 收集输出 → 抓 URL → （浏览器）→ 停止
 *   P1-20 浏览器打开（用可注入的 openUrl 观察）
 *   P1-21 浏览器失败不得把服务标成失败
 *   P1-22 stop 后进程结束
 *   P1-23 重复 stop 安全
 *   P1-24 启动失败（可执行文件不存在）
 *   P1-26 进程提前退出
 *   + 真实链路下的跨 chunk URL、无 URL 输出不误报、同一时刻只跑一个
 * 未覆盖（留给后续）：P1-25（无监听超时）、P1-27～P1-29（连续 10 次）—— 需要状态机/超时语义（P1-14～P1-18）。
 */

const path = require('path')
const { createServiceRunner } = require('./runners')

const FIXTURE = path.join(__dirname, 'testdata', 'fixture-http-server.js')
const { createHarness } = require('./verify-harness')
const NODE = process.execPath

const H = createHarness()
const chk = H.chk

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 进程是否还活着（用来查僵尸）*/
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (_) {
    return false
  }
}

/** 轮询直到 fn() 返回真值或超时 */
async function waitUntil(fn, { timeout = 15000, interval = 100 } = {}) {
  const t0 = Date.now()
  for (;;) {
    let v = null
    try { v = await fn() } catch (_) { v = null }
    if (v) return v
    if (Date.now() - t0 > timeout) return null
    await sleep(interval)
  }
}

/** 端口是否已不可连 */
async function portGone(url, timeout = 8000) {
  return await waitUntil(async () => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) })
      return null
    } catch (_) {
      return true
    }
  }, { timeout })
}

async function main() {
  console.log('\n=== ① 起真实服务 → 抓 URL → 开浏览器 → 页面可访问 → 停止 ===')
  let firstUrl = null
  {
    const opened = []
    const chunks = []
    const runner = createServiceRunner({ openUrl: (u) => opened.push(u) })
    const r = runner.start(
      { bin: NODE, args: [FIXTURE], cwd: __dirname, label: 'fixture' },
      { onData: (d) => chunks.push(d) },
    )
    chk('start() 返回 pid', r.ok === true && typeof r.pid === 'number', JSON.stringify(r))

    const url = await waitUntil(() => opened[0], { timeout: 15000 })
    firstUrl = url
    chk(
      '抓到本地 URL（据此才能自动开浏览器）',
      typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(url),
      String(url),
    )
    chk('openUrl 恰好被调用一次', opened.length === 1, 'n=' + opened.length)
    chk('收到过输出流', chunks.length > 0, 'chunks=' + chunks.length)

    if (url) {
      let code = 0
      let body = ''
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
        code = res.status
        body = await res.text()
      } catch (e) {
        body = 'ERR ' + String((e && e.message) || e)
      }
      chk('页面能打开且内容正确', code === 200 && /fixture ok/.test(body), `code=${code} body=${String(body).slice(0, 60)}`)
    }

    const s = runner.stop()
    chk('stop() 返回 ok', s.ok === true, JSON.stringify(s))
    chk('stop() 后 running=false', runner.running === false, String(runner.running))
    if (url) {
      chk('停止后端口不再可连（进程真的结束了）', (await portGone(url)) === true, 'still reachable')
    }

    console.log('\n=== ② 重复 stop 必须安全（P1-23）===')
    const s2 = runner.stop()
    chk('第二次 stop 返回 ok:false 且不抛', s2 && s2.ok === false && typeof s2.error === 'string', JSON.stringify(s2))
  }

  console.log('\n=== ③ 真实链路下的跨 chunk URL（P1-19）===')
  {
    process.env.FIXTURE_SPLIT = '1'
    const opened = []
    const runner = createServiceRunner({ openUrl: (u) => opened.push(u) })
    runner.start({ bin: NODE, args: [FIXTURE], cwd: __dirname }, {})
    const url = await waitUntil(() => opened[0], { timeout: 15000 })
    chk('URL 被 3 次 write 拆开仍能抓全', typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(url), String(url))
    runner.stop()
    delete process.env.FIXTURE_SPLIT
  }

  console.log('\n=== ④ 无 URL 输出时不得误报（P1-19）===')
  {
    const urls = []
    const runner = createServiceRunner({ openUrl: (u) => urls.push(u) })
    runner.start({ bin: NODE, args: ['-e', 'console.log("nothing to see here")'], cwd: __dirname }, {})
    await sleep(2000)
    chk('不触发 onUrl', urls.length === 0, 'n=' + urls.length)
    runner.stop()
  }

  console.log('\n=== ⑤ 浏览器打不开 ≠ 服务失败（P1-21）===')
  {
    const events = []
    const runner = createServiceRunner({
      openUrl: () => { throw new Error('open failed') },
    })
    runner.start({ bin: NODE, args: [FIXTURE], cwd: __dirname }, {
      onBrowserOpen: (x) => events.push(x),
    })
    const ev = await waitUntil(() => events[0] || null, { timeout: 15000 })
    chk('浏览器失败被单独上报（ok:false + 原因）', !!ev && ev.ok === false && /open failed/.test(String(ev.error)), JSON.stringify(ev))
    chk('浏览器失败时服务状态不受影响（仍在运行）', runner.running === true, String(runner.running))
    runner.stop()
  }

  console.log('\n=== ⑥ 启动失败：可执行文件不存在（P1-24）===')
  {
    const ended = []
    const runner = createServiceRunner({})
    runner.start({ bin: path.join(__dirname, 'no-such-binary-xyz.exe'), args: [], cwd: __dirname }, {
      onEnd: (x) => ended.push(x),
    })
    const e = await waitUntil(() => ended.find((x) => x && x.ok === false) || null, { timeout: 10000 })
    chk('经 onEnd 上报 ok:false 且带原因', !!e && /无法执行|启动失败/.test(String(e.error)), JSON.stringify(e))
  }

  console.log('\n=== ⑦ 进程提前退出（P1-26）===')
  {
    const ended = []
    const runner = createServiceRunner({})
    runner.start({ bin: NODE, args: ['-e', 'process.exit(1)'], cwd: __dirname }, {
      onEnd: (x) => ended.push(x),
    })
    const e = await waitUntil(() => ended.find((x) => x && typeof x.code === 'number') || null, { timeout: 10000 })
    chk('上报退出码 1', !!e && e.code === 1, JSON.stringify(e))
    chk('退出后 running=false', runner.running === false, String(runner.running))
  }

  console.log('\n=== ⑧ 同一时刻只跑一个进程（P1-19）===')
  {
    const runner = createServiceRunner({})
    const a = runner.start({ bin: NODE, args: [FIXTURE], cwd: __dirname }, {})
    await sleep(800)
    const b = runner.start({ bin: NODE, args: [FIXTURE], cwd: __dirname }, {})
    chk('第二次 start 会换掉上一个进程', a.pid !== b.pid && runner.running === true, `a=${a.pid} b=${b.pid}`)
    runner.stop()
  }

  console.log('\n=== ⑨ 状态流转与顺序：detect → update state → open browser（P1-19）===')
  {
    const seen = []
    let stateAtUrl = null
    let stateAtBrowser = null
    const runner = createServiceRunner({
      openUrl: () => { stateAtBrowser = runner.state },
    })
    runner.start({ bin: NODE, args: [FIXTURE], cwd: __dirname }, {
      onState: (s) => seen.push(s),
      onUrl: () => { stateAtUrl = runner.state },   // 抓 URL 的那一刻，状态应该**已经**是 RUNNING
    })
    chk('start() 后进入 STARTING', runner.state === 'STARTING', runner.state)

    await waitUntil(() => stateAtUrl, { timeout: 15000 })
    chk('抓到 URL 时状态已是 RUNNING（顺序：detect → update state → open browser）', stateAtUrl === 'RUNNING', String(stateAtUrl))
    chk('打开浏览器时状态也是 RUNNING', stateAtBrowser === 'RUNNING', String(stateAtBrowser))

    runner.stop()
    chk('stop() 后进入 STOPPING', runner.state === 'STOPPING', runner.state)
    await waitUntil(() => (runner.state === 'STOPPED' ? true : null), { timeout: 8000 })
    chk('进程结束后进入 STOPPED', runner.state === 'STOPPED', runner.state)
    chk('onState 收到过 RUNNING / STOPPING / STOPPED', ['RUNNING', 'STOPPING', 'STOPPED'].every((s) => seen.includes(s)), true)
  }

  console.log('\n=== ⑩ onEnd 汇报 RunResult（P1-18 接线）===')
  {
    let ended = null
    const runner = createServiceRunner({})
    runner.start({ bin: NODE, args: [FIXTURE], cwd: __dirname }, { onEnd: (r) => { ended = r } })
    await waitUntil(() => (runner.state === 'RUNNING' ? true : null), { timeout: 15000 })
    runner.stop()
    const r = await waitUntil(() => ended, { timeout: 8000 })
    const keys = ['ok', 'status', 'exitCode', 'url', 'stdout', 'stderr', 'duration', 'error']
    chk('onEnd 带全 RunResult 字段', !!r && keys.every((k) => k in r), keys.filter((k) => !r || !(k in r)).join(','))
    chk('status = STOPPED', !!r && r.status === 'STOPPED', String(r && r.status))
    chk('url 被记进结果', /^http:\/\/127\.0\.0\.1:\d+$/.test(String(r && r.url)), String(r && r.url))
    chk('duration 非负', !!r && r.duration >= 0, String(r && r.duration))
    chk('stdout 里有服务输出', !!r && String(r.stdout).includes('Server at'), String(r && r.stdout).slice(0, 40))
    chk('ok = true（没失败）', !!(r && r.ok), JSON.stringify(r && { ok: r.ok, error: r.error }))
    chk('renderer 依赖的 code 字段仍在（被信号终止时可为 null，属正常）', !!r && 'code' in r, String(r && r.code))
  }

  console.log('\n=== ⑪ 统一的流事件（P1-17 接线）===')
  {
    const evs = []
    const runner = createServiceRunner({})
    runner.start({ bin: NODE, args: [FIXTURE], cwd: __dirname }, { onStreamEvent: (e) => evs.push(e) })
    await waitUntil(() => evs.length || null, { timeout: 15000 })
    runner.stop()
    const e0 = evs[0]
    chk('事件形状 {stream, chunk, timestamp}', !!e0
      && ['stdout', 'stderr'].includes(e0.stream)
      && typeof e0.chunk === 'string'
      && typeof e0.timestamp === 'number', JSON.stringify(e0))
  }

  console.log('\n=== ⑫ 无监听服务超时（P1-25）===')
  {
    const ended = []
    const runner = createServiceRunner({ startTimeout: 1500 })   // 窗口留宽：免得进程冷启动比超时还慢（并发跑时会 flaky）
    runner.start(
      { bin: NODE, args: ['-e', 'console.log("starting up, will never listen"); setInterval(() => {}, 1000)'], cwd: __dirname },
      { onEnd: (r) => ended.push(r) },
    )
    const hungPid = runner.handle && runner.handle.pid
    chk('start 后处于 STARTING', runner.state === 'STARTING', runner.state)

    const r = await waitUntil(() => ended[0] || null, { timeout: 10000 })
    chk('超时后变 FAILED', runner.state === 'FAILED', runner.state)
    chk('错误信息含「超时」', /超时/.test(String(r && r.error)), String(r && r.error))
    chk('结果 ok=false', !!(r && r.ok === false), JSON.stringify(r && { ok: r.ok, status: r.status }))
    chk('running=false', runner.running === false, String(runner.running))
    if (hungPid) {
      const dead = await waitUntil(() => (isAlive(hungPid) ? null : true), { timeout: 5000 })
      chk('超时后进程被清掉（不留孤儿）', dead === true, 'pid ' + hungPid + ' 仍存活')
    }
  }

  console.log('\n=== ⑬ 连续 10 次 Run（P1-27）===')
  {
    const RUNS = 10
    const urls = []
    let reachedRunning = 0
    for (let i = 0; i < RUNS; i++) {
      const runner = createServiceRunner({ openUrl: (u) => urls.push(u), startTimeout: 10000 })
      runner.start({ bin: NODE, args: [FIXTURE], cwd: __dirname }, {})
      const ok = await waitUntil(() => (runner.state === 'RUNNING' ? true : null), { timeout: 10000 })
      if (ok) reachedRunning++
      runner.stop()
      await waitUntil(() => (runner.state === 'STOPPED' ? true : null), { timeout: 8000 })
    }
    chk(RUNS + ' 次都进入 RUNNING 且拿到 URL', reachedRunning === RUNS && urls.length === RUNS, `running=${reachedRunning} urls=${urls.length}`)
  }

  console.log('\n=== ⑭ Run/Stop × 10：无僵尸 / 无永久 STARTING（P1-28）===')
  {
    const RUNS = 10
    const runner = createServiceRunner({ startTimeout: 10000 })
    const pids = []
    const browserErrors = []
    let stuck = 0
    const t0 = Date.now()

    for (let i = 0; i < RUNS; i++) {
      runner.start({ bin: NODE, args: [FIXTURE], cwd: __dirname }, {
        onBrowserOpen: (b) => { if (!b.ok) browserErrors.push(b) },
      })
      const pid = runner.handle && runner.handle.pid
      if (pid) pids.push(pid)
      await waitUntil(() => (runner.state === 'RUNNING' ? true : null), { timeout: 10000 })
      runner.stop()
      await waitUntil(() => (runner.state === 'STOPPED' ? true : null), { timeout: 8000 })
      if (runner.state !== 'STOPPED') stuck++
      if (pid) await waitUntil(() => (isAlive(pid) ? null : true), { timeout: 5000 })
    }

    const alive = pids.filter((p) => isAlive(p)).length
    const elapsed = Date.now() - t0
    chk(RUNS + ' 轮都停在 STOPPED（0 永久 STARTING / RUNNING）', stuck === 0, 'stuck=' + stuck)
    chk(RUNS + ' 个进程全部退出（0 僵尸）', alive === 0, `alive=${alive}/${pids.length}`)
    chk('每轮都是新进程', new Set(pids).size === pids.length, `unique=${new Set(pids).size}/${pids.length}`)

    console.log('\n=== ⑮ 红线汇总（P1-29）===')
    chk('0 zombie', alive === 0, String(alive))
    chk('0 永久 STARTING', stuck === 0, String(stuck))
    chk('0 browser 错误', browserErrors.length === 0, JSON.stringify(browserErrors.slice(0, 2)))
    chk('没卡死（10 轮 ' + Math.round(elapsed / 1000) + 's，上限 60s）', elapsed < 60000, elapsed + 'ms')
  }

  console.log('\n=== ⑯ 超时是 inactivity 语义：持续输出不会被误杀（P1-25）===')
  {
    const runner = createServiceRunner({ startTimeout: 1500 })
    // 每 300ms 吐一行 —— 永远不监听端口，但一直在输出（模拟「编译很久」）
    runner.start(
      { bin: NODE, args: ['-e', 'setInterval(() => console.log("compiling..."), 300)'], cwd: __dirname },
      {},
    )
    await sleep(4000)   // 远超 1500ms 的静默窗口
    chk('持续有输出 → 不判超时（仍是 STARTING）', runner.state === 'STARTING', runner.state)
    runner.stop()
    await waitUntil(() => (runner.state === 'STOPPED' ? true : null), { timeout: 6000 })
    chk('停止后回到 STOPPED', runner.state === 'STOPPED', runner.state)
  }

  console.log('\n=== ⑰ 停止兜底：不理会 SIGTERM 的服务也会被清掉（P1-22）===')
  {
    // 这个靶子**故意忽略 SIGTERM** —— 没有兜底强杀的话它会活下来，成为僵尸
    const runner = createServiceRunner({ stopGraceMs: 600 })
    runner.start(
      { bin: NODE, args: ['-e', 'process.on("SIGTERM", () => {}); console.log("stubborn service up"); setInterval(() => {}, 1000)'], cwd: __dirname },
      {},
    )
    const pid = runner.handle && runner.handle.pid
    await sleep(500)
    chk('顽固进程确实起来了', ['STARTING', 'RUNNING'].includes(runner.state), runner.state)

    runner.stop()
    const dead = pid ? await waitUntil(() => (isAlive(pid) ? null : true), { timeout: 8000 }) : null
    chk('忽略 SIGTERM 的进程也被清掉（无僵尸）', dead === true, 'pid ' + pid + ' 仍存活')
  }

  console.log('\n=== ⑱ shell 启动的服务也要能停干净（无孤儿）（P1-22）===')
  {
    // bin 故意用**不带扩展名**的 'node' —— Windows 上这会走 shell:true（cmd.exe 包一层），
    // 只杀 cmd 就会把真正的服务进程留成孤儿（实测：状态回到 STOPPED，端口却一直可连）。
    let url = null
    const runner = createServiceRunner({})
    runner.start({ bin: 'node', args: [FIXTURE], cwd: __dirname }, { onUrl: (u) => { url = u } })
    const got = await waitUntil(() => url, { timeout: 15000 })
    chk('shell 启动的服务起来了并拿到 URL', !!got, String(got))

    runner.stop()
    const closed = await waitUntil(async () => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(400) })
        return null
      } catch (_) {
        return true
      }
    }, { timeout: 8000 })
    chk('停止后端口不再可连（真正的服务进程被杀掉，不是只杀了 cmd）', closed === true, String(url))
  }

  console.log('\n' + H.summary())
  if (H.fail) console.log('失败项：\n  - ' + H.failures.join('\n  - '))
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.error('E2E 异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
