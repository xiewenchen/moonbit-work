'use strict'

/**
 * Agent 验证闭环（Phase 2 / MBW-P9-01 ～ P9-11）
 *
 * 清单 P9 的意思是：Agent 改完代码之后，必须**自己证明没改坏** ——
 *   Apply → Check → Test → Run → Health，任一步失败就变成 Problem（进 P4 的统一模型），
 *   而且**不许无限自我修复**（有轮次上限），最后给出一份人能读的报告。
 *
 * 纯逻辑：applyPatch / check / test / run / health 全部注入 —— 所以
 * 「check 失败 → 不再往下跑」「连续失败 → 停止」「轮次用尽 → 拒绝」这些行为能纯 Node 测。
 */

const { SEVERITY, PROBLEM_SOURCE, fromCompilerOutput, fromTestResult, fromApiResult } = require('./problem-model')

// ── P9-08 Verify 状态机 ───────────────────────────────────────────────────────
const VERIFY_STATE = Object.freeze({
  PATCHED: 'patched',
  CHECKING: 'checking',
  TESTING: 'testing',
  STARTING: 'starting',
  HEALTH_CHECK: 'health_check',
  VERIFIED: 'verified',
  VERIFY_FAILED: 'verify_failed',
})
const ALL_STATES = Object.freeze(Object.values(VERIFY_STATE))
const ALLOWED_TRANSITIONS = Object.freeze({
  [VERIFY_STATE.PATCHED]: [VERIFY_STATE.CHECKING],
  [VERIFY_STATE.CHECKING]: [VERIFY_STATE.TESTING, VERIFY_STATE.VERIFY_FAILED],
  [VERIFY_STATE.TESTING]: [VERIFY_STATE.STARTING, VERIFY_STATE.VERIFY_FAILED],
  [VERIFY_STATE.STARTING]: [VERIFY_STATE.HEALTH_CHECK, VERIFY_STATE.VERIFY_FAILED],
  [VERIFY_STATE.HEALTH_CHECK]: [VERIFY_STATE.VERIFIED, VERIFY_STATE.VERIFY_FAILED],
  [VERIFY_STATE.VERIFIED]: [],
  [VERIFY_STATE.VERIFY_FAILED]: [],
})

function canTransition(from, to) {
  if (!ALL_STATES.includes(from) || !ALL_STATES.includes(to)) return false
  return (ALLOWED_TRANSITIONS[from] || []).includes(to)
}

function createVerifyStateMachine({ onTransition } = {}) {
  let state = VERIFY_STATE.PATCHED
  const history = [{ from: null, to: state, at: Date.now() }]
  return {
    get state() { return state },
    get history() { return history.slice() },
    isTerminal() { return state === VERIFY_STATE.VERIFIED || state === VERIFY_STATE.VERIFY_FAILED },
    to(next) {
      if (!ALL_STATES.includes(next)) return { ok: false, error: '未知状态：' + next }
      if (!canTransition(state, next)) return { ok: false, error: '不允许的转换：' + state + ' → ' + next }
      const from = state
      state = next
      const ev = { from, to: next, at: Date.now() }
      history.push(ev)
      if (typeof onTransition === 'function') {
        try {
          onTransition(ev)
        } catch (e) {
          // 观察者抛错不影响状态机（P1-15 同款处理）
          history.push({ from: next, to: next, at: Date.now(), observerError: String((e && e.message) || e) })
        }
      }
      return { ok: true, from, to: next }
    },
  }
}

