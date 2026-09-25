'use strict'

/**
 * Quality Center 的模型层（Phase 2.1 / P16-01 ～ P16-09）
 *
 * 清单对它的定位：
 *   > 这一阶段的价值不是再做一个 Dashboard，而是：**把已经存在的工程验证系统
 *   > 变成 IDE 的「工程状态」。**
 *
 * 所以这里的关键词是「**已经存在的**」：适配器**不重跑**任何测试，
 * 只把各来源**已有的产物**（命令结果、验证脚本输出、靶场/套件报告）归一成同一个形状。
 * 好处是：它能离线工作、能进 CI，而且"工程状态"不会因为刷新页面就又跑一遍全量测试。
 *
 * 五个状态（P16-01）：
 *   PASS / FAIL / WARN / SKIP / NOT_RUN
 *   —— 特意把 SKIP 与 NOT_RUN 分开：**"因为环境不满足而跳过"与"根本没跑"是两件事**，
 *      合成一个就会让"没跑过"看起来像"通过了"。
 *
 * 纯逻辑、零依赖，可直接进 CI。
 */

const QUALITY_STATE = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  WARN: 'WARN',
  SKIP: 'SKIP',
  NOT_RUN: 'NOT_RUN',
})

const ALL_STATES = Object.freeze(Object.values(QUALITY_STATE))

/** 来源（P16-02～08 各一个）*/
const QUALITY_SOURCE = Object.freeze({
  BUILD: 'build',
  UNIT_TEST: 'unitTest',
  WASM: 'wasm',
  SECURITY: 'security',
  REALWORLD: 'realworld',
  PERFORMANCE: 'performance',
  DESKTOP: 'desktopVerify',
})

const QUALITY_LIMITS = Object.freeze({
  maxDetailChars: 800,
  maxItemsPerSource: 200,
})

/** P16-01：一条工程状态 */
function createQualityResult(input = {}) {
  const errs = []
  const name = String(input.name == null ? '' : input.name).trim()
  if (!name) errs.push('name 不能为空')
  const state = String(input.state || QUALITY_STATE.NOT_RUN)
  if (ALL_STATES.indexOf(state) < 0) errs.push('state 非法：' + state)
  return Object.freeze({
    ok: errs.length === 0,
    errors: Object.freeze(errs),
    id: input.id || (name + '@' + (input.source || 'unknown')),
    name,
    state,
    source: String(input.source || 'unknown'),
    // 详情：**裁剪**保存（状态里放不下几百行日志）
    detail: String(input.detail == null ? '' : input.detail).slice(0, QUALITY_LIMITS.maxDetailChars),
    // P16-11 / P16-12：失败项要能跳日志、跳文件
    file: input.file ? String(input.file) : null,
    line: Number.isFinite(input.line) ? input.line : null,
    // 计数（测试类来源常常是"N 通过 / M 失败"）
    passed: Number.isFinite(input.passed) ? input.passed : null,
    failed: Number.isFinite(input.failed) ? input.failed : null,
    skipped: Number.isFinite(input.skipped) ? input.skipped : null,
    durationMs: Number.isFinite(input.durationMs) ? input.durationMs : null,
    at: Number.isFinite(input.at) ? input.at : Date.now(),
  })
}

function q(input) { return createQualityResult(input) }

// ── P16-02 构建 ───────────────────────────────────────────────────────────────
/** 从命令表的 CommandResult（{ok, code, stdout, stderr}）归一 */
function fromBuildResult(r = {}, extra = {}) {
  const ok = r && r.ok === true
  const code = r && Number.isFinite(r.code) ? r.code : null
  return q(Object.assign({
    name: '构建（build）', source: QUALITY_SOURCE.BUILD,
    state: ok ? QUALITY_STATE.PASS : (r && r.error ? QUALITY_STATE.FAIL : QUALITY_STATE.NOT_RUN),
    detail: String((r && (r.error || r.stderr || r.stdout)) || '').trim(),
    durationMs: r && Number.isFinite(r.durationMs) ? r.durationMs : null,
    line: null,
  }, extra))
}

