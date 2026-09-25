'use strict'

/**
 * Session —— 会话与**项目**绑定（Phase 2.1 / P10）
 *
 * 为什么要有这一层：现在渲染侧只存了一个 opencode 的 session id 字符串
 * （`localStorage: moonbit-agent-session`），**没有和项目绑定** ——
 * 换项目之后会继续复用同一个会话，于是 A 项目的上下文会漏给 B 项目。
 * 这正是清单 P10-11 要防的「跨项目污染」。
 *
 * 设计取舍：
 *   · **不可变**（每个 add* 返回新对象）—— 便于测试，也避免"历史被之后的操作改掉"
 *   · **只记事实**（消息/工具调用/补丁/验证）—— 不存模型的思考过程
 *   · **有上限**（消息条数、单条长度）—— 会话不能无限长
 *   · 与 opencode 的关系：`opencodeSessionId` 是**外部会话 id**（用于 `--session` 续接），
 *     本模块的 `id` 是**我们自己的会话标识**（用于绑定项目与归档）。两者不是一回事。
 *
 * 纯逻辑、零依赖，可直接进 CI。
 */

const SESSION_LIMITS = Object.freeze({
  maxMessages: 200,
  maxToolCalls: 200,
  maxPatches: 100,
  maxVerifications: 50,
  maxTextChars: 4000,      // 单条消息正文上限
})

const SESSION_STATE = Object.freeze({
  ACTIVE: 'active',
  ENDED: 'ended',          // 关闭项目 / 显式结束
})

function nowDefault() { return Date.now() }

let _seq = 0
function defaultIdFactory() {
  _seq += 1
  return 'sess-' + Date.now().toString(36) + '-' + _seq
}

function clip(s, max) {
  const t = String(s == null ? '' : s)
  return t.length <= max ? t : t.slice(0, max) + '…'
}

function rootOf(ctx) {
  return (ctx && typeof ctx.rootDir === 'string' && ctx.rootDir) ? ctx.rootDir : ''
}

/** 项目身份：用**根目录**判断同一个项目（类型变化不算换项目）*/
function isSameProject(session, ctx) {
  if (!session || !session.projectRoot) return false
  const r = rootOf(ctx)
  return !!r && r === session.projectRoot
}

/**
 * P10-01 / P10-02：建一个会话并**绑定项目上下文**。
 * 没有项目时也允许建（可以"没打开项目先问一句"），但 projectRoot 为 null —— 这种会话
 * 不会与任何项目匹配，也就不会污染别人。
 */
function createSession(input = {}) {
  const ctx = input.projectContext || null
  const root = rootOf(ctx)
  return Object.freeze({
    id: input.id || (typeof input.idFactory === 'function' ? input.idFactory() : defaultIdFactory()),
    // ── P10-02 绑定 ProjectContext ──
    projectRoot: root || null,
    projectType: (ctx && ctx.projectType) || null,
    // opencode 那一侧的会话 id（用于 --session 续接）；可能稍后才拿到
    opencodeSessionId: input.opencodeSessionId || null,
    state: SESSION_STATE.ACTIVE,
    createdAt: Number.isFinite(input.now) ? input.now : nowDefault(),
    updatedAt: Number.isFinite(input.now) ? input.now : nowDefault(),
    // ── P10-03～07 记录的事实 ──
    messages: Object.freeze([]),
    toolCalls: Object.freeze([]),
    patches: Object.freeze([]),
    verifications: Object.freeze([]),
  })
}

function touch(s, now, patch) {
  return Object.freeze(Object.assign({}, s, patch, {
    updatedAt: Number.isFinite(now) ? now : nowDefault(),
  }))
}

function pushCapped(list, item, cap) {
  const next = list.concat([item])
  return Object.freeze(next.length <= cap ? next : next.slice(next.length - cap))
}

/** P10-03：记一条消息。ended 的会话不再接受新内容（避免"收尾之后还在长"）。*/
function addMessage(session, msg = {}, opts = {}) {
  if (!session) throw new Error('addMessage 需要 session')
  if (session.state === SESSION_STATE.ENDED) return session
  const entry = Object.freeze({
    role: String(msg.role || 'user'),
    text: clip(msg.text, SESSION_LIMITS.maxTextChars),
    at: Number.isFinite(msg.at) ? msg.at : (Number.isFinite(opts.now) ? opts.now : nowDefault()),
  })
  return touch(session, opts.now, { messages: pushCapped(session.messages, entry, SESSION_LIMITS.maxMessages) })
}

/** P10-04：记一次工具调用（只留摘要，不留完整结果体）*/
function addToolCall(session, call = {}, opts = {}) {
  if (!session) throw new Error('addToolCall 需要 session')
  if (session.state === SESSION_STATE.ENDED) return session
  const entry = Object.freeze({
    name: String(call.name || '?'),
    ok: call.ok === true,
    ms: Number.isFinite(call.ms) ? call.ms : null,
    error: call.error ? clip(call.error, 300) : null,
    at: Number.isFinite(call.at) ? call.at : (Number.isFinite(opts.now) ? opts.now : nowDefault()),
  })
  return touch(session, opts.now, { toolCalls: pushCapped(session.toolCalls, entry, SESSION_LIMITS.maxToolCalls) })
}

