// PH3-SESSION：会话的可用性层（标题 / 列表 / 搜索 / 导出 / 回放 / 关联）。
//
// 原有 session.js 已经有：messages / toolCalls / patches / verifications（都带上限）、
// listForProject、describeSession —— **存储与不可变性是它管的**。
// 这一层只做"给人看与给人查"的事，不改旧层。
//
// ⚠️ PH3-SESSION-10 有一条硬要求：**回放只展示 任务/动作/工具/结果，不展示隐藏思维链**。
//    所以 replay 是"白名单取字段"，不是"把整个对象丢出去" —— 后者早晚会把
//    模型返回的 reasoning/thinking 一起漏出去。
//
// 纯逻辑，可进 CI。

const LIMITS = Object.freeze({
  maxTitleChars: 40,
  maxExportChars: 200000,
})

function clip(s, n) { return String(s == null ? '' : s).slice(0, n) }

/**
 * PH3-SESSION-01：由**第一条用户任务**生成标题。
 * ⚠️ 只取任务文本，不编造 —— 取不到就明确说"未命名"，而不是用时间戳假装是个标题。
 */
function titleOf(session, opts = {}) {
  const max = Number.isFinite(opts.maxChars) ? opts.maxChars : LIMITS.maxTitleChars
  const msgs = (session && Array.isArray(session.messages)) ? session.messages : []
  const first = msgs.find((m) => m && m.role === 'user' && String(m.text || '').trim())
  if (!first) return '（未命名会话）'
  // 压掉换行与多余空白，截断处加省略号（让人一眼看出被截了）
  const one = String(first.text).replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : (one.slice(0, max - 1) + '…')
}

/** PH3-SESSION-02：列表项（标题 / 时间 / 项目 / 状态）。 */
function listItemOf(session) {
  if (!session) return null
  const s = session
  return {
    id: s.id,
    title: titleOf(s),
    project: s.projectRoot || null,
    status: s.endedAt ? '已结束' : '进行中',
    archived: s.archived === true,
    createdAt: s.createdAt || null,
    updatedAt: s.updatedAt || null,
    counts: {
      messages: (s.messages || []).length,
      toolCalls: (s.toolCalls || []).length,
      patches: (s.patches || []).length,
      verifications: (s.verifications || []).length,
    },
  }
}

function listSessions(sessions, opts = {}) {
  const items = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && (opts.includeArchived === true || s.archived !== true))
    .map(listItemOf)
  // 默认按更新时间倒序（最近动的排前面）
  items.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
  return items
}

/**
 * PH3-SESSION-03：搜索。匹配**标题与消息文本**，不匹配思维链（本来也没存）。
 * 返回命中原因，便于界面高亮"为什么这条被搜出来"。
 */
function searchSessions(sessions, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase()
  if (!q) return []
  const out = []
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || s.archived === true) continue
    const title = titleOf(s).toLowerCase()
    if (title.indexOf(q) >= 0) { out.push({ item: listItemOf(s), hit: 'title' }); continue }
    const msgs = Array.isArray(s.messages) ? s.messages : []
    const hitMsg = msgs.find((m) => m && String(m.text || '').toLowerCase().indexOf(q) >= 0)
    if (hitMsg) { out.push({ item: listItemOf(s), hit: 'message' }); continue }
  }
  return out
}

/** PH3-SESSION-05/06：归档与删除（都要**明确**）。 */
function archiveSession(session, now) {
  if (!session) return { ok: false, error: '没有会话' }
  const at = Number.isFinite(now) ? now : Date.now()
  return { ok: true, session: Object.assign({}, session, { archived: true, archivedAt: at }) }
}

function deleteSession(session, opts = {}) {
  if (!session) return { ok: false, error: '没有会话' }
  if (opts.confirmed !== true) return { ok: false, error: '删除会话必须明确确认（传 confirmed: true）' }
  return {
    ok: true,
    tombstone: { id: session.id, project: session.projectRoot || null, deletedAt: Number.isFinite(opts.now) ? opts.now : Date.now(), deletedBy: opts.by || 'user', title: titleOf(session) },
  }
}

/**
 * PH3-SESSION-10：回放 —— **只展示"做了什么"**。
 *
 * ⚠️ 白名单取字段，不是把对象丢出去。原因很实在：
 *    模型响应里常带 reasoning / thinking / 内部草稿，一旦"整个对象 JSON 出去"
 *    它们就会顺着导出与界面漏出来。这里只取四类：
 *      任务（user 说了什么）/ 动作（工具调用）/ 结果（成功失败与摘要）/ 验证（闭环结论）
 */
const REPLAY_KIND = Object.freeze({ TASK: 'task', TOOL: 'tool', PATCH: 'patch', VERIFY: 'verify' })