// ── P16-03 单元测试 ───────────────────────────────────────────────────────────
/** 解析 `N 通过 / M 失败` 这类文本；解析不出就按 ok 归 PASS/FAIL */
function parseCounts(text) {
  const s = String(text == null ? '' : text)
  const pass = /(\d+)\s*(?:通过|passed)/i.exec(s)
  const fail = /(\d+)\s*(?:失败|failed)/i.exec(s)
  const skip = /(\d+)\s*(?:跳过|skipped)/i.exec(s)
  return {
    passed: pass ? Number(pass[1]) : null,
    failed: fail ? Number(fail[1]) : null,
    skipped: skip ? Number(skip[1]) : null,
  }
}

function fromTestResult(r = {}, extra = {}) {
  const text = String((r && (r.stdout || r.error || r.stderr)) || '')
  const counts = parseCounts(text)
  const state = r && r.ok === true ? QUALITY_STATE.PASS
    : (r && (r.error || r.code)) ? QUALITY_STATE.FAIL : QUALITY_STATE.NOT_RUN
  return q(Object.assign({
    name: '单元测试（native）', source: QUALITY_SOURCE.UNIT_TEST, state,
    detail: text.trim(), passed: counts.passed, failed: counts.failed, skipped: counts.skipped,
    durationMs: r && Number.isFinite(r.durationMs) ? r.durationMs : null,
  }, extra))
}

// ── P16-04 wasm-gc ───────────────────────────────────────────────────────────
function fromWasmResult(r = {}, extra = {}) {
  const text = String((r && (r.stdout || r.error || r.stderr)) || '')
  const counts = parseCounts(text)
  const state = r && r.ok === true ? QUALITY_STATE.PASS
    : (r && (r.error || r.code)) ? QUALITY_STATE.FAIL : QUALITY_STATE.NOT_RUN
  return q(Object.assign({
    name: '单元测试（wasm-gc）', source: QUALITY_SOURCE.WASM, state,
    detail: text.trim(), passed: counts.passed, failed: counts.failed,
  }, extra))
}

// ── P16-05 安全靶场 ──────────────────────────────────────────────────────────
/**
 * 靶场输出里通常是 `N/M 通过`。**解析不出就不猜**（NOT_RUN）——
 * 把"没读懂"当成 PASS 是这类面板最容易犯的错。
 */
function fromSecurityReport(text, extra = {}) {
  const s = String(text == null ? '' : text)
  const m = /(\d+)\s*\/\s*(\d+)\s*(?:通过|check|项)/i.exec(s) || /通过[:：]\s*(\d+)\s*\/\s*(\d+)/.exec(s)
  if (!m) {
    return q(Object.assign({
      name: '安全靶场（sec/attack.py）', source: QUALITY_SOURCE.SECURITY, state: QUALITY_STATE.NOT_RUN,
      detail: s.trim() || '（没有可解析的报告）',
    }, extra))
  }
  const passed = Number(m[1]); const total = Number(m[2])
  return q(Object.assign({
    name: '安全靶场（sec/attack.py）', source: QUALITY_SOURCE.SECURITY,
    state: total > 0 && passed === total ? QUALITY_STATE.PASS : QUALITY_STATE.FAIL,
    detail: s.trim(), passed, failed: Math.max(0, total - passed),
  }, extra))
}

// ── P16-06 RealWorld 官方套件 ────────────────────────────────────────────────
function fromRealWorldReport(text, extra = {}) {
  const s = String(text == null ? '' : text)
  const m = /(\d+)\s*\/\s*(\d+)\s*(?:套件|files?|passed)/i.exec(s) || /(\d+)\s*\/\s*(\d+)/.exec(s)
  if (!m) {
    return q(Object.assign({
      name: 'RealWorld 官方套件（hurl）', source: QUALITY_SOURCE.REALWORLD, state: QUALITY_STATE.NOT_RUN,
      detail: s.trim() || '（没有可解析的报告）',
    }, extra))
  }
  const passed = Number(m[1]); const total = Number(m[2])
  return q(Object.assign({
    name: 'RealWorld 官方套件（hurl）', source: QUALITY_SOURCE.REALWORLD,
    state: total > 0 && passed === total ? QUALITY_STATE.PASS : QUALITY_STATE.FAIL,
    detail: s.trim(), passed, failed: Math.max(0, total - passed),
  }, extra))
}

