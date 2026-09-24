'use strict'

/**
 * Run 生命周期原语（Phase 2 / MBW-P1-14 ～ MBW-P1-18）
 *
 * 纯逻辑、零依赖、不 require electron —— 因此能在纯 Node 与 Linux CI 上验证。
 *
 * 提供四件套：
 *   P1-14  RUN_STATE      状态枚举（IDLE/BUILDING/STARTING/RUNNING/STOPPING/STOPPED/FAILED）
 *   P1-15  转换表 + 状态机  允许的转换走通；STOPPED→RUNNING / FAILED→RUNNING 必须被拒
 *   P1-16  ProcessHandle  pid / command / cwd / startTime / status + stop() / kill()
 *   P1-17  StreamEvent    stdout|stderr 统一事件（stream / chunk / timestamp）
 *   P1-18  RunResult      ok / status / exitCode / url / stdout / stderr / duration / error
 *
 * 注意：本文件**只建原语，不接线**。把状态机接进 Runner 主流程属于 P1-19（RULE-04 渐进迁移）。
 */

// ── P1-14 状态枚举 ────────────────────────────────────────────────────────────
const RUN_STATE = Object.freeze({
  IDLE: 'IDLE',
  BUILDING: 'BUILDING',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
})

const ALL_STATES = Object.freeze(Object.values(RUN_STATE))

/** 终态：到这儿就不能再往下走，只能 reset 后重新进入 Run 流程 */
const TERMINAL_STATES = Object.freeze([RUN_STATE.STOPPED, RUN_STATE.FAILED])

function isState(s) {
  return ALL_STATES.includes(s)
}

// ── P1-15 允许的状态转换 ──────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS = Object.freeze({
  [RUN_STATE.IDLE]: [RUN_STATE.BUILDING],
  [RUN_STATE.BUILDING]: [RUN_STATE.STARTING, RUN_STATE.FAILED],
  [RUN_STATE.STARTING]: [RUN_STATE.RUNNING, RUN_STATE.FAILED, RUN_STATE.STOPPING],
  [RUN_STATE.RUNNING]: [RUN_STATE.STOPPING, RUN_STATE.FAILED],
  [RUN_STATE.STOPPING]: [RUN_STATE.STOPPED],
  [RUN_STATE.STOPPED]: [],   // 禁止 STOPPED → RUNNING
  [RUN_STATE.FAILED]: [],    // 禁止 FAILED  → RUNNING
})

/** @returns {boolean} from → to 是否被允许 */
function canTransition(from, to) {
  if (!isState(from) || !isState(to)) return false
  return (ALLOWED_TRANSITIONS[from] || []).includes(to)
}

/**
 * 状态机。转换被拒时**不改状态**，并返回 { ok:false, error }。
 * onTransition 抛错不会污染状态机（错误收进 observerErrors）。
 */
function createRunStateMachine({ initial = RUN_STATE.IDLE, onTransition } = {}) {
  if (!isState(initial)) throw new Error('未知状态：' + initial)
  let state = initial
  const history = [{ from: null, to: initial, at: Date.now() }]
  const observerErrors = []

  const machine = {
    get state() { return state },
    get history() { return history.slice() },
    get observerErrors() { return observerErrors.slice() },

    canGo(next) {
      return canTransition(state, next)
    },

    to(next) {
      if (!isState(next)) return { ok: false, error: '未知状态：' + next, from: state }
      if (!canTransition(state, next)) {
        return { ok: false, error: `不允许的转换：${state} → ${next}`, from: state }
      }
      const from = state
      state = next
      const ev = { from, to: next, at: Date.now() }
      history.push(ev)
      if (typeof onTransition === 'function') {
        try {
          onTransition(ev)
        } catch (e) {
          observerErrors.push(String((e && e.message) || e))
        }
      }
      return { ok: true, from, to: next, at: ev.at }
    },

    isTerminal() {
      return TERMINAL_STATES.includes(state)
    },

    /** 回到 IDLE —— 清单允许的「重新进入 Run 流程」路径 */
    reset() {
      const from = state
      state = RUN_STATE.IDLE
      history.push({ from, to: state, at: Date.now(), reset: true })
      return { ok: true, from, to: state }
    },

    toJSON() {
      return { state, history: history.slice() }
    },
  }
  return machine
}