function replaySession(session) {
  if (!session) return { ok: false, error: '没有会话', steps: [] }
  const steps = []
  for (const m of session.messages || []) {
    if (m && m.role === 'user') {
      steps.push({ kind: REPLAY_KIND.TASK, at: m.at || null, text: clip(m.text, 300) })
    }
  }
  for (const t of session.toolCalls || []) {
    steps.push({
      kind: REPLAY_KIND.TOOL, at: t.at || null,
      tool: clip(t.name, 60), ok: t.ok === true,
      // 只给结论摘要，不给参数全文 —— 参数里可能有敏感内容
      summary: clip(t.error || t.summary || '', 200) || null,
    })
  }
  for (const p of session.patches || []) {
    steps.push({
      kind: REPLAY_KIND.PATCH, at: p.at || null,
      file: clip(p.file, 200), applied: p.applied === true,
      summary: clip(p.summary, 200) || null,
      sessionId: p.sessionId || null, taskId: p.taskId || null,
    })
  }
  for (const v of session.verifications || []) {
    steps.push({
      kind: REPLAY_KIND.VERIFY, at: v.at || null,
      ok: v.ok === true, status: clip(v.status, 60),
      stepsCount: (v.steps || []).length,
    })
  }
  steps.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))

  // ★ 结构保证：产出里**不含**任何思维链字段
  const forbidden = ['reasoning', 'thinking', 'thought', 'chainOfThought', 'rawResponse', 'raw']
  const leak = []
  for (const st of steps) {
    for (const k of Object.keys(st)) if (forbidden.indexOf(k) >= 0) leak.push(k)
  }
  return {
    ok: true, steps, leak,
    note: '只展示 任务 / 动作 / 工具 / 结果 —— 不展示隐藏思维链',
  }
}

/** PH3-SESSION-07：导出。JSON 给机器，Markdown 给人。 */
function exportSession(session, format = 'json') {
  if (!session) return { ok: false, error: '没有会话' }
  const r = replaySession(session)
  if (format === 'md' || format === 'markdown') {
    const lines = []
    lines.push('# ' + titleOf(session))
    lines.push('')
    lines.push('- 项目：' + (session.projectRoot || '（无）'))
    lines.push('- 时间：' + (session.createdAt ? new Date(session.createdAt).toISOString() : '（未知）'))
    lines.push('- 统计：消息 ' + (session.messages || []).length + ' / 工具 ' + (session.toolCalls || []).length +
      ' / 补丁 ' + (session.patches || []).length + ' / 验证 ' + (session.verifications || []).length)
    lines.push('')
    for (const st of r.steps) {
      if (st.kind === 'task') lines.push('## 任务\n\n' + st.text + '\n')
      else if (st.kind === 'tool') lines.push('- 工具 ' + st.tool + '：' + (st.ok ? '成功' : '失败') + (st.summary ? '（' + st.summary + '）' : ''))
      else if (st.kind === 'patch') lines.push('- 补丁 ' + st.file + '：' + (st.applied ? '已落盘' : '未落盘') + (st.summary ? '（' + st.summary + '）' : ''))
      else if (st.kind === 'verify') lines.push('- 验证：' + (st.ok ? '通过' : '未通过') + ' ' + st.status)
    }
    lines.push('')
    lines.push('> ' + r.note)
    return { ok: true, format: 'md', text: clip(lines.join('\n'), LIMITS.maxExportChars), steps: r.steps.length }
  }
  return {
    ok: true, format: 'json',
    text: clip(JSON.stringify({
      title: titleOf(session),
      project: session.projectRoot || null,
      createdAt: session.createdAt || null,
      counts: listItemOf(session).counts,
      // ★ 导出走的是 replay 的**白名单结果**，不是原始 session
      steps: r.steps,
      note: r.note,
    }, null, 2), LIMITS.maxExportChars),
    steps: r.steps.length,
  }
}

/**
 * PH3-SESSION-08/09：把 Patch / Verification 与 Session、Task 关联起来。
 * ⚠️ 关联信息是在**记录时**写进去的（而不是事后靠时间猜）——
 *    事后猜在多任务并行时必然错。
 */
function withLinks(entry, links = {}) {
  const e = Object.assign({}, entry || {})
  if (links.sessionId != null) e.sessionId = String(links.sessionId)
  if (links.taskId != null) e.taskId = String(links.taskId)
  return e
}

/** Resume：接上一次的会话（只认**同一个工作空间**里的，不跨项目）。 */
function resumeTarget(sessions, projectRoot) {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.archived !== true && s.projectRoot === projectRoot)
  if (!list.length) return { ok: false, error: '这个项目还没有会话', session: null }
  list.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
  return { ok: true, session: list[0], reason: '接最近一次更新的会话' }
}

module.exports = {
  LIMITS, REPLAY_KIND,
  titleOf, listItemOf, listSessions, searchSessions,
  archiveSession, deleteSession, replaySession, exportSession,
  withLinks, resumeTarget,
}
