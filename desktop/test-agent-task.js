// PH3-TASK 的验证：任务模型 + 状态机 + 预算 + 崩溃恢复。
//
// 纯逻辑（全依赖注入），所以不需要真实模型、不需要 Electron —— 可直接进 CI。
const { createHarness } = require('./verify-harness')
const {
  TASK_STATUS, ALL_STATUSES, TERMINAL, ALLOWED_TRANSITIONS, DEFAULT_BUDGET,
  isTerminal, canTransition, createTask, transition, checkBudget, consume,
  createToolCall, needsUser, recoverInterrupted, describeTask,
} = require('./agent-task')

const H = createHarness()
const { chk, eq } = H

console.log('=== ① TASK-02 状态集合 ===')
{
  const want = ['CREATED', 'UNDERSTANDING', 'PLANNING', 'EXECUTING', 'WAITING_USER', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED']
  for (const s of want) chk('有状态 ' + s, !!TASK_STATUS[s], TASK_STATUS[s])
  chk('★ 另有 INTERRUPTED（崩溃恢复用，清单 TASK-16）', TASK_STATUS.INTERRUPTED === 'INTERRUPTED')
  eq('共 10 个状态（9 + INTERRUPTED）', ALL_STATUSES.length, 10)
  eq('终态恰为 COMPLETED/FAILED/CANCELLED', TERMINAL.slice().sort(), ['CANCELLED', 'COMPLETED', 'FAILED'])
}

console.log('\n=== ② TASK-01/03 创建任务 ===')
{
  const t = createTask({ id: 't1', sessionId: 's1', goal: '修复登录 API', now: 1000 })
  eq('id 保留', t.id, 't1')
  eq('goal 保留', t.goal, '修复登录 API')
  eq('初始状态 CREATED', t.status, 'CREATED')
  eq('startedAt 用传入的 now', t.startedAt, 1000)
  eq('finishedAt 一开始为 null', t.finishedAt, null)
  chk('带预算', t.budget.maxToolCalls === DEFAULT_BUDGET.maxToolCalls)
  chk('带用量计数（从 0 起）', t.usage.toolCalls === 0 && t.usage.patchCount === 0)
  chk('冻结（不可改）', Object.isFrozen(t))

  const t2 = createTask({})
  chk('不传 id 也能生成一个', typeof t2.id === 'string' && t2.id.length > 4)
  chk('不传 goal 不炸', t2.goal === '')
}

console.log('\n=== ③ TASK-04~06 合法状态迁移 ===')
{
  let t = createTask({ id: 't', goal: 'g', now: 0 })
  const steps = [
    [TASK_STATUS.UNDERSTANDING, '理解'],
    [TASK_STATUS.PLANNING, '规划'],
    [TASK_STATUS.EXECUTING, '执行'],
    [TASK_STATUS.VERIFYING, '验证'],
    [TASK_STATUS.COMPLETED, '完成'],
  ]
  for (const [to, label] of steps) {
    const r = transition(t, to, { now: 100 })
    chk('CREATED→…→' + label + ' 允许', r.ok === true, JSON.stringify(r).slice(0, 100))
    t = r.task
  }
  eq('走到 COMPLETED', t.status, 'COMPLETED')
  chk('终态带 finishedAt', t.finishedAt === 100)
}

console.log('\n=== ④ 非法迁移必须被拒（且不污染原状态）===')
{
  const t = createTask({ id: 't', now: 0 })
  const r = transition(t, TASK_STATUS.COMPLETED)
  eq('CREATED → COMPLETED 直接跳：拒绝', r.ok, false)
  eq('  给出 code', r.code, 'ILLEGAL_TRANSITION')
  eq('★ 原对象状态没被改（不污染）', t.status, 'CREATED')

  const done = transition(transition(transition(createTask({ now: 0 }), TASK_STATUS.UNDERSTANDING, { now: 1 }).task, TASK_STATUS.PLANNING, { now: 2 }).task, TASK_STATUS.EXECUTING, { now: 3 }).task
  chk('未知状态被拒', transition(done, 'NOT_A_STATUS').ok === false)
  chk('坏任务被拒', transition(null, TASK_STATUS.PLANNING).ok === false)

  // 终态没有出边
  const cancelled = transition(createTask({ now: 0 }), TASK_STATUS.CANCELLED, { now: 1 }).task
  for (const s of ALL_STATUSES) {
    if (s === 'INTERRUPTED') continue
    chk('终态 CANCELLED 无出边 → ' + s, canTransition(cancelled.status, s) === false)
  }
}

console.log('\n=== ⑤ TASK-15 任何非终态都能取消 ===')
{
  for (const s of ['CREATED', 'UNDERSTANDING', 'PLANNING', 'EXECUTING', 'WAITING_USER', 'VERIFYING', 'INTERRUPTED']) {
    chk(s + ' 能 → CANCELLED', canTransition(s, 'CANCELLED') === true)
  }
  chk('终态不能再取消（已完成的就是完成的）', canTransition('COMPLETED', 'CANCELLED') === false)
}

console.log('\n=== ⑥ TASK-08/09/10 用户等待点 ===')
{
  eq('patch 步骤 → 需要等用户', needsUser({ kind: 'patch' }), 'patch')
  eq('危险命令 → 需要等用户', needsUser({ kind: 'dangerous-command' }), 'dangerous-command')
  eq('dangerous 标记也对', needsUser({ action: 'run', dangerous: true }), 'dangerous-command')
  eq('普通读操作 → 不需要等', needsUser({ kind: 'read', action: 'readFile' }), null)
  eq('空步骤 → null（不炸）', needsUser(null), null)

  // WAITING_USER 的进出
  let t = transition(transition(createTask({ now: 0 }), 'UNDERSTANDING', { now: 1 }).task, 'PLANNING', { now: 2 }).task
  t = transition(t, 'EXECUTING', { now: 3 }).task
  t = transition(t, 'WAITING_USER', { now: 4 }).task
  eq('执行中遇到补丁 → WAITING_USER', t.status, 'WAITING_USER')
  chk('★ 用户确认后可回 EXECUTING（TASK-09）', transition(t, 'EXECUTING', { now: 5 }).ok === true)
  chk('★ 用户取消 → CANCELLED（TASK-10）', transition(t, 'CANCELLED', { now: 5 }).ok === true)
  chk('等待中不能直接跳到 COMPLETED（要经过验证）', canTransition('WAITING_USER', 'COMPLETED') === false)
}

console.log('\n=== ⑦ TASK-11/12/13 预算：执行前检查，耗尽即停 ===')
{
  const t = createTask({ now: 0, budget: { maxToolCalls: 3, maxPatchCount: 2, maxDuration: 1000 } })
  chk('初始预算充足', checkBudget(t, 'tool', { now: 0 }).ok === true)

  let cur = t
  for (let i = 0; i < 3; i++) cur = consume(cur, 'tool')
  eq('用了 3 次工具', cur.usage.toolCalls, 3)

  const over = checkBudget(cur, 'tool', { now: 10 })
  eq('★ 第 4 次前被拦', over.ok, false)
  eq('★ 给出 TASK_BUDGET_EXCEEDED', over.code, 'TASK_BUDGET_EXCEEDED')
  chk('  且说明原因', /工具调用预算/.test(over.reason), over.reason)

  // 补丁预算
  let p = t
  for (let i = 0; i < 2; i++) p = consume(p, 'patch')
  eq('补丁超预算也被拦', checkBudget(p, 'patch', { now: 10 }).code, 'TASK_BUDGET_EXCEEDED')

  // 时间预算
  const timeOver = checkBudget(t, 'tool', { now: 5000 })
  eq('★ 时间预算超了也被拦', timeOver.code, 'TASK_BUDGET_EXCEEDED')
  chk('  原因里带秒数', /超过时间预算/.test(timeOver.reason), timeOver.reason)

  // consume 不改原对象
  eq('★ consume 不污染原 task', t.usage.toolCalls, 0)
  chk('consume 返回新对象', cur !== t)

  // 没有 budget 的 task 不炸
  chk('无预算信息时不拦（也不能崩）', checkBudget({}, 'tool').ok === true)
  chk('坏 task 不崩', checkBudget(null, 'tool').ok === true)
}

console.log('\n=== ⑧ TASK-07 记录工具调用 ===')
{
  const c = createToolCall({ tool: 'readFile', args: { path: 'a.mbt' }, startedAt: 10, endedAt: 25, result: { ok: true } })
  eq('工具名', c.tool, 'readFile')
  eq('开始/结束时间都在（可算耗时）', c.endedAt - c.startedAt, 15)
  chk('结果保留', c.result.ok === true)
  chk('冻结', Object.isFrozen(c))
  eq('缺参数不炸', createToolCall({}).tool, '')
}

console.log('\n=== ⑨ TASK-16 崩溃恢复：只标记，不自动继续 ===')
{
  const running = createTask({ id: 'a', now: 0 })
  const mid = transition(transition(running, 'UNDERSTANDING', { now: 1 }).task, 'PLANNING', { now: 2 }).task
  const done = transition(transition(createTask({ id: 'b', now: 0 }), 'UNDERSTANDING', { now: 1 }).task, 'CANCELLED', { now: 2 }).task

  const r = recoverInterrupted([mid, done], { now: 99 })
  eq('★ 未完成的被标记为 INTERRUPTED', r.interrupted.length, 1)
  eq('  id 对得上', r.interrupted[0].id, 'a')
  eq('★ 已结束的（CANCELLED）不动', r.tasks.find((x) => x.id === 'b').status, 'CANCELLED')
  eq('  标记时间写上了', r.interrupted[0].interruptedAt, 99)
  chk('  说明为什么（不是静默改状态）', /异常退出/.test(r.interrupted[0].statusReason), r.interrupted[0].statusReason)

  // ⚠️ 关键：不能自动继续执行 —— 恢复后的任务是 INTERRUPTED，不是 EXECUTING
  chk('★ 恢复后**不是** EXECUTING（不自动继续）', r.interrupted[0].status !== 'EXECUTING')
  chk('  但用户明确要求时可以继续（INTERRUPTED → EXECUTING）', canTransition('INTERRUPTED', 'EXECUTING') === true)

  const again = recoverInterrupted(r.tasks, { now: 100 })
  eq('重复恢复幂等（已是 INTERRUPTED 的不再处理）', again.interrupted.length, 0)
  eq('空输入不炸', recoverInterrupted([]).interrupted.length, 0)
  eq('null 也不炸', recoverInterrupted(null).tasks.length, 0)
}

console.log('\n=== ⑩ describeTask 可读（给时间线/状态栏用）===')
{
  const t = consume(consume(createTask({ goal: '修复登录接口', now: 0 }), 'tool'), 'patch')
  const d = describeTask(t)
  chk('是中文状态', /已创建/.test(d), d)
  chk('带用量（工具 1/x 补丁 1/y）', /工具 1\//.test(d) && /补丁 1\//.test(d), d)
  chk('带目标（截断）', /修复登录接口/.test(d), d)
  eq('null → 可读占位（不炸）', describeTask(null), '（无任务）')
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