// ── P9-01 ～ P9-07 闭环引擎 ───────────────────────────────────────────────────
/** 把各步失败转成 P4 的 Problem（**统一来源**，不另造一套）*/
function problemsFromStep(step, result) {
  if (step === 'check') return fromCompilerOutput(String((result && result.output) || ''))
  if (step === 'test') return fromTestResult({ name: (result && result.name) || 'test', ok: false, message: (result && result.error) || '测试失败' })
  if (step === 'run') {
    return [{
      source: PROBLEM_SOURCE.RUNTIME,
      severity: SEVERITY.ERROR,
      message: '服务未能启动：' + String((result && result.error) || '未知原因'),
      file: null,
      line: 1,
      column: 1,
    }]
  }
  if (step === 'health') {
    return fromApiResult({ ok: false, url: (result && result.url) || '', status: (result && result.status) || 0, error: (result && result.error) || '健康检查失败' })
  }
  return []
}
const localProblem = (p) => Object.assign({ lifecycle: 'open', timestamp: Date.now(), id: 'v-' + Math.random().toString(36).slice(2, 10) }, p)

/**
 * 跑一轮验证：apply → check → test → run → health。
 * **任一步失败立即停**（不"继续往下跑看看"），并把失败转成 Problem。
 */
async function verifyOnce({ patch, deps = {} } = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const startedAt = now()
  const sm = createVerifyStateMachine()
  const steps = []
  const problems = []
  const progress = (name, ok, extra) => {
    if (typeof deps.onProgress === 'function') deps.onProgress(Object.assign({ name, ok }, extra || {}))
  }

  const fail = (step, error, extra) => {
    sm.to(VERIFY_STATE.VERIFY_FAILED)
    const ps = problemsFromStep(step, Object.assign({ error, output: extra && extra.output }, extra || {})).map(localProblem)
    problems.push(...ps)
    steps.push(Object.assign({ name: step, ok: false, error: error || null, problems: ps.length, duration: now() - startedAt }, extra || {}))
    progress(step, false, { error })
    return { ok: false, status: sm.state, steps, problems, error: error || null, rounds: 1, startedAt, endedAt: now() }
  }

  // ① 应用 Patch（P9-01 的前置；失败就没必要往下）
  if (typeof deps.applyPatch !== 'function') return fail('apply', '缺少 applyPatch 注入')
  const applied = await deps.applyPatch(patch)
  if (!applied || applied.ok !== true) return fail('apply', (applied && applied.error) || '应用 patch 失败')
  steps.push({ name: 'apply', ok: true, duration: now() - startedAt, file: applied.file || (patch && patch.file) })

  const run = async (step, action, stateTo, nextState) => {
    sm.to(stateTo)
    const t0 = now()
    let r
    try {
      r = await action()
    } catch (e) {
      return fail(step, String((e && e.message) || e))
    }
    if (r && r.ok === false) {
      return fail('check' === step ? 'check' : step, r.error || (step + ' 失败'), Object.assign({}, r, { output: r.output || r.stdout || '' }))
    }
    steps.push(Object.assign({ name: step, ok: true, duration: now() - t0 }, r && r.detail ? { detail: r.detail } : {}))
    progress(step, true)
    if (nextState) sm.to(nextState)
    return null
  }

  // ② check（P9-01/02）
  {
    const bad = await run('check', () => (typeof deps.check === 'function' ? deps.check() : { ok: true }), VERIFY_STATE.CHECKING)
    if (bad) return bad
  }
  // ③ test（P9-03/04）
  {
    const bad = await run('test', () => (typeof deps.test === 'function' ? deps.test() : { ok: true }), VERIFY_STATE.TESTING)
    if (bad) return bad
  }
  // ④ run（P9-05/06）
  {
    const bad = await run('run', () => (typeof deps.run === 'function' ? deps.run() : { ok: true }), VERIFY_STATE.STARTING)
    if (bad) return bad
  }
  // ⑤ health（P9-06/07）
  {
    const bad = await run('health', () => (typeof deps.health === 'function' ? deps.health() : { ok: true }), VERIFY_STATE.HEALTH_CHECK, VERIFY_STATE.VERIFIED)
    if (bad) return bad
  }

  return { ok: true, status: sm.state, steps, problems, error: null, rounds: 1, startedAt, endedAt: now(), history: sm.history }
}

// ── P9-09 / P9-10 轮次上限（防自我循环）───────────────────────────────────────
/**
 * @param {object} opts
 *   maxRounds  最多允许几轮"改一次 + 验一次"（默认 3）
 *   fix(patch, problems) → 下一轮的 patch（注入；`null` 表示不再尝试）
 */
