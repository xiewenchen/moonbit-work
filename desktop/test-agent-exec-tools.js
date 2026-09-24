'use strict'

/**
 * Agent 执行工具单测（Phase 2 / MBW-P7-01 ～ P7-10）
 *
 * 纯 Node：`executeCommand` / `request` 全靠注入 —— 所以能断言
 * 「执行**确实经命令表**」「失败**不重试**」「预算超了**不真的执行**」这些行为契约。
 */

const { API_LIMITS, EXEC_TOOL_SPECS, createExecuteToolRegistry } = require('./agent-exec-tools')

let pass = 0
let fail = 0
const failures = []
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
}

/** 记录调用次数的假命令表 */
function fakeDeps(over = {}) {
  const calls = { command: [], request: [] }
  return Object.assign({
    calls,
    executeCommand: async (name, args) => {
      calls.command.push({ name, args })
      return { ok: true, code: 0, stdout: 'built ok', stderr: '', duration: 12 }
    },
    request: async (spec) => {
      calls.request.push(spec)
      return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
    },
    runLog: async () => ({ state: 'RUNNING', result: { url: 'http://127.0.0.1:8123' } }),
    now: () => 1000,
  }, over)
}

async function main() {
  console.log('\n=== P7 工具清单 + Gate P7 的结构性保证 ===')
  {
    const reg = createExecuteToolRegistry(fakeDeps())
    const list = reg.list()
    chk('六个执行工具齐备', list.map((t) => t.name).sort(), ['apiRequest', 'build', 'health', 'run', 'stop', 'test'])
    chk('**全部是 execute 权限**（没有 write）', Array.from(new Set(list.map((t) => t.permission))), ['execute'])
    chk('每个都有超时与输出限额', list.every((t) => t.timeoutMs > 0 && t.maxOutputBytes > 0), true)
    chk('危险工具被标记', list.filter((t) => t.danger === 'high').map((t) => t.name).sort(), ['build', 'test'])
    chk('网络类工具标了 network', list.filter((t) => t.network).map((t) => t.name).sort(), ['apiRequest', 'health'])
    chk('SPEC 表与注册表一致', EXEC_TOOL_SPECS.map((s) => s.name).sort(), list.map((t) => t.name).sort())

    let threw = ''
    try {
      reg.register({ name: 'applyPatch', permission: 'write', timeoutMs: 5000, maxOutputBytes: 1024 }, async () => ({}))
    } catch (e) { threw = String(e && e.message) }
    chk('**注册 write 工具 → 抛错**（能跑但不能改）', /不允许 write/.test(threw), true)
    chk('表里没有写工具', reg.has('applyPatch'), false)
    chk('表里没有只读工具（那是另一张表）', reg.has('readFile'), false)
  }

  console.log('\n=== P7-01 强制经命令表 ===')
  {
    let threw = ''
    try { createExecuteToolRegistry({}) } catch (e) { threw = String(e && e.message) }
    chk('不注入 executeCommand → 构造就抛错（不许自己 spawn）', /executeCommand/.test(threw), true)

    const d = fakeDeps()
    const reg = createExecuteToolRegistry(d)
    await reg.call('build', { root: '/p' })
    await reg.call('test', {})
    await reg.call('run', { spec: { bin: 'node' } })
    await reg.call('stop', {})
    chk('四个工具都经命令表（且命令名正确）', d.calls.command.map((c) => c.name),
      ['project.build', 'project.test', 'project.run', 'project.stop'])
    const r = await reg.call('build', {})
    chk('返回里带命令名与结果', [r.ok, r.data.command, r.data.result.code], [true, 'project.build', 0])
  }

  console.log('\n=== P7-05 health / P7-06 apiRequest ===')
  {
    const d = fakeDeps()
    const reg = createExecuteToolRegistry(d)
    const h = await reg.call('health', { url: 'http://127.0.0.1:8123/health' })
    chk('health 带 url → 发请求', [h.ok, h.data.status, d.calls.request.length], [true, 200, 1])
    const h2 = await reg.call('health', {})
    chk('health 不带 url → 退回报告运行状态（不含猜测）', [h2.ok, /未提供 url/.test(String(h2.data.note))], [true, true])

    const a = await reg.call('apiRequest', { url: 'http://127.0.0.1:8090/api/user', method: 'get', headers: { 'X-A': '1' }, body: '{}' })
    chk('apiRequest 正常（method 会大写）', [a.ok, a.data.status, d.calls.request[1].method], [true, 200, 'GET'])

    const nou = await reg.call('apiRequest', {})
    chk('缺 url → 失败', [nou.ok, /缺少 url/.test(String(nou.error))], [false, true])
  }

  console.log('\n=== P7-07 API 规模限制（实现里强制）===')
  {
    const reg = createExecuteToolRegistry(fakeDeps())
    const many = {}
    for (let i = 0; i < API_LIMITS.maxHeaderCount + 1; i++) many['X-H' + i] = 'v'
    chk('请求头过多 → 拒', /请求头过多/.test(String((await reg.call('apiRequest', { url: 'http://x', headers: many })).error)), true)

    const big = { 'X-Big': 'v'.repeat(API_LIMITS.maxHeaderBytes + 10) }
    chk('请求头过大 → 拒', /请求头过大/.test(String((await reg.call('apiRequest', { url: 'http://x', headers: big })).error)), true)

    chk('请求体过大 → 拒', /请求体过大/.test(String((await reg.call('apiRequest', { url: 'http://x', body: 'B'.repeat(API_LIMITS.maxBodyBytes + 1) })).error)), true)
  }

  console.log('\n=== P7-08 审计日志 ===')
  {
    const d = fakeDeps()
    const reg = createExecuteToolRegistry(d)
    await reg.call('build', {})
    await reg.call('apiRequest', { url: 'http://127.0.0.1:1/x' })
    const audit = reg.audit()
    chk('每次调用留一条', audit.length, 2)
    chk('审计含 tool/result/duration/timestamp', audit.every((a) => a.tool && a.result && typeof a.duration === 'number' && typeof a.timestamp === 'number'), true)
    chk('失败也记', (await (async () => {
      const r2 = createExecuteToolRegistry(fakeDeps({ executeCommand: async () => ({ ok: false, error: '编译失败', code: 1 }) }))
      await r2.call('build', {})
      const a = r2.audit()
      return [a.length, a[0].result, /编译失败/.test(String(a[0].error))]
    })()), [1, 'fail', true])
  }

  console.log('\n=== P7-09 预算：超了**不真的执行** ===')
  {
    const d = fakeDeps()
    const reg = createExecuteToolRegistry(Object.assign({}, d, { budget: { maxCalls: 2, maxTotalMs: 10000 } }))
    await reg.call('build', {})
    await reg.call('test', {})
    const before = d.calls.command.length
    const blocked = await reg.call('run', {})
    chk('第 3 次被拒', [blocked.ok, /最大调用次数/.test(String(blocked.error))], [false, true])
    chk('**被拒时没有真的执行**', d.calls.command.length, before)
    chk('被拒也留审计（result=blocked）', reg.audit().some((a) => a.result === 'blocked'), true)
    chk('budget() 可查询', reg.budget().calls, 2)
  }

  console.log('\n=== P7-10 失败不重试 ===')
  {
    const d = fakeDeps({ executeCommand: async (name) => { d.calls.command.push({ name }); return { ok: false, code: 1, stdout: '', stderr: 'boom', error: '编译失败（退出码 1）' } } })
    const reg = createExecuteToolRegistry(d)
    const r = await reg.call('build', {})
    chk('返回失败与原因', [r.ok, /编译失败/.test(String(r.error))], [false, true])
    chk('**只执行一次（不自动重试）**', d.calls.command.length, 1)
  }

  console.log('\n=== 异常也不冒泡 ===')
  {
    const reg = createExecuteToolRegistry(fakeDeps({ executeCommand: async () => { throw new Error('命令表炸了') } }))
    const r = await reg.call('build', {})
    chk('抛错 → ok:false', [r.ok, /命令表炸了/.test(String(r.error))], [false, true])
    chk('未知工具 → 拒绝', (await reg.call('project.run', {})).ok, false)
    chk('未注入 request → 明确报错', /未注入/.test(String((await createExecuteToolRegistry(fakeDeps({ request: undefined })).call('health', { url: 'http://x' })).error)), true)
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('单测异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
