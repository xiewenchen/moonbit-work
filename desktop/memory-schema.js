// PH3-MEM：项目记忆的**统一 Schema** 与生命周期。
//
// 原有 project-memory.js 已有经验（error/solution/verified）、规则、检索阈值。
// 这一层补的是清单 §8 要的那几件：
//   · 统一的 Schema（id/type/project/content/source/verified/createdAt/updatedAt）
//   · 五类记忆：RULE / FACT / PATTERN / ERROR / DECISION
//   · **候选 → 用户确认** 的两段式（Agent 只能 propose，不能直接写）
//   · 检索时**不相关就不注入**（而不是"总能找出几条"）
//   · 合并（A+B → C，A/B **先归档**）
//   · 跨项目隔离（用 workspace.js 的身份判断，不靠字符串前缀）
//
// 纯逻辑、全依赖注入 —— 可进 CI。

const { workspaceIdOf } = require('./workspace')

/** PH3-MEM-02：五类记忆。 */
const MEMORY_TYPE = Object.freeze({
  RULE: 'RULE',          // 项目规矩（"这个项目不用 ORM"）
  FACT: 'FACT',          // 项目事实（"入口是 cmd/main/main.mbt"）
  PATTERN: 'PATTERN',    // 重复出现的做法
  ERROR: 'ERROR',        // 踩过的错（**必须 verified 才入库**）
  DECISION: 'DECISION',  // 做过的决定与理由
})
const ALL_TYPES = Object.freeze(Object.values(MEMORY_TYPE))

/** 入库来源（谁把它放进去的）。 */
const MEMORY_SOURCE = Object.freeze({
  USER: 'user',          // 用户明确写的
  AGENT: 'agent',        // Agent 提议、用户确认的
  MIGRATION: 'migration',// 从旧格式迁过来的
})

const LIMITS = Object.freeze({
  maxContentChars: 1200,
  maxIdChars: 120,
})

function clip(s, n) { return String(s == null ? '' : s).slice(0, n) }

/**
 * PH3-MEM-01：建一条记忆。
 *
 * ⚠️ 两条硬约束，不写在文档里、写在代码里：
 *   ① `verified` **默认 false** —— 新东西默认"没验过"，不是"验过了"；
 *   ② ERROR 类型**必须** verified 才是有效记忆（PH3-MEM-03：只有已验证的错误进经验库）。
 *      "我猜是这个问题"不是经验，把它当经验会让后续判断建立在猜测上。
 */
function createMemory(input, now) {
  // ⚠️ 写 `input = {}` 对 **null** 不生效（只有 undefined 才触发默认参数）。
  //    我已在本仓库踩到**第三次**（agent-task.recoverInterrupted、workspace.checkBinding、这里）——
  //    凡是外部传进来的对象，一律在函数体内守卫，不要依赖默认参数。
  const inp = (input && typeof input === 'object') ? input : {}
  // now 可以从第二参传，也可以跟在 input 里（调用方常常一起给）
  const at = Number.isFinite(now) ? now : (Number.isFinite(inp.now) ? inp.now : Date.now())
  const type = ALL_TYPES.includes(inp.type) ? inp.type : null
  const content = clip(inp.content, LIMITS.maxContentChars).trim()
  const errors = []
  if (!type) errors.push('type 必须是 ' + ALL_TYPES.join('/') + ' 之一')
  if (!content) errors.push('content 不能为空')
  const verified = inp.verified === true
  if (type === MEMORY_TYPE.ERROR && !verified) {
    errors.push('ERROR 类型必须 verified=true（未验证的猜测不算经验）')
  }
  const m = Object.freeze({
    id: clip(inp.id || ('mem_' + type + '_' + String(at)), LIMITS.maxIdChars),
    type,
    project: workspaceIdOf(inp.project) || null,   // ★ 用工作空间身份，不用原始字符串
    content,
    source: Object.values(MEMORY_SOURCE).includes(inp.source) ? inp.source : MEMORY_SOURCE.AGENT,
    verified,
    createdAt: Number.isFinite(inp.createdAt) ? inp.createdAt : at,
    updatedAt: at,
    archived: false,
  })
  return { ok: errors.length === 0, memory: errors.length ? null : m, errors }
}