function createVerifyLoop(opts = {}) {
  const maxRounds = Number(opts.maxRounds) > 0 ? Math.trunc(opts.maxRounds) : 3
  const rounds = []

  async function run({ patch, deps } = {}) {
    let current = patch
    let round = 0
    let last = null
    let stoppedReason = null
    for (;;) {
      if (round >= maxRounds) { stoppedReason = '达到最大轮次（' + maxRounds + '）'; break }
      round++
      last = await verifyOnce({ patch: current, deps })
      last.rounds = round
      rounds.push(last)
      if (last.ok) { stoppedReason = null; break }
      // 轮次用尽时**不要再提议修复** —— 那个结果没人会用，白跑一次
      if (round >= maxRounds) { stoppedReason = '达到最大轮次（' + maxRounds + '）'; break }
      if (typeof opts.fix !== 'function') { stoppedReason = '没有提供 fix（不再尝试）'; break }
      let next
      try {
        next = await opts.fix(current, last.problems)
      } catch (e) {
        // 提议修复本身抛错 → 停止（**不能**让它冒泡，也不能重试）
        stoppedReason = '修复提议失败：' + String((e && e.message) || e)
        break
      }
      if (!next || next.ok === false) { stoppedReason = '修复提议失败或放弃'; break }
      current = next.patch || next
    }
    return { ok: !!(last && last.ok), rounds: round, last, all: rounds, stoppedReason, maxRounds }
  }

  return { run, maxRounds, results: () => rounds.slice() }
}

// ── P9-11 最终报告 ────────────────────────────────────────────────────────────
function buildVerifyReport(session) {
  const s = session || {}
  const last = s.last || {}
  return {
    ok: s.ok === true,
    status: (last.status) || (s.ok ? VERIFY_STATE.VERIFIED : VERIFY_STATE.VERIFY_FAILED),
    rounds: s.rounds || 0,
    maxRounds: s.maxRounds || 0,
    stoppedReason: s.stoppedReason || null,
    file: (last.steps || []).find((x) => x.name === 'apply') ? last.steps.find((x) => x.name === 'apply').file : null,
    steps: (last.steps || []).map((x) => ({ name: x.name, ok: x.ok, duration: x.duration, error: x.error || null })),
    problems: last.problems || [],
  }
}

function renderVerifyReport(report) {
  const r = report || {}
  const lines = []
  lines.push('# 验证报告')
  lines.push('')
  lines.push('- 结论：' + (r.ok ? '**通过（VERIFIED）**' : '**失败（VERIFY_FAILED）**'))
  lines.push('- 修改文件：' + (r.file || '（无）'))
  lines.push('- 轮次：' + r.rounds + ' / 上限 ' + r.maxRounds + (r.stoppedReason ? '（停止原因：' + r.stoppedReason + '）' : ''))
  lines.push('')
  lines.push('| 步骤 | 结果 | 耗时 | 说明 |')
  lines.push('|---|---|---|---|')
  for (const s of r.steps || []) {
    lines.push('| ' + s.name + ' | ' + (s.ok ? '✓' : '✗') + ' | ' + (s.duration == null ? '-' : s.duration + 'ms') + ' | ' + (s.error || '') + ' |')
  }
  if ((r.problems || []).length) {
    lines.push('')
    lines.push('## 待处理问题（' + r.problems.length + '）')
    for (const p of r.problems) {
      lines.push('- [' + (p.severity || 'error') + '] ' + (p.file ? p.file + ':' + p.line + ' ' : '') + (p.message || ''))
    }
  }
  return lines.join('\n')
}

module.exports = {
  VERIFY_STATE,
  ALL_STATES,
  ALLOWED_TRANSITIONS,
  canTransition,
  createVerifyStateMachine,
  problemsFromStep,
  verifyOnce,
  createVerifyLoop,
  buildVerifyReport,
  renderVerifyReport,
}
