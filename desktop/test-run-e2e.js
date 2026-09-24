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
const NODE = process.execPath

let pass = 0
let fail = 0
const failures = []

function chk(name, ok, detail) {
  if (ok) {
    pass++
    console.log('  [PASS] ' + name)
  } else {
    fail++
    failures.push(name)
    console.log('  [FAIL] ' + name + (detail ? '   ' + detail : ''))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