// ── P16-07 性能 ──────────────────────────────────────────────────────────────
/**
 * 性能**没有"通过/失败"的天然标准** —— 所以只有在调用方给了阈值（`budgetQps`）时才判 PASS/FAIL，
 * 否则就是 WARN：**"跑出来了，但没人说它够不够快"**。WARN 这个状态正是为它准备的。
 */
function fromPerfReport(text, opts = {}) {
  const s = String(text == null ? '' : text)
  const m = /([\d.]+)\s*(?:qps|req\/s)/i.exec(s)
  if (!m) {
    return q({
      name: '性能（bench / loadtest）', source: QUALITY_SOURCE.PERFORMANCE,
      state: QUALITY_STATE.NOT_RUN, detail: s.trim() || '（没有可解析的报告）',
    })
  }
  const qps = Number(m[1])
  const budget = Number.isFinite(opts.budgetQps) ? opts.budgetQps : null
  const state = budget == null ? QUALITY_STATE.WARN : (qps >= budget ? QUALITY_STATE.PASS : QUALITY_STATE.FAIL)
  return q({
    name: '性能（bench / loadtest）', source: QUALITY_SOURCE.PERFORMANCE, state,
    detail: (s.trim() ? s.trim() + ' ' : '') + '实测 ' + qps + ' qps'
      + (budget == null ? '（未设阈值 → WARN）' : '（阈值 ' + budget + '）'),
  })
}

// ── P16-08 桌面验证体系（本项目自己的 32 个 Node 测试 + Electron 验证）──────
/**
 * 解析验证脚本的标准输出：`结果：31 通过 / 0 失败 / 共 31 项`。
 * 也认 `[FAIL]` 行（有时脚本崩了没有结果行，但能看出失败过）。
 */
function fromDesktopVerify(text, extra = {}) {
  const s = String(text == null ? '' : text)
  const m = /结果[:：]\s*(\d+)\s*通过\s*[/,]\s*(\d+)\s*失败/.exec(s)
  if (m) {
    const passed = Number(m[1]); const failed = Number(m[2])
    return q(Object.assign({
      name: '桌面验证（' + (extra.name || 'verify') + '）', source: QUALITY_SOURCE.DESKTOP,
      state: failed === 0 && passed > 0 ? QUALITY_STATE.PASS : (failed > 0 ? QUALITY_STATE.FAIL : QUALITY_STATE.NOT_RUN),
      detail: s.trim(), passed, failed,
    }, extra))
  }
  if (/\[FAIL\]/.test(s)) {
    return q(Object.assign({
      name: '桌面验证（' + (extra.name || 'verify') + '）', source: QUALITY_SOURCE.DESKTOP,
      state: QUALITY_STATE.FAIL, detail: s.trim(),
    }, extra))
  }
  // 全 ✅（有些脚本不用"结果"格式）
  if (/✅/.test(s) && !/❌|\[FAIL\]/.test(s)) {
    return q(Object.assign({
      name: '桌面验证（' + (extra.name || 'verify') + '）', source: QUALITY_SOURCE.DESKTOP,
      state: QUALITY_STATE.PASS, detail: '（按 ✅ 判定）',
    }, extra))
  }
  // SKIP 关键字（环境不满足）
  if (/\[SKIP\]|SKIP（|跳过/.test(s)) {
    return q(Object.assign({
      name: '桌面验证（' + (extra.name || 'verify') + '）', source: QUALITY_SOURCE.DESKTOP,
      state: QUALITY_STATE.SKIP, detail: s.trim(),
    }, extra))
  }
  return q(Object.assign({
    name: '桌面验证（' + (extra.name || 'verify') + '）', source: QUALITY_SOURCE.DESKTOP,
    state: QUALITY_STATE.NOT_RUN, detail: s.trim() || '（没有输出）',
  }, extra))
}

