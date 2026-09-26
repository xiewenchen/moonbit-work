// PH3-TASK：真实 Agent Task Runtime 的任务模型与状态机。
//
// 与"Tool Loop"的区别：Tool Loop 只回答"模型让我调什么工具"，
// Task 回答的是"这次请求整体走到哪一步、能不能继续、花了多少预算"。
//
// 纯逻辑、全依赖注入 —— 所以能在 CI 里完整验证（不需要真实模型）。
//
// 关键约束（来自清单 §5）：
//   · 9 个状态 + INTERRUPTED（崩溃恢复用）
//   · WAITING_USER 是**唯一**需要用户参与的状态（Patch / 危险命令）
//   · 预算在**执行前**检查，耗尽给 TASK_BUDGET_EXCEEDED 而不是无限继续
//   · 崩溃恢复**只标记**，不自动继续执行

/** 任务状态（冻结）。 */
const TASK_STATUS = Object.freeze({
  CREATED: 'CREATED',
  UNDERSTANDING: 'UNDERSTANDING',
  PLANNING: 'PLANNING',
  EXECUTING: 'EXECUTING',
  WAITING_USER: 'WAITING_USER',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  // 非正常结束：进程崩了。**不会**自动继续，等用户决定（TASK-16）
  INTERRUPTED: 'INTERRUPTED',
})

const ALL_STATUSES = Object.freeze(Object.keys(TASK_STATUS))
const TERMINAL = Object.freeze([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED])

/**
 * 允许的状态迁移。
 * 说明几处刻意的限制：
 *   · 终态没有出边（不能再活过来）
 *   · INTERRUPTED 只能 → CANCELLED 或 → EXECUTING（用户明确要求继续时才走后者）
 *   · 任何非终态都能 → CANCELLED / FAILED（TASK-15：任何非终态允许取消）
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [TASK_STATUS.CREATED]: [TASK_STATUS.UNDERSTANDING, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED],
  [TASK_STATUS.UNDERSTANDING]: [TASK_STATUS.PLANNING, TASK_STATUS.WAITING_USER, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED],
  [TASK_STATUS.PLANNING]: [TASK_STATUS.EXECUTING, TASK_STATUS.WAITING_USER, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED],
  [TASK_STATUS.EXECUTING]: [TASK_STATUS.WAITING_USER, TASK_STATUS.VERIFYING, TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED],
  // 等用户：确认后回去执行、或直接验证；用户取消 → CANCELLED
  [TASK_STATUS.WAITING_USER]: [TASK_STATUS.EXECUTING, TASK_STATUS.VERIFYING, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED],
  [TASK_STATUS.VERIFYING]: [TASK_STATUS.EXECUTING, TASK_STATUS.WAITING_USER, TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED],
  // 崩溃恢复：只允许"取消"或"用户明确要求继续"
  [TASK_STATUS.INTERRUPTED]: [TASK_STATUS.EXECUTING, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED],
  [TASK_STATUS.COMPLETED]: [],
  [TASK_STATUS.FAILED]: [],
  [TASK_STATUS.CANCELLED]: [],
})

function isTerminal(status) {
  return TERMINAL.indexOf(status) >= 0
}

function canTransition(from, to) {
  const outs = ALLOWED_TRANSITIONS[from]
  return Array.isArray(outs) && outs.indexOf(to) >= 0
}

/** 预算默认值（TASK-11）。都可被调用方覆盖。 */
const DEFAULT_BUDGET = Object.freeze({
  maxDuration: 10 * 60 * 1000,   // 10 分钟
  maxToolCalls: 40,
  maxPatchCount: 10,
})

function createTask({ id, sessionId, goal, now, budget } = {}) {
  return Object.freeze({
    id: String(id || ('task_' + Math.random().toString(36).slice(2, 10))),
    sessionId: sessionId || null,
    goal: String(goal || ''),
    status: TASK_STATUS.CREATED,
    startedAt: Number.isFinite(now) ? now : Date.now(),
    finishedAt: null,
    budget: Object.assign({}, DEFAULT_BUDGET, budget || {}),
    // 用量（TASK-12 的检查依据）
    usage: { toolCalls: 0, patchCount: 0, elapsedMs: 0 },
  })
}

/**
 * 状态迁移。**拒绝的迁移不改变原对象**（返回带 error 的新对象）。
 * 与 run-state / verify 的状态机同风格：不污染、可观察。
 */
function transition(task, to, { now, reason } = {}) {
  if (!task || !task.status) return { ok: false, error: '不是合法 task', code: 'BAD_TASK' }
  if (ALL_STATUSES.indexOf(to) < 0) return { ok: false, error: '未知状态：' + to, code: 'BAD_STATUS' }
  if (!canTransition(task.status, to)) {
    return { ok: false, error: (task.status + ' → ' + to + ' 不被允许'), code: 'ILLEGAL_TRANSITION', from: task.status, to }
  }
  const at = Number.isFinite(now) ? now : Date.now()
  const next = Object.assign({}, task, {
    status: to,
    finishedAt: isTerminal(to) ? at : null,
  })
  if (reason) next.statusReason = String(reason)
  if (to === TASK_STATUS.CANCELLED || to === TASK_STATUS.FAILED) next.endedAt = at
  return { ok: true, task: Object.freeze(next), from: task.status, to }
}