/** PH3-MEM-03：它能不能真的进经验库/记忆库。 */
function canStore(memory) {
  if (!memory) return { ok: false, reason: '不是合法记忆' }
  if (memory.type === MEMORY_TYPE.ERROR && memory.verified !== true) {
    return { ok: false, reason: '未验证的 ERROR 不进记忆库（PH3-MEM-03）' }
  }
  if (!memory.project) return { ok: false, reason: '没有归属工作空间，拒绝入库' }
  return { ok: true }
}

// ── PH3-MEM-06/07：候选 → 用户确认 ────────────────────────────────────────────
/**
 * ⚠️ Agent 只能 `proposeMemory`，**不能直接写**。
 *    所以 propose 产出的是"候选"，它**不在**记忆库里；只有 accept 之后才进去。
 */
function proposeMemory(memory, meta, now) {
  if (!memory) return { ok: false, error: '没有可提议的记忆' }
  const mt = (meta && typeof meta === 'object') ? meta : {}   // 同上的 null 守卫
  const at = Number.isFinite(now) ? now : Date.now()
  const cs = canStore(memory)
  return {
    ok: true,
    proposal: Object.freeze({
      id: 'prop_' + String(at) + '_' + String(memory.id || ''),
      memory,
      origin: mt.origin == null ? 'agent' : String(mt.origin),
      reason: mt.reason == null ? null : clip(mt.reason, 300),
      proposedAt: at,
      state: 'PENDING',
      // ★ 如实说明它现在**还没进**记忆库（以及不能进的原因）
      willStore: cs.ok,
      blockedReason: cs.ok ? null : cs.reason,
    }),
  }
}

/** PH3-MEM-07：用户 Keep。 */
function acceptProposal(proposal, opts, now) {
  if (!proposal || proposal.state !== 'PENDING') return { ok: false, error: '没有待确认的候选' }
  const o = (opts && typeof opts === 'object') ? opts : {}
  const cs = canStore(proposal.memory)
  if (!cs.ok) return { ok: false, error: '确认了也不能入库：' + cs.reason }
  const at = Number.isFinite(now) ? now : Date.now()
  const m = Object.freeze(Object.assign({}, proposal.memory, {
    source: MEMORY_SOURCE.AGENT,
    updatedAt: at,
    acceptedBy: o.by == null ? 'user' : String(o.by),
  }))
  return { ok: true, memory: m, proposal: Object.freeze(Object.assign({}, proposal, { state: 'ACCEPTED', decidedAt: at })) }
}

/** PH3-MEM-07：用户 Discard。 */
function discardProposal(proposal, reason, now) {
  if (!proposal || proposal.state !== 'PENDING') return { ok: false, error: '没有待确认的候选' }
  const at = Number.isFinite(now) ? now : Date.now()
  return {
    ok: true,
    proposal: Object.freeze(Object.assign({}, proposal, {
      state: 'DISCARDED', decidedAt: at, discardReason: reason == null ? null : clip(reason, 200),
    })),
  }
}

// ── PH3-MEM-09/10/13：检索（不相关就**不注入**）────────────────────────────────
const STOP = new Set(('the a an and or of to in is are be this that it for with on at by from ' +
  '的了 和 与 或 在 是 有 我 你 他 这 那 一个 一下 怎么 如何 什么 为 把 被 让 给 从 到').split(/\s+/))

/**
 * 分词。⚠️ 中文必须做 **2-gram**：
 *   按非字母数字切开的话，一整串中文会变成**一个** token，
 *   于是"入口文件在哪"与"入口是 cmd/main.mbt"匹配不上 —— 中文检索等于失效。
 *   切成 2 字窗口后，"入口"这一对就能对上（单字噪音太大，所以用 2 不用 1）。
 */
function tokens(text) {
  const out = []
  const raw = String(text == null ? '' : text).toLowerCase()
  for (const seg of raw.split(/[^0-9a-z\u4e00-\u9fa5_]+/)) {
    if (!seg) continue
    if (/^[0-9a-z_]+$/.test(seg)) {
      if (seg.length >= 2 && !STOP.has(seg)) out.push(seg)
      continue
    }
    for (let i = 0; i + 2 <= seg.length; i++) {
      const g = seg.slice(i, i + 2)
      if (!STOP.has(g)) out.push(g)
    }
  }
  return out
}

/**
 * PH3-MEM-09：按当前任务检索最相关的记忆。
 *
 * PH3-MEM-10 是这里的关键：**不相关就不注入**。
 *   → 用**命中数**做门槛（至少要命中 1 个有意义的词），而不是"按分数排序取前 N"。
 *   否则不管问什么都会塞几条进来，Agent 的上下文里就全是噪音。
 */
