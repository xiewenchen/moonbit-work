'use strict'

/**
 * Command Registry 单测（Phase 2 / MBW-P3-01 ～ P3-08、P3-13 ～ P3-15）
 *
 * 纯 Node：依赖全部注入假实现（不 spawn、不 require electron、不跑 moon），
 * 所以既能在本机跑，也能在 Linux CI 上守。
 */

const {
  COMMAND_PERMISSIONS,
  DEFAULT_TIMEOUT_MS,
  commandResult,
  withTimeout,
  createCommandRegistry,
  registerProjectCommands,
  buildCommandFor,
  testCommandFor,
} = require('./commands')

let pass = 0
let fail = 0
const failures = []

function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
    console.log('  [PASS] ' + name)
  } else {
    fail++
    failures.push(name)
    console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 造一套假依赖，记录调用 */
function fakeDeps() {
  const calls = { run: [], start: [], stop: 0 }
  const runner = {
    state: 'IDLE',
    start(spec) { calls.start.push(spec); runner.state = 'STARTING'; return { ok: true, pid: 4242 } },
    stop() { calls.stop++; return { ok: true, signal: 'SIGTERM' } },
  }
  const runCmd = async (spec) => {
    calls.run.push(spec)
    return { code: 0, stdout: 'ok:' + spec.bin, stderr: '' }
  }
  return { calls, runner, runCmd, deps: { runner, runCmd, pathExists: () => true, rootOf: (x) => (typeof x === 'string' ? x : (x && x.rootDir) || '') } }
}

async function main() {
  console.log('\n=== P3-03 CommandResult ===')
  chk('默认（ok:false）', commandResult(), { ok: false, code: 1, data: null, stdout: '', stderr: '', duration: null, error: null })
  chk('ok:true → code 0', commandResult({ ok: true }).code, 0)
  chk('类型归一（stdout 传数字）', commandResult({ stdout: 42 }).stdout, '42')
  chk('data 未给 → null（不是 undefined）', commandResult({ ok: true }).data, null)
  chk('error 非字符串也归一', commandResult({ ok: false, error: new Error('boom') }).error, 'Error: boom')

  console.log('\n=== P3-01/P3-02 注册表 ===')
  {
    const skip = createCommandRegistry()
    let threw = ''
    try { skip.register({ name: 'x' }) } catch (e) { threw = String(e && e.message) }
    chk('缺 handler → 报错', /handler/.test(threw), true)
    threw = ''
    try { skip.register({ handler: () => {} }) } catch (e) { threw = String(e && e.message) }
    chk('缺 name → 报错', /name/.test(threw), true)

    skip.register({ name: 'a.b', handler: () => {} })
    threw = ''
    try { skip.register({ name: 'a.b', handler: () => {} }) } catch (e) { threw = String(e && e.message) }
    chk('重复注册 → 报错', /已注册/.test(threw), true)

    threw = ''
    try { skip.register({ name: 'c.d', permissions: ['sudo'], handler: () => {} }) } catch (e) { threw = String(e && e.message) }
    chk('未知权限 → 报错', /未知权限/.test(threw), true)

    const cmd = skip.get('a.b')
    chk('默认权限 = read', cmd.permissions, ['read'])
    chk('默认超时 = 60s', cmd.timeoutMs, DEFAULT_TIMEOUT_MS)
    chk('权限等级常量', COMMAND_PERMISSIONS, ['read', 'execute', 'write'])
    chk('list() 不含 handler', Object.keys(skip.list()[0]).sort(), ['danger', 'name', 'permissions', 'timeoutMs', 'title'])
    chk('has() 正确', [skip.has('a.b'), skip.has('nope')], [true, false])
  }

  console.log('\n=== P3-13/P3-14/P3-15 执行 / 日志 / 超时 ===')
  {
    const logs = []
    const reg = createCommandRegistry({ logger: (e) => logs.push(e) })
    reg.register({ name: 'ok.cmd', handler: async () => ({ ok: true, data: { hi: 1 }, stdout: 'out' }) })
    reg.register({ name: 'raw.cmd', handler: async () => ({ anything: true }) })
    reg.register({ name: 'boom.cmd', handler: async () => { throw new Error('handler 炸了') } })
    reg.register({ name: 'slow.cmd', timeoutMs: 60, handler: async () => { await sleep(400); return { ok: true } } })

    const unknown = await reg.execute('nope.cmd')
    chk('未知命令 → ok:false', [unknown.ok, /未知命令/.test(String(unknown.error))], [false, true])

    const ok = await reg.execute('ok.cmd')
    chk('正常：字段规范化', [ok.ok, ok.code, ok.stdout, ok.data], [true, 0, 'out', { hi: 1 }])
    chk('duration 是数字且 ≥0', typeof ok.duration === 'number' && ok.duration >= 0, true)

    const raw = await reg.execute('raw.cmd')
    chk('handler 返回普通对象 → 包成 ok:true/data', [raw.ok, raw.data], [true, { anything: true }])

    const boom = await reg.execute('boom.cmd')
    chk('handler 抛错 → ok:false（不冒泡）', [boom.ok, /handler 炸了/.test(String(boom.error))], [false, true])

    const t0 = Date.now()
    const slow = await reg.execute('slow.cmd')
    const took = Date.now() - t0
    chk('超时 → ok:false 且含「超时」', [slow.ok, /超时/.test(String(slow.error))], [false, true])
    chk('超时后立刻返回（不等 400ms）', took < 350, true)

    const overridden = await reg.execute('slow.cmd', {}, { timeoutMs: 0 })
    chk('opts.timeoutMs=0 → 关闭超时（等到它跑完）', overridden.ok, true)

    const phases = logs.map((l) => l.phase)
    chk('日志记录了 register / start / finish / error', ['register', 'start', 'finish', 'error'].every((p) => phases.includes(p)), true)
    const finishLog = logs.find((l) => l.phase === 'finish')
    chk('finish 日志带 duration', typeof finishLog.duration === 'number', true)
  }

  console.log('\n=== withTimeout 直接测 ===')
  {
    const r = await withTimeout(new Promise((res) => setTimeout(() => res('late'), 300)), 50, 't').catch((e) => String(e && e.message))
    chk('超时抛错且带命令名', /超时/.test(r) && /t/.test(r), true)
    const ok = await withTimeout(Promise.resolve('v'), 1000, 't')
    chk('未超时正常 resolve', ok, 'v')
    const off = await withTimeout(Promise.resolve('v'), 0, 't')
    chk('ms<=0 表示不限时', off, 'v')
  }

  console.log('\n=== P3-04～P3-08 六个项目命令 ===')
  {
    const { calls, runner, runCmd, deps } = fakeDeps()
    const reg = createCommandRegistry()
    registerProjectCommands(reg, deps)
    chk('注册了 6 个命令', reg.list().map((c) => c.name).sort(), ['project.build', 'project.close', 'project.open', 'project.run', 'project.stop', 'project.test'])
    chk('危险命令被标记', reg.list().filter((c) => c.danger).map((c) => c.name).sort(), ['project.build', 'project.test'])

    const noDir = await reg.execute('project.open', {})
    chk('project.open 缺目录 → 失败', [noDir.ok, /缺少目录/.test(String(noDir.error))], [false, true])
    const okOpen = await reg.execute('project.open', { dir: '/tmp/x' })
    chk('project.open 正常 → rootDir', [okOpen.ok, okOpen.data.rootDir], [true, '/tmp/x'])

    const missing = createCommandRegistry()
    registerProjectCommands(missing, Object.assign({}, deps, { pathExists: () => false }))
    const bad = await missing.execute('project.open', { dir: '/nope' })
    chk('project.open 目录不存在 → 失败', [bad.ok, /目录不存在/.test(String(bad.error))], [false, true])

    await reg.execute('project.run', { spec: { bin: 'node', args: ['s.js'], cwd: '/tmp/x', label: 'x' } })
    chk('project.run 把 spec 透传给 runner', calls.start, [{ bin: 'node', args: ['s.js'], cwd: '/tmp/x', label: 'x' }])
    const noBin = await reg.execute('project.run', {})
    chk('project.run 缺 bin → 失败', [noBin.ok, /缺少可运行入口/.test(String(noBin.error))], [false, true])

    await reg.execute('project.stop', {})
    await reg.execute('project.close', {})
    chk('project.stop 与 project.close 都调了 runner.stop', calls.stop, 2)

    const b = await reg.execute('project.build', { root: '/tmp/x', projectType: 'moonbit' })
    chk('project.build（moonbit）→ moon build --target native', [b.ok, calls.run[0].bin, calls.run[0].args], [true, 'moon', ['build', '--target', 'native']])
    chk('build 结果透传 stdout', b.stdout, 'ok:moon')

    const t = await reg.execute('project.test', { root: '/tmp/x', projectType: 'node' })
    chk('project.test（node）→ npm test', [t.ok, calls.run[1].bin, calls.run[1].args], [true, 'npm', ['test']])

    const noCtx = await reg.execute('project.build', {})
    chk('未打开项目 → build 失败', [noCtx.ok, /未打开项目/.test(String(noCtx.error))], [false, true])

    // 失败路径：runCmd 返回非 0
    const reg2 = createCommandRegistry()
    registerProjectCommands(reg2, Object.assign({}, deps, {
      runCmd: async () => ({ code: 2, stdout: '', stderr: 'boom' }),
    }))
    const failed = await reg2.execute('project.test', { root: '/tmp/x' })
    chk('测试失败 → ok:false + code + stderr', [failed.ok, failed.code, failed.stderr], [false, 2, 'boom'])
  }

  console.log('\n=== 命令映射（按项目类型）===')
  chk('moonbit build', buildCommandFor('moonbit').args, ['build', '--target', 'native'])
  chk('node build', buildCommandFor('node'), { bin: 'npm', args: ['run', 'build'] })
  chk('go test', testCommandFor('go').args, ['test', './...'])
  chk('未知类型 → 退回 moon', buildCommandFor('wat').bin, 'moon')

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('单测异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
