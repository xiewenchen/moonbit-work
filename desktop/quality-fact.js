// PH3-Q：Quality 从"面板"变成"事实层"。
//
// 原有的 quality-result.js 回答的是"这一项现在是什么状态"（5 态）。
// 事实层要再多回答三件事：
//   · **谁**跑的、**什么时候**、**用什么命令**、**在什么环境**（provenance）
//   · 这份结果**还新不新**（新鲜度）；过期了就不能再显示 PASS（→ STALE）
//   · 跟**上一次**比，是不是**退化了**（REGRESSION）
//
// 纯逻辑、全依赖注入 —— 可进 CI。不修改 quality-result.js（渐进：新层包住旧层）。

const { QUALITY_STATE } = require('./quality-result')

/** 事实层的状态集合 = 原有 5 态 + STALE（过期）。 */
const FACT_STATE = Object.freeze(Object.assign({}, QUALITY_STATE, { STALE: 'STALE' }))
const ALL_FACT_STATES = Object.freeze(Object.values(FACT_STATE))

/** 验证来源：谁跑的（清单 §11 PH3-Q-02）。 */
const VERIFY_ORIGIN = Object.freeze({
  CI: 'CI',
  LOCAL: 'LOCAL',
  E2E: 'E2E',
  USER: 'USER',
})

/** 运行环境（PH3-Q-05 里"在哪个环境"）。 */
const VERIFY_ENV = Object.freeze({
  WINDOWS: 'windows',
  LINUX: 'linux',
  MAC: 'mac',
  UNKNOWN: 'unknown',
})

/** 默认新鲜度上限：24 小时。可按项目/来源覆盖。 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 给一条结果补上来源信息（PH3-Q-05 Result Provenance）。
 * 四个字段缺一不可地"尽量填"—— 填不出来的就如实留 null，不编。
 */
function withProvenance(result, prov = {}) {
  const r = Object.assign({}, result || {})
  r.provenance = {
    at: Number.isFinite(prov.at) ? prov.at : null,          // 什么时候跑
    origin: Object.values(VERIFY_ORIGIN).includes(prov.origin) ? prov.origin : null,  // 谁跑的
    command: prov.command == null ? null : String(prov.command),   // 用什么命令
    env: Object.values(VERIFY_ENV).includes(prov.env) ? prov.env : null,  // 在哪个环境
    commit: prov.commit == null ? null : String(prov.commit),      // 对应哪个 commit（PH3-Q-06）
    by: prov.by == null ? null : String(prov.by),                  // 具体是哪个作业/人
  }
  if (r.provenance.at && !Number.isFinite(r.verifiedAt)) r.verifiedAt = r.provenance.at
  return r
}

/** 距今多久（ms）。没有时间戳就返回 null —— 而不是 0（0 会被误读成"刚刚跑过"）。 */
function ageOf(result, now) {
  const at = result && Number.isFinite(result.verifiedAt)
    ? result.verifiedAt
    : (result && result.provenance && Number.isFinite(result.provenance.at) ? result.provenance.at : null)
  if (!at) return null
  const t = Number.isFinite(now) ? now : Date.now()
  return Math.max(0, t - at)
}

/**
 * 判断新鲜度（PH3-Q-03/04）。
 * ⚠️ 三种情况要分开：
 *   · 没有时间戳      → 无法判断（unknown），**不冒充新鲜**
 *   · 未过期          → fresh
 *   · 过期            → stale（这时 PASS 必须变成 STALE）
 */
function staleness(result, opts = {}) {
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS
  const age = ageOf(result, opts.now)
  if (age == null) return { fresh: false, stale: false, unknown: true, ageMs: null, maxAgeMs, reason: '没有记录验证时间，无法判断新鲜度' }
  if (age > maxAgeMs) {
    return {
      fresh: false, stale: true, unknown: false, ageMs: age, maxAgeMs,
      reason: '结果已过期（' + Math.round(age / 1000) + 's > ' + Math.round(maxAgeMs / 1000) + 's）',
    }
  }
  return { fresh: true, stale: false, unknown: false, ageMs: age, maxAgeMs, reason: null }
}

/**
 * PH3-Q-04：把过期的结果标成 STALE。
 *
 * ⚠️ 只改**曾经是 PASS/WARN** 的项 —— NOT_RUN / SKIP / FAIL 本来就不是"通过"，
 *    改成 STALE 反而会丢信息（"从来没跑过"和"跑过但过期了"是两回事）。
 */
function applyStaleness(results, opts = {}) {
  const list = Array.isArray(results) ? results : []
  return list.map((r) => {
    const s = staleness(r, opts)
    if (!s.stale) return r
    if (r.state !== QUALITY_STATE.PASS && r.state !== QUALITY_STATE.WARN) return r
    return Object.assign({}, r, {
      state: FACT_STATE.STALE,
      staleReason: s.reason,
      ageMs: s.ageMs,
      // 原来的状态留着 —— 面板上可以说"上次是 PASS，但已经过期"
      previousState: r.state,
    })
  })
}

/**
 * PH3-Q-09：Agent 能不能继续。
 * 有 FAIL 或 STALE 就不许（"没过 / 结果过期"都不该当作"可以继续"）。
 */
function canProceed(results) {
  const list = Array.isArray(results) ? results : []
  const blockers = list.filter((r) => r && (r.state === QUALITY_STATE.FAIL || r.state === FACT_STATE.STALE))
  return {
    ok: blockers.length === 0,
    blockers: blockers.map((r) => ({ name: r.name, state: r.state, reason: r.staleReason || r.detail || null })),
    reason: blockers.length ? (blockers.length + ' 项未通过或已过期，不该继续') : '没有阻塞项',
  }
}