function retrieve(memories, task, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {}
  const limit = Number.isFinite(o.limit) ? o.limit : 5
  const minHits = Number.isFinite(o.minHits) ? o.minHits : 1
  const project = o.project == null ? null : workspaceIdOf(o.project)
  const tt = tokens(task)
  if (!tt.length) return { items: [], reason: '任务文本里没有可检索的词' }

  const scored = []
  for (const m of Array.isArray(memories) ? memories : []) {
    if (!m || m.archived) continue
    // PH3-MEM-13：跨项目隔离 —— 只检索**本工作空间**的记忆
    if (project && m.project && m.project !== project) continue
    const mt = new Set(tokens(m.content))
    let hits = 0
    for (const t of tt) if (mt.has(t)) hits++
    if (hits >= minHits) scored.push({ memory: m, hits, verified: m.verified === true })
  }
  scored.sort((a, b) => (b.hits - a.hits) || ((b.verified ? 1 : 0) - (a.verified ? 1 : 0)))
  const picked = scored.slice(0, limit)
  return {
    items: picked.map((s) => s.memory),
    // ★ 如实说明"为什么是这几条"与"为什么没给更多"
    reason: picked.length
      ? ('命中 ' + picked.length + ' 条（按命中词数排序' + (scored.length > picked.length ? '，已截到 ' + limit + ' 条' : '') + '）')
      : '没有相关记忆 —— **不注入**（而不是硬塞几条）',
    total: scored.length,
  }
}

/** PH3-MEM-13：这条记忆属于哪个工作空间（用身份判断，不用字符串前缀）。 */
function belongsTo(memory, project) {
  if (!memory || !memory.project) return false
  const want = workspaceIdOf(project)
  return !!want && memory.project === want
}

/**
 * PH3-MEM-11：合并两条重复记忆 → 生成一条新的，**原两条先归档**。
 * ⚠️ 是"归档"不是"删除"：合并判错了还能找回来（PH3-MEM-12 也要求删除必须明确）。
 */
function mergeMemories(a, b, opts, now) {
  if (!a || !b) return { ok: false, error: '需要两条记忆' }
  const o = (opts && typeof opts === 'object') ? opts : {}
  if (a.type !== b.type) return { ok: false, error: '不同类型不合并（' + a.type + ' vs ' + b.type + '）' }
  if (a.project !== b.project) return { ok: false, error: '不同工作空间的记忆不合并' }
  const at = Number.isFinite(now) ? now : Date.now()
  const content = clip(o.content || (a.content + '　｜　' + b.content), LIMITS.maxContentChars)
  const merged = Object.freeze(Object.assign({}, a, {
    id: o.id || ('mem_merged_' + String(at)),
    content,
    // ★ 合并条的 verified：**两边都验过才算验过**（一条验过一条没验 → 不算）
    verified: a.verified === true && b.verified === true,
    createdAt: at,
    updatedAt: at,
    mergedFrom: [a.id, b.id],
  }))
  const archived = [a, b].map((m) => Object.freeze(Object.assign({}, m, {
    archived: true, archivedAt: at, archivedReason: '已合并到 ' + merged.id,
  })))
  return { ok: true, merged, archived, note: '原两条**归档**（不删除）—— 合并判错了还能找回来' }
}

/** PH3-MEM-12：删除必须明确（记下谁删的、为什么）。 */
function deleteMemory(memory, opts, now) {
  if (!memory) return { ok: false, error: '没有要删除的记忆' }
  const o = (opts && typeof opts === 'object') ? opts : {}
  if (o.confirmed !== true) {
    return { ok: false, error: '删除必须明确确认（PH3-MEM-12）：传 confirmed: true' }
  }
  const at = Number.isFinite(now) ? now : Date.now()
  return {
    ok: true,
    tombstone: Object.freeze({
      id: memory.id, project: memory.project, type: memory.type,
      deletedAt: at, deletedBy: o.by == null ? 'user' : String(o.by),
      reason: o.reason == null ? null : clip(o.reason, 200),
      contentPreview: clip(memory.content, 80),
    }),
  }
}

module.exports = {
  MEMORY_TYPE, ALL_TYPES, MEMORY_SOURCE, LIMITS,
  createMemory, canStore,
  proposeMemory, acceptProposal, discardProposal,
  tokens, retrieve, belongsTo, mergeMemories, deleteMemory,
}