// ── P1-16 ProcessHandle ───────────────────────────────────────────────────────
/**
 * @param {{pid?: number, command?: string, cwd?: string, kill?: (signal: string) => void}} opts
 */
function createProcessHandle({ pid = null, command = '', cwd = '', kill } = {}) {
  const startTime = Date.now()
  const doKill = typeof kill === 'function' ? kill : () => {}
  let status = RUN_STATE.RUNNING
  let exitCode = null
  let endedAt = null

  const handle = {
    pid,
    command,
    cwd,
    startTime,

    get status() { return status },
    get exitCode() { return exitCode },
    get endedAt() { return endedAt },
    get durationMs() { return (endedAt || Date.now()) - startTime },

    /** 优雅停止 */
    stop() {
      return handle.kill('SIGTERM')
    },

    /** 强制结束。已在停止/已结束的进程再调是安全的（返回 ok:false，不重复杀） */
    kill(signal = 'SIGKILL') {
      if (status === RUN_STATE.STOPPING || status === RUN_STATE.STOPPED || status === RUN_STATE.FAILED) {
        return { ok: false, error: `进程不在运行中（${status}）`, status }
      }
      status = RUN_STATE.STOPPING
      try {
        doKill(signal)
      } catch (e) {
        status = RUN_STATE.FAILED
        endedAt = Date.now()
        return { ok: false, error: String((e && e.message) || e), status }
      }
      return { ok: true, signal, status }
    },

    /** 子进程真的退出了（close 事件） */
    recordExit(code, signal = null) {
      exitCode = typeof code === 'number' ? code : null
      if (status === RUN_STATE.STOPPING) {
        status = RUN_STATE.STOPPED          // 用户主动停的：即使 code≠0 也算「已停止」
      } else if (exitCode !== null && exitCode !== 0) {
        status = RUN_STATE.FAILED           // 自己崩的
      } else {
        status = RUN_STATE.STOPPED
      }
      endedAt = Date.now()
      return handle.toJSON()
    },

    toJSON() {
      return {
        pid, command, cwd, startTime, status, exitCode, endedAt,
        durationMs: (endedAt || Date.now()) - startTime,
        signal: null,
      }
    },
  }
  return handle
}

// ── P1-17 统一的流事件 ────────────────────────────────────────────────────────
const STREAMS = Object.freeze(['stdout', 'stderr'])

/** @returns {{ok: boolean, event?: {stream: string, chunk: string, timestamp: number}, error?: string}} */
function createStreamEvent(stream, chunk, at) {
  if (!STREAMS.includes(stream)) {
    return { ok: false, error: '未知流：' + stream + '（只支持 ' + STREAMS.join(' / ') + '）' }
  }
  return {
    ok: true,
    event: {
      stream,
      chunk: String(chunk == null ? '' : chunk),
      timestamp: typeof at === 'number' ? at : Date.now(),
    },
  }
}

// ── P1-18 RunResult ───────────────────────────────────────────────────────────
/**
 * 一次运行的最终结果。
 * ok 的含义：**这次运行没失败** —— 没有 error，且状态落在 RUNNING / STOPPING / STOPPED
 * （即「进程确实起来过」）。FAILED 或带 error 一律 ok:false。
 */
function createRunResult(input = {}) {
  const status = input.status || RUN_STATE.IDLE
  const startedAt = typeof input.startedAt === 'number' ? input.startedAt : null
  const endedAt = typeof input.endedAt === 'number' ? input.endedAt : null
  const error = input.error == null ? null : String(input.error)
  const ok = !error && [RUN_STATE.RUNNING, RUN_STATE.STOPPING, RUN_STATE.STOPPED].includes(status)

  return {
    ok,
    status,
    exitCode: typeof input.exitCode === 'number' ? input.exitCode : null,
    url: input.url || null,
    stdout: String(input.stdout == null ? '' : input.stdout),
    stderr: String(input.stderr == null ? '' : input.stderr),
    duration: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
    error,
  }
}

module.exports = {
  RUN_STATE,
  ALL_STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  STREAMS,
  isState,
  canTransition,
  createRunStateMachine,
  createProcessHandle,
  createStreamEvent,
  createRunResult,
}