/**
 * 预算检查（TASK-12）—— **在执行前**调用。
 * 返回 { ok:true } 或 { ok:false, code:'TASK_BUDGET_EXCEEDED', reason }。
 */
function checkBudget(task, kind, { now } = {}) {
  if (!task || !task.budget) return { ok: true }
  const b = task.budget
  const at = Number.isFinite(now) ? now : Date.now()
  // ⚠️ 不能写 `task.startedAt || at` —— startedAt 可以是 0（合法时间戳），
  //    而 0 是 falsy，会被当成"没有开始时间"，于是 elapsed 恒为 0、**时间预算永远拦不住**。
  //    （测试抓到的真 bug：`checkBudget(t, 'tool', { now: 5000 })` 本该超时却返回 ok。）
  const started = Number.isFinite(task.startedAt) ? task.startedAt : at
  const elapsed = at - started
  if (elapsed > b.maxDuration) {
    return { ok: false, code: 'TASK_BUDGET_EXCEEDED', reason: '超过时间预算（' + Math.round(elapsed / 1000) + 's > ' + Math.round(b.maxDuration / 1000) + 's）' }
  }
  const u = task.usage || {}
  if (kind === 'tool' && (u.toolCalls || 0) >= b.maxToolCalls) {
    return { ok: false, code: 'TASK_BUDGET_EXCEEDED', reason: '超过工具调用预算（' + u.toolCalls + '/' + b.maxToolCalls + '）' }
  }
  if (kind === 'patch' && (u.patchCount || 0) >= b.maxPatchCount) {
    return { ok: false, code: 'TASK_BUDGET_EXCEEDED', reason: '超过补丁预算（' + u.patchCount + '/' + b.maxPatchCount + '）' }
  }
  return { ok: true }
}

/** 记一次用量（用后检查 checkBudget 会看到）。 */
function consume(task, kind, n = 1) {
  const u = Object.assign({ toolCalls: 0, patchCount: 0, elapsedMs: 0 }, task && task.usage)
  if (kind === 'tool') u.toolCalls += n
  else if (kind === 'patch') u.patchCount += n
  return Object.freeze(Object.assign({}, task, { usage: Object.freeze(u) }))
}

/** 记一次工具调用（TASK-07）。 */
function createToolCall({ tool, args, startedAt, endedAt, result } = {}) {
  return Object.freeze({
    tool: String(tool || ''),
    args: args === undefined ? null : args,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    endedAt: Number.isFinite(endedAt) ? endedAt : null,
    result: result === undefined ? null : result,
  })
}

/**
 * 用户等待点（TASK-08/09/10）。
 * 哪些情况需要等用户：改文件的 Patch、危险命令。
 */
const WAIT_REASONS = Object.freeze({ PATCH: 'patch', DANGEROUS_COMMAND: 'dangerous-command' })

function needsUser(step) {
  if (!step) return null
  if (step.kind === 'patch' || step.action === 'patch') return WAIT_REASONS.PATCH
  if (step.dangerous === true || step.kind === 'dangerous-command') return WAIT_REASONS.DANGEROUS_COMMAND
  return null
}

/**
 * 崩溃恢复（TASK-16）：把"启动时发现的未完成任务"标记为 INTERRUPTED。
 * ⚠️ **只标记，不自动继续执行** —— 清单明确要求。
 */
function recoverInterrupted(tasks, { now } = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  // ⚠️ 不能只靠默认参数 `tasks = []` —— 它对 **null** 不生效（只有 undefined 才触发），
  //    于是 recoverInterrupted(null) 会抛 "tasks is not iterable"（测试抓到的真 bug）。
  const list = Array.isArray(tasks) ? tasks : []
  const out = []
  const interrupted = []
  for (const t of list) {
    if (!t || isTerminal(t.status) || t.status === TASK_STATUS.INTERRUPTED) { out.push(t); continue }
    const next = Object.freeze(Object.assign({}, t, {
      status: TASK_STATUS.INTERRUPTED,
      interruptedAt: at,
      statusReason: '启动时发现未完成任务（上一进程异常退出）',
    }))
    out.push(next); interrupted.push(next)
  }
  return { tasks: out, interrupted }
}

/** 可读描述，给 UI / 时间线用。 */
function describeTask(task) {
  if (!task) return '（无任务）'
  const s = task.status
  const zh = {
    CREATED: '已创建', UNDERSTANDING: '理解中', PLANNING: '规划中', EXECUTING: '执行中',
    WAITING_USER: '等待你确认', VERIFYING: '验证中', COMPLETED: '已完成',
    FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '被中断（上次异常退出）',
  }
  const u = task.usage || {}
  return (zh[s] || s) + '　｜ 工具 ' + (u.toolCalls || 0) + '/' + (task.budget && task.budget.maxToolCalls) +
    '　补丁 ' + (u.patchCount || 0) + '/' + (task.budget && task.budget.maxPatchCount) +
    (task.goal ? '　｜ ' + String(task.goal).slice(0, 40) : '')
}

module.exports = {
  TASK_STATUS, ALL_STATUSES, TERMINAL, ALLOWED_TRANSITIONS, DEFAULT_BUDGET, WAIT_REASONS,
  isTerminal, canTransition, createTask, transition, checkBudget, consume,
  createToolCall, needsUser, recoverInterrupted, describeTask,
}