// ── P16-09 统一 Store ────────────────────────────────────────────────────────
function createQualityStore() {
  const items = new Map()
  return {
    /** 同一个 id 覆盖（重新跑一遍就是更新，不是追加）*/
    put(r) {
      if (!r || r.ok === false) return false
      items.set(r.id, r)
      return true
    },
    list() { return Array.from(items.values()) },
    get(id) { return items.get(id) || null },
    clear() { items.clear() },
    stats() {
      const by = {}
      for (const s of ALL_STATES) by[s] = 0
      for (const r of items.values()) by[r.state] = (by[r.state] || 0) + 1
      return { total: items.size, byState: by }
    },
    /** P16-11/12：只要"需要人管"的那些（FAIL 最要紧，WARN 次之）*/
    failures() {
      const rank = { FAIL: 0, WARN: 1, NOT_RUN: 2, SKIP: 3, PASS: 4 }
      return Array.from(items.values())
        .filter((r) => r.state === QUALITY_STATE.FAIL || r.state === QUALITY_STATE.WARN)
        .sort((a, b) => (rank[a.state] - rank[b.state]) || (b.at - a.at))
    },
  }
}

/**
 * 总体状态（P16-13/14 用它决定"能不能继续"）：
 *   有 FAIL → FAIL；否则有 WARN → WARN；否则全 SKIP → SKIP；一条都没有 → NOT_RUN；否则 PASS。
 */
function overall(storeOrList) {
  const list = Array.isArray(storeOrList) ? storeOrList : (storeOrList && storeOrList.list ? storeOrList.list() : [])
  if (!list.length) return QUALITY_STATE.NOT_RUN
  if (list.some((r) => r.state === QUALITY_STATE.FAIL)) return QUALITY_STATE.FAIL
  if (list.some((r) => r.state === QUALITY_STATE.WARN)) return QUALITY_STATE.WARN
  if (list.every((r) => r.state === QUALITY_STATE.SKIP)) return QUALITY_STATE.SKIP
  if (list.every((r) => r.state === QUALITY_STATE.PASS || r.state === QUALITY_STATE.SKIP)) return QUALITY_STATE.PASS
  return QUALITY_STATE.NOT_RUN
}

/** P16-14：Agent 要不要继续做下去 */
function canProceed(storeOrList) {
  const s = overall(storeOrList)
  if (s === QUALITY_STATE.FAIL) return { ok: false, state: s, reason: '有失败的检查项 —— 先把它们处理掉再继续' }
  if (s === QUALITY_STATE.NOT_RUN) return { ok: false, state: s, reason: '没有任何检查结果 —— 先跑一次再判断' }
  if (s === QUALITY_STATE.SKIP) return { ok: false, state: s, reason: '全部检查都因环境被跳过 —— 等于没验' }
  if (s === QUALITY_STATE.WARN) return { ok: true, state: s, reason: '没有失败项，但有需要人看的警告' }
  return { ok: true, state: s, reason: '全部通过' }
}

function describeQuality(storeOrList) {
  const list = Array.isArray(storeOrList) ? storeOrList : (storeOrList && storeOrList.list ? storeOrList.list() : [])
  const by = {}
  for (const s of ALL_STATES) by[s] = 0
  for (const r of list) by[r.state] = (by[r.state] || 0) + 1
  return '工程状态：' + overall(list) + ' ｜ 共 ' + list.length + ' 项'
    + ' ｜ PASS ' + by.PASS + ' FAIL ' + by.FAIL + ' WARN ' + by.WARN
    + ' SKIP ' + by.SKIP + ' NOT_RUN ' + by.NOT_RUN
}

module.exports = {
  QUALITY_STATE,
  ALL_STATES,
  QUALITY_SOURCE,
  QUALITY_LIMITS,
  createQualityResult,
  parseCounts,
  fromBuildResult,
  fromTestResult,
  fromWasmResult,
  fromSecurityReport,
  fromRealWorldReport,
  fromPerfReport,
  fromDesktopVerify,
  createQualityStore,
  overall,
  canProceed,
  describeQuality,
}
