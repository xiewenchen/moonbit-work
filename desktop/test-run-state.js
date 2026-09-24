'use strict'

/**
 * Run 生命周期原语单测（Phase 2 / MBW-P1-14 ～ MBW-P1-18）
 *
 * 纯 Node：不依赖 Electron、不依赖 MoonBit native 构建 → 与本机工具链故障（R12）无关。
 * 断言失败只记录，不扩大修改范围（RULE-02）。
 */

const {
  RUN_STATE,
  ALL_STATES,
  ALLOWED_TRANSITIONS,
  isState,
  canTransition,
  createRunStateMachine,
  createProcessHandle,
  createStreamEvent,
  createRunResult,
} = require('./run-state')

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

console.log('\n=== P1-14 状态枚举 ===')
chk('7 个状态齐备', ALL_STATES, ['IDLE', 'BUILDING', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED'])
chk("RUN_STATE.IDLE 就是 'IDLE'", RUN_STATE.IDLE, 'IDLE')
chk('isState 认已知状态', isState('RUNNING'), true)
chk('isState 拒未知状态', isState('RUNNINGG'), false)
{
  try { RUN_STATE.IDLE = 'X' } catch (e) { /* 冻结对象在严格模式下赋值会抛，属预期 */ }
  chk('枚举被冻结（改不动）', RUN_STATE.IDLE, 'IDLE')
}

console.log('\n=== P1-15 状态转换：允许的 ===')
{
  const allowed = [
    ['IDLE', 'BUILDING'],
    ['BUILDING', 'STARTING'],
    ['BUILDING', 'FAILED'],
    ['STARTING', 'RUNNING'],
    ['STARTING', 'FAILED'],
    ['STARTING', 'STOPPING'],
    ['RUNNING', 'STOPPING'],
    ['RUNNING', 'FAILED'],
    ['STOPPING', 'STOPPED'],
  ]
  let allOk = true
  for (const [from, to] of allowed) {
    const m = createRunStateMachine({ initial: from })
    const r = m.to(to)
    if (!r.ok || m.state !== to) { allOk = false; console.log('      ✗ ' + from + ' → ' + to + ' ' + JSON.stringify(r)) }
  }
  chk('9 条允许的转换全部走通', allOk, true)
  chk('canTransition 对允许项返回 true', canTransition('RUNNING', 'STOPPING'), true)
}

console.log('\n=== P1-15 状态转换：禁止的 ===')
{
  const stopped = createRunStateMachine({ initial: RUN_STATE.STOPPED })
  const r1 = stopped.to(RUN_STATE.RUNNING)
  chk('STOPPED → RUNNING 被拒', r1.ok, false)
  chk('被拒后状态不变', stopped.state, RUN_STATE.STOPPED)

  const failed = createRunStateMachine({ initial: RUN_STATE.FAILED })
  chk('FAILED → RUNNING 被拒', failed.to(RUN_STATE.RUNNING).ok, false)

  const idle = createRunStateMachine()
  chk('跳级 IDLE → RUNNING 被拒', idle.to(RUN_STATE.RUNNING).ok, false)
  chk('未知状态名被拒', idle.to('NOPE').ok, false)

  const m = createRunStateMachine()
  m.to(RUN_STATE.BUILDING)
  m.to(RUN_STATE.STARTING)
  m.to(RUN_STATE.RUNNING)
  m.to(RUN_STATE.STOPPING)
  m.to(RUN_STATE.STOPPED)
  chk('走完一轮后 isTerminal', m.isTerminal(), true)
  chk('终态不能前进', m.to(RUN_STATE.STARTING).ok, false)
  chk('reset 后可重新进入 Run 流程', (m.reset(), m.state), RUN_STATE.IDLE)
  chk('reset 后 IDLE → BUILDING 又可走', m.to(RUN_STATE.BUILDING).ok, true)
  chk('history 有记录（含 reset）', m.history.length >= 7, true)
}

console.log('\n=== P1-15 观察者抛错不污染状态机 ===')
{
  const m = createRunStateMachine({
    onTransition: () => { throw new Error('observer boom') },
  })
  const r = m.to(RUN_STATE.BUILDING)
  chk('转换仍成功', r.ok, true)
  chk('状态已更新', m.state, RUN_STATE.BUILDING)
  chk('观察者错误被单独记录', m.observerErrors.length, 1)
}

console.log('\n=== P1-16 ProcessHandle ===')
{
  const killed = []
  const h = createProcessHandle({ pid: 4321, command: 'node fixture.js', cwd: '/tmp', kill: (s) => killed.push(s) })
  chk('字段齐备', [h.pid, h.command, h.cwd, typeof h.startTime === 'number'], [4321, 'node fixture.js', '/tmp', true])
  chk('初始状态 RUNNING', h.status, RUN_STATE.RUNNING)
  chk('stop() 走 SIGTERM', (h.stop(), killed), ['SIGTERM'])
  chk('stop 后状态 STOPPING', h.status, RUN_STATE.STOPPING)
  chk('重复 kill 安全（不重复杀）', h.kill().ok, false)
  chk('底层只被调用一次', killed.length, 1)
  h.recordExit(0)
  chk('recordExit 后 STOPPED', h.status, RUN_STATE.STOPPED)
  chk('exitCode 记录正确', h.exitCode, 0)
  chk('durationMs 非负', h.durationMs >= 0, true)
}
{
  const h = createProcessHandle({ pid: 1, kill: () => {} })
  h.recordExit(1)
  chk('自己崩掉（非 STOPPING 且 code≠0）→ FAILED', h.status, RUN_STATE.FAILED)
}
{
  const h = createProcessHandle({ pid: 2, kill: () => { throw new Error('kill failed') } })
  const r = h.kill()
  chk('kill 抛错 → ok:false + error', [r.ok, /kill failed/.test(String(r.error))], [false, true])
  chk('kill 抛错 → 状态 FAILED', h.status, RUN_STATE.FAILED)
}
{
  const h = createProcessHandle({ pid: 3, kill: () => {} })
  h.kill('SIGKILL')
  h.recordExit(137)
  chk('用户主动停止时 code≠0 也算 STOPPED', h.status, RUN_STATE.STOPPED)
}

console.log('\n=== P1-17 统一的流事件 ===')
{
  const a = createStreamEvent('stdout', 'hello', 111)
  chk('stdout 事件格式', a.event, { stream: 'stdout', chunk: 'hello', timestamp: 111 })
  chk('stderr 也支持', createStreamEvent('stderr', 'e').event.stream, 'stderr')
  chk('timestamp 缺省用当前时间', typeof createStreamEvent('stdout', 'x').event.timestamp, 'number')
  chk('chunk 为 null → 空串', createStreamEvent('stdout', null).event.chunk, '')
  chk('非法流名被拒', createStreamEvent('stdin', 'x').ok, false)
}

console.log('\n=== P1-18 RunResult ===')
{
  chk('默认值', createRunResult(), {
    ok: false, status: 'IDLE', exitCode: null, url: null, stdout: '', stderr: '', duration: null, error: null,
  })
  chk('RUNNING 且无 error → ok', createRunResult({ status: RUN_STATE.RUNNING }).ok, true)
  chk('FAILED → ok:false', createRunResult({ status: RUN_STATE.FAILED }).ok, false)
  chk('有 error → ok:false', createRunResult({ status: RUN_STATE.STOPPED, error: 'boom' }).ok, false)
  chk('duration 由起止时间算出', createRunResult({ startedAt: 1000, endedAt: 1500 }).duration, 500)
  chk('duration 只给一头 → null', createRunResult({ startedAt: 1000 }).duration, null)
  chk('类型归一（stdout 传数字）', createRunResult({ stdout: 42 }).stdout, '42')
  chk('完整结果', createRunResult({
    status: RUN_STATE.STOPPED, exitCode: 0, url: 'http://127.0.0.1:8123',
    stdout: 'ok', stderr: '', startedAt: 10, endedAt: 2010,
  }), {
    ok: true, status: 'STOPPED', exitCode: 0, url: 'http://127.0.0.1:8123',
    stdout: 'ok', stderr: '', duration: 2000, error: null,
  })
}

console.log('\n=== 转换表自检 ===')
{
  chk('终态没有出边', [
    ALLOWED_TRANSITIONS[RUN_STATE.STOPPED].length,
    ALLOWED_TRANSITIONS[RUN_STATE.FAILED].length,
  ], [0, 0])
  chk('每个状态都出现在转换表里', Object.keys(ALLOWED_TRANSITIONS).length, 7)
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
