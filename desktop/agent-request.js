'use strict'

const { createAgentContext, renderAgentContext } = require('./agent-context')

/**
 * Agent 的请求 / 响应契约（Phase 2.1 / P5A-01、P5A-02）
 *
 * 为什么先定契约：`agent-context.js` 的组装器早就建好了，但它的输入是"调用方随手传的普通对象"，
 * 谁都能传错字段、传假数据，而且**看不到 Agent 实际收到了什么**。
 * 这一层把两件事固定下来：
 *
 *   ① 出入参的**形状**（缺的就是 null / []，不编造）；
 *   ② 一份**快照**（snapshot），让人能直接看到"这次请求真实带了什么"，而不是去猜 prompt。
 *
 * 纯逻辑、零依赖（不 require electron），可以直接进 CI。
 */

/** 响应状态。`need_confirm` 是关键：**Patch 必须先经用户确认**（Gate P8），不能悄悄改文件。 */
const AGENT_STATUS = Object.freeze({
  OK: 'ok',
  NEED_CONFIRM: 'need_confirm',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

const ALL_STATUS = Object.freeze(Object.values(AGENT_STATUS))

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== ''
}

function trimmedOrNull(v) {
  return isNonEmptyString(v) ? String(v).trim() : null
}

/**
 * P5A-01：构造一个 AgentRequest。
 *
 * @param {object} input
 * @param {string} input.requestId      唯一标识（不传则生成一个）
 * @param {string} [input.sessionId]    会话标识（P10 才真正使用；这里允许为 null）
 * @param {string} input.message        用户这句话
 * @param {object} [input.projectContext] 真实 ProjectContext（无项目时为 null）
 * @param {object} [input.activeFile]   { path, content, language }
 * @param {object} [input.selection]    { text, startLine, endLine }
 * @param {number} [input.createdAt]
 */
function createAgentRequest(input = {}) {
  const errs = []
  const requestId = trimmedOrNull(input.requestId) || newRequestId()
  const message = trimmedOrNull(input.message)
  if (!message) errs.push('message 不能为空')

  // projectContext 允许为 null（没打开项目也能问问题），但传了就必须是个对象
  const pc = input.projectContext
  if (pc != null && (typeof pc !== 'object' || Array.isArray(pc))) errs.push('projectContext 必须是对象或 null')
  if (pc && !isNonEmptyString(pc.rootDir)) errs.push('projectContext.rootDir 缺失')

  return Object.freeze({
    ok: errs.length === 0,
    errors: Object.freeze(errs),
    requestId,
    sessionId: trimmedOrNull(input.sessionId),                  // 允许 null
    message: message || '',
    projectContext: pc || null,
    activeFile: normalizeFile(input.activeFile),
    selection: normalizeSelection(input.selection),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
  })
}

function normalizeFile(f) {
  if (!f || typeof f !== 'object') return null
  if (!isNonEmptyString(f.path)) return null
  return Object.freeze({
    path: String(f.path),
    content: typeof f.content === 'string' ? f.content : '',
    language: trimmedOrNull(f.language),
  })
}

function normalizeSelection(s) {
  if (!s || typeof s !== 'object') return null
  if (typeof s.text !== 'string' || s.text === '') return null
  return Object.freeze({
    text: s.text,
    startLine: Number.isFinite(s.startLine) ? s.startLine : null,
    endLine: Number.isFinite(s.endLine) ? s.endLine : null,
  })
}

let _seq = 0
function newRequestId() {
  _seq += 1
  return 'req-' + Date.now().toString(36) + '-' + _seq
}

/**
 * P5A-02：构造一个 AgentResponse。
 *
 * `toolCalls` / `patches` / `verification` 都只做**摘要**（不塞原始输出，避免把日志当数据传）。
 */
function createAgentResponse(input = {}) {
  const errs = []
  const requestId = trimmedOrNull(input.requestId)
  if (!requestId) errs.push('requestId 不能为空')
  const status = trimmedOrNull(input.status) || AGENT_STATUS.OK
  if (!ALL_STATUS.includes(status)) errs.push('status 非法：' + status)

  return Object.freeze({
    ok: errs.length === 0,
    errors: Object.freeze(errs),
    requestId: requestId || '',
    status,
    message: typeof input.message === 'string' ? input.message : '',
    toolCalls: Object.freeze((Array.isArray(input.toolCalls) ? input.toolCalls : []).map(normalizeToolCall)),
    patches: Object.freeze((Array.isArray(input.patches) ? input.patches : []).map(normalizePatch)),
    verification: normalizeVerification(input.verification),
  })
}

function normalizeToolCall(t) {
  const o = t && typeof t === 'object' ? t : {}
  return Object.freeze({
    name: trimmedOrNull(o.name) || '?',
    ok: o.ok === true,
    ms: Number.isFinite(o.ms) ? o.ms : null,
    error: trimmedOrNull(o.error),
    // 只留一行摘要，不留完整结果体
    summary: typeof o.summary === 'string' ? o.summary.slice(0, 200) : '',
  })
}

function normalizePatch(p) {
  const o = p && typeof p === 'object' ? p : {}
  return Object.freeze({
    file: trimmedOrNull(o.file) || '?',
    summary: typeof o.summary === 'string' ? o.summary.slice(0, 200) : '',
    token: trimmedOrNull(o.token),
    applied: o.applied === true,
  })
}

function normalizeVerification(v) {
  if (!v || typeof v !== 'object') return null
  return Object.freeze({
    ok: v.ok === true,
    status: trimmedOrNull(v.status),
    rounds: Number.isFinite(v.rounds) ? v.rounds : null,
    steps: Object.freeze((Array.isArray(v.steps) ? v.steps : []).map((s) => {
      const o = s && typeof s === 'object' ? s : {}
      return Object.freeze({
        name: trimmedOrNull(o.name) || '?',
        ok: o.ok === true,
        ms: Number.isFinite(o.ms) ? o.ms : null,
        error: trimmedOrNull(o.error),
      })
    })),
  })
}

// ── P5A-03 / P5A-04：从**真实来源**取数 ────────────────────────────────────────
/**
 * 收集 Agent 输入。全部依赖注入：渲染侧传真实的 `window.moonbitIDE`，测试传假数据。
 *
 * 设计要点：**取不到某一路不算失败** —— 只记进 `sources`，四态分明：
 *   `absent` 没注入这个来源    `empty` 注入了但没数据（null / 空数组）
 *   `ok`     真的拿到了值      `error: …` 取数报错了
 *
 * 与 `agent-context.js` 的 `buildAgentContext(sources)` 的关系（别重复造）：
 *   那个是 P5 时的「取数 + 组装」一体版，**但建好后没有任何生产调用点**（只在它自己的单测里用过）。
 *   本函数把「取数」单独拆出来，并补上 P5A 需要的东西 ——**每一路取数的状态**
 *   （ok / absent / error），这样出问题时能看出「是没数据，还是取数炸了」。
 *   组装仍由既有 `createAgentContext` / `renderAgentContext` 完成，不另起一套。
 * 因为「没打开项目」「没有问题」「还没跑过」都是合法状态，不该让整个提问挂掉。
 * 反过来，`sources` 要如实记录哪一路报错了 —— 不能让「取数失败」静默变成「没有数据」
 * （这正是空 catch 门禁要防的那种 bug）。
 */
async function collectAgentInputs(deps = {}, opts = {}) {
  const sources = {}
  const out = {
    task: opts.task == null ? null : String(opts.task),
    project: null, activeFile: null, selection: null,
    problems: [], lastRun: null, lastTest: null, recentFiles: [],
  }

  async function take(key, fn, assign) {
    if (typeof fn !== 'function') { sources[key] = 'absent'; return }
    try {
      const v = await fn()
      assign(v)
      // 三态区分：真的拿到值 / 注入了但没数据 / 取数报错 ——
      // 不能把「没数据」当成「取到了」（那是空 catch 门禁要防的同一类误会）
      const empty = v == null || (Array.isArray(v) && v.length === 0)
      sources[key] = empty ? 'empty' : 'ok'
    } catch (e) {
      sources[key] = 'error: ' + String((e && e.message) || e).slice(0, 120)
    }
  }

  await take('project', deps.getContext, (v) => { out.project = v || null })
  await take('problems', deps.listProblems, (v) => { out.problems = Array.isArray(v) ? v : [] })
  await take('activeFile', deps.getActiveFile, (v) => { out.activeFile = v || null })
  await take('selection', deps.getSelection, (v) => { out.selection = v || null })
  await take('lastRun', deps.getLastRun, (v) => { out.lastRun = v || null })
  await take('lastTest', deps.getLastTest, (v) => { out.lastTest = v || null })
  await take('recentFiles', deps.getRecentFiles, (v) => { out.recentFiles = Array.isArray(v) ? v : [] })

  return { inputs: out, sources }
}

/** 从 inputs 组装一份不可变上下文（就是 P5-01 那个组装器）*/
function contextFromInputs(inputs = {}, opts = {}) {
  return createAgentContext(Object.assign({}, inputs, {
    task: inputs.task == null ? opts.task : inputs.task,
  }))
}

// ── P5A-05：Context Snapshot ──────────────────────────────────────────────────
/**
 * 输出「Agent 实际收到了什么」。
 *
 * 开发时直接看这个，而**不是去猜 prompt**。默认只给摘要（不塞正文），
 * 需要全文时传 `{ includeRendered: true }`。
 */
function buildContextSnapshot(request, inputs, sources, opts = {}) {
  const ctx = opts.context || contextFromInputs(inputs, { task: request && request.message })
  const rendered = renderAgentContext(ctx, opts.renderOpts || {})
  const bySev = {}
  for (const p of ctx.problems || []) {
    const s = (p && p.severity) || 'unknown'
    bySev[s] = (bySev[s] || 0) + 1
  }
  const pc = ctx.project || null
  const snap = {
    requestId: request ? request.requestId : null,
    sessionId: request ? request.sessionId : null,
    message: request ? request.message : null,
    hasProject: !!(pc && pc.rootDir),
    project: pc ? { rootDir: pc.rootDir, projectType: pc.projectType || null, label: pc.label || null } : null,
    activeFile: ctx.activeFile
      ? { path: ctx.activeFile.path, chars: String(ctx.activeFile.content || '').length, language: ctx.activeFile.language || null }
      : null,
    selection: ctx.selection
      ? { startLine: ctx.selection.startLine, endLine: ctx.selection.endLine, chars: String(ctx.selection.text || '').length }
      : null,
    problems: { total: (ctx.problems || []).length, bySeverity: bySev },
    lastRun: ctx.lastRun ? { ok: ctx.lastRun.ok === true, status: ctx.lastRun.status || null, url: ctx.lastRun.url || null } : null,
    lastTest: ctx.lastTest ? { ok: ctx.lastTest.ok === true, name: ctx.lastTest.name || null } : null,
    recentFiles: (ctx.recentFiles || []).length,
    sources: Object.assign({}, sources || {}),
    contextChars: rendered && typeof rendered.used === 'number' ? rendered.used : 0,
  }
  if (opts.includeRendered) {
    // renderAgentContext 返回的是对象 { text, used, maxChars, included, omitted, clipped }
    snap.rendered = rendered.text
    snap.included = rendered.included.slice()
    snap.omitted = rendered.omitted.slice()
  }
  return Object.freeze(snap)
}

/** 一行话的摘要，适合打在输出面板里 */
function describeSnapshot(snap) {
  if (!snap) return '（无快照）'
  const parts = [
    'req=' + (snap.requestId || '?'),
    snap.hasProject ? ('项目=' + (snap.project && snap.project.projectType || '?') + '@' + (snap.project && snap.project.rootDir)) : '无项目',
    snap.activeFile ? ('文件=' + snap.activeFile.path) : '无当前文件',
    '问题=' + (snap.problems ? snap.problems.total : 0),
    '上下文=' + snap.contextChars + ' 字符',
  ]
  const bad = Object.entries(snap.sources || {}).filter(([, v]) => String(v).startsWith('error'))
  if (bad.length) parts.push('取数异常=' + bad.map(([k]) => k).join(','))
  // 去换行：这份摘要会进日志，含换行就能伪造一条日志行（review 指出）
  return parts.join(' ｜ ').replace(/[\r\n]+/g, ' ')
}

module.exports = {
  AGENT_STATUS,
  ALL_STATUS,
  createAgentRequest,
  createAgentResponse,
  newRequestId,
  collectAgentInputs,
  contextFromInputs,
  buildContextSnapshot,
  describeSnapshot,
}