/** 计数抽取：从 results 里拿某一项的 passed/failed（退化检测要用）。 */
function countsOf(results, match) {
  const list = Array.isArray(results) ? results : []
  const hit = list.find((r) => r && match(String(r.name || '')))
  if (!hit) return null
  return { passed: Number(hit.passed || 0), failed: Number(hit.failed || 0), state: hit.state }
}

/**
 * PH3-Q-10/11：比较两次快照，找出**退化**。
 *
 * 判定退化的三类（都要，缺一类就会漏）：
 *   ① 状态变差：PASS → FAIL/STALE（有序：PASS > WARN > SKIP/NOT_RUN > FAIL）
 *   ② 通过数变少：Test 156 → 154（清单里点名的例子）
 *   ③ 新出现了 FAIL 项
 */
const STATE_RANK = Object.freeze({ PASS: 4, WARN: 3, SKIP: 2, NOT_RUN: 1, STALE: 2, FAIL: 0 })

function compareQuality(before, after) {
  const b = Array.isArray(before) ? before : []
  const a = Array.isArray(after) ? after : []
  const byName = (list) => {
    const m = new Map()
    for (const r of list) if (r && r.name) m.set(String(r.name), r)
    return m
  }
  const bm = byName(b); const am = byName(a)
  const regressions = []; const improvements = []; const added = []; const removed = []

  for (const [name, ra] of am) {
    const rb = bm.get(name)
    if (!rb) { added.push(name); if (ra.state === QUALITY_STATE.FAIL) regressions.push({ name, kind: 'new-failure', detail: '新增项即失败' }); continue }
    const rankB = STATE_RANK[rb.state] == null ? 1 : STATE_RANK[rb.state]
    const rankA = STATE_RANK[ra.state] == null ? 1 : STATE_RANK[ra.state]
    if (rankA < rankB) {
      regressions.push({ name, kind: 'state-worse', from: rb.state, to: ra.state, detail: rb.state + ' → ' + ra.state })
    } else if (rankA > rankB) {
      improvements.push({ name, kind: 'state-better', from: rb.state, to: ra.state })
    }
    // ② 通过数变少（即使状态都是 PASS —— 比如 156 → 154）
    if (Number.isFinite(rb.passed) && Number.isFinite(ra.passed) && ra.passed < rb.passed) {
      regressions.push({
        name, kind: 'fewer-passed',
        from: rb.passed, to: ra.passed,
        detail: '通过数下降：' + rb.passed + ' → ' + ra.passed,
      })
    } else if (Number.isFinite(rb.passed) && Number.isFinite(ra.passed) && ra.passed > rb.passed) {
      improvements.push({ name, kind: 'more-passed', from: rb.passed, to: ra.passed })
    }
  }
  for (const [name] of bm) if (!am.has(name)) removed.push(name)

  return {
    regressions, improvements, added, removed,
    hasRegression: regressions.length > 0,
    summary: regressions.length
      ? ('发现 ' + regressions.length + ' 项退化：' + regressions.map((r) => r.detail || r.name).join('；'))
      : '与上次相比没有退化',
  }
}

/**
 * PH3-Q-01：一份"事实快照"—— 把结果 + 环境 + 来源 + 时间 + commit 打包。
 * 这是 Quality 作为事实层的对外形状。
 */
function createFactSnapshot({ project, results, environment, origin, commit, now } = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  const list = Array.isArray(results) ? results : []
  const applied = applyStaleness(list, { now: at })
  const overallOf = () => {
    const st = applied.map((r) => r.state)
    if (st.includes(QUALITY_STATE.FAIL)) return QUALITY_STATE.FAIL
    if (st.includes(FACT_STATE.STALE)) return FACT_STATE.STALE
    if (st.length === 0 || st.every((s) => s === QUALITY_STATE.NOT_RUN || s === QUALITY_STATE.SKIP)) return QUALITY_STATE.NOT_RUN
    if (st.includes(QUALITY_STATE.WARN)) return QUALITY_STATE.WARN
    return QUALITY_STATE.PASS
  }
  return Object.freeze({
    project: project == null ? null : String(project),
    timestamp: at,
    results: applied,
    environment: Object.values(VERIFY_ENV).includes(environment) ? environment : VERIFY_ENV.UNKNOWN,
    origin: Object.values(VERIFY_ORIGIN).includes(origin) ? origin : null,
    commit: commit == null ? null : String(commit),
    overall: overallOf(),
    canProceed: canProceed(applied),
    staleCount: applied.filter((r) => r.state === FACT_STATE.STALE).length,
  })
}

/** 可读描述（给面板/Agent 用）。 */
function describeFact(snap) {
  if (!snap) return '（没有快照）'
  const zh = { PASS: '通过', FAIL: '失败', WARN: '警告', SKIP: '跳过', NOT_RUN: '未运行', STALE: '已过期' }
  const parts = ['工程状态：' + (zh[snap.overall] || snap.overall)]
  if (snap.commit) parts.push('commit ' + String(snap.commit).slice(0, 8))
  if (snap.staleCount) parts.push(snap.staleCount + ' 项已过期')
  parts.push(snap.canProceed.ok ? '可以继续' : '先别继续（' + snap.canProceed.reason + '）')
  return parts.join('　｜ ')
}

module.exports = {
  FACT_STATE, ALL_FACT_STATES, VERIFY_ORIGIN, VERIFY_ENV, DEFAULT_MAX_AGE_MS, STATE_RANK,
  withProvenance, ageOf, staleness, applyStaleness, canProceed, countsOf,
  compareQuality, createFactSnapshot, describeFact,
}