/** P10-05：记工具结果（与调用分开 —— 结果可能是"被截断"的，要能看出来）*/
function addToolResult(session, result = {}, opts = {}) {
  if (!session) throw new Error('addToolResult 需要 session')
  if (session.state === SESSION_STATE.ENDED) return session
  const entry = Object.freeze({
    name: String(result.name || '?'),
    ok: result.ok === true,
    truncated: result.truncated === true,
    summary: clip(result.summary, 300),
    at: Number.isFinite(result.at) ? result.at : (Number.isFinite(opts.now) ? opts.now : nowDefault()),
  })
  return touch(session, opts.now, { toolCalls: pushCapped(session.toolCalls, entry, SESSION_LIMITS.maxToolCalls) })
}

/** P10-06：记一次补丁（含是否真的落盘 —— 未确认的不能算 applied）*/
function addPatch(session, patch = {}, opts = {}) {
  if (!session) throw new Error('addPatch 需要 session')
  if (session.state === SESSION_STATE.ENDED) return session
  const entry = Object.freeze({
    file: String(patch.file || '?'),
    summary: clip(patch.summary, 200),
    applied: patch.applied === true,
    token: patch.token ? String(patch.token) : null,
    at: Number.isFinite(patch.at) ? patch.at : (Number.isFinite(opts.now) ? opts.now : nowDefault()),
  })
  return touch(session, opts.now, { patches: pushCapped(session.patches, entry, SESSION_LIMITS.maxPatches) })
}

/** P10-07：记一次验证结论 */
function addVerification(session, v = {}, opts = {}) {
  if (!session) throw new Error('addVerification 需要 session')
  if (session.state === SESSION_STATE.ENDED) return session
  const entry = Object.freeze({
    ok: v.ok === true,
    status: v.status ? String(v.status) : null,
    rounds: Number.isFinite(v.rounds) ? v.rounds : null,
    stoppedReason: v.stoppedReason ? clip(v.stoppedReason, 200) : null,
    steps: Object.freeze((Array.isArray(v.steps) ? v.steps : []).map((s) => Object.freeze({
      name: String((s && s.name) || '?'),
      ok: !!(s && s.ok === true),
    }))),
    at: Number.isFinite(v.at) ? v.at : (Number.isFinite(opts.now) ? opts.now : nowDefault()),
  })
  return touch(session, opts.now, { verifications: pushCapped(session.verifications, entry, SESSION_LIMITS.maxVerifications) })
}

/** 把 opencode 的会话 id 记下来（下一轮 `--session` 续接用）*/
function setOpencodeSessionId(session, id, opts = {}) {
  if (!session) throw new Error('setOpencodeSessionId 需要 session')
  return touch(session, opts.now, { opencodeSessionId: id ? String(id) : null })
}

/** P10-10：结束会话上下文（关闭项目时调用）—— 之后不再接受新的记录 */
function endSession(session, opts = {}) {
  if (!session) throw new Error('endSession 需要 session')
  return touch(session, opts.now, { state: SESSION_STATE.ENDED })
}

/**
 * P10-09：为一个项目找**已有的活跃会话**；没有就新建。
 *
 * ★ 这是"禁止跨项目污染"的入口：只认 `projectRoot` 相同的会话，
 *   不同项目绝不会拿到同一个 session（旧实现只按 localStorage 里一个字符串复用 → 会串）。
 */
function findOrCreateForProject(sessions, projectContext, opts = {}) {
  const list = Array.isArray(sessions) ? sessions : []
  const root = rootOf(projectContext)
  if (root) {
    const hit = list.find((s) => s.state === SESSION_STATE.ACTIVE && s.projectRoot === root)
    if (hit) return { session: hit, created: false }
  }
  return { session: createSession(Object.assign({}, opts, { projectContext })), created: true }
}

/** 列出某项目下的会话（诊断用；不会返回别的项目的）*/
function listForProject(sessions, projectContext) {
  const root = rootOf(projectContext)
  const list = Array.isArray(sessions) ? sessions : []
  return root ? list.filter((s) => s.projectRoot === root) : []
}

function describeSession(s) {
  if (!s) return '（无会话）'
  const p = s.projectRoot ? (s.projectType || '?') + '@' + s.projectRoot : '无项目'
  return 'sess=' + s.id + ' ｜ 项目=' + p + ' ｜ ' + s.state
    + ' ｜ 消息=' + s.messages.length + ' 工具=' + s.toolCalls.length
    + ' 补丁=' + s.patches.length + ' 验证=' + s.verifications.length
    + (s.opencodeSessionId ? ' ｜ oc=' + s.opencodeSessionId : '')
}

module.exports = {
  SESSION_LIMITS,
  SESSION_STATE,
  createSession,
  isSameProject,
  addMessage,
  addToolCall,
  addToolResult,
  addPatch,
  addVerification,
  setOpencodeSessionId,
  endSession,
  findOrCreateForProject,
  listForProject,
  describeSession,
}
