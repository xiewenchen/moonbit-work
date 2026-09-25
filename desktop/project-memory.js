'use strict'

/**
 * 项目级记忆（Phase 2.1 / P11）—— 清单原话：
 *   > 不要做大型 MemoryOS。只做：**项目知识**
 *
 * 所以这里只有四样东西，都在**项目内**的 `.moonbit-work/`：
 *
 *   project.md      项目是什么（自动生成，人也可以改）
 *   agent-rules.md  Agent 必须遵守的规则 —— **不可无确认修改**（P11-05）
 *   context.json    机器可读的上下文（自动生成）
 *   history/        已验证的错误经验（error / solution / verified）
 *
 * 为什么放在**项目里**（而不是像 P10 的会话那样放用户目录）：
 *   这是**项目的知识** —— 它应该能随项目一起提交、被团队共享；
 *   而会话是"我这台机器上的对话记录"。两者性质不同，所以位置不同。
 *   （代价：写进项目就可能被提交，所以 `agent-rules.md` 有写保护，见 P11-05。）
 *
 * 纯逻辑、零依赖，可直接进 CI。
 */

const MEMORY_DIR = '.moonbit-work'
const MEMORY_FILES = Object.freeze({
  PROJECT: 'project.md',
  RULES: 'agent-rules.md',
  CONTEXT: 'context.json',
  HISTORY_DIR: 'history',
})

const EXPERIENCE_LIMITS = Object.freeze({
  maxSolutionChars: 2000,
  maxErrorChars: 500,
  maxTags: 12,
  defaultCompressThreshold: 5,     // 同类超过这么多条就压缩
})

/** P11-01：布局（路径都相对项目根）*/
function memoryLayout() {
  return Object.freeze({
    dir: MEMORY_DIR,
    project: MEMORY_DIR + '/' + MEMORY_FILES.PROJECT,
    rules: MEMORY_DIR + '/' + MEMORY_FILES.RULES,
    context: MEMORY_DIR + '/' + MEMORY_FILES.CONTEXT,
    historyDir: MEMORY_DIR + '/' + MEMORY_FILES.HISTORY_DIR,
  })
}

function clip(s, max) {
  const t = String(s == null ? '' : s)
  return t.length <= max ? t : t.slice(0, max) + '…'
}

// ── P11-02 project.md（自动生成）──────────────────────────────────────────────
/**
 * 注意它刻意**短且可读**，并且顶部写明"这是自动生成的" ——
 * 否则人改了之后下次生成会被覆盖，还会被当成"我写的东西丢了"。
 */
function renderProjectMd(ctx, extra = {}) {
  const c = ctx || {}
  const lines = [
    '# 项目说明（由 MoonBit Work 自动生成）',
    '',
    '> 本文件由工具生成，**可以手工补充**；再次生成时会保留 `## 手工补充` 一节。',
    '',
    '## 基本信息',
    '- 根目录：`' + (c.rootDir || '（未打开）') + '`',
    '- 类型：`' + (c.projectType || 'unknown') + '`',
  ]
  if (c.label) lines.push('- 名称：' + c.label)
  if (c.language) lines.push('- 语言：' + c.language)
  if (c.packageManager) lines.push('- 包管理：' + c.packageManager)
  const cmds = []
  if (c.buildCommand) cmds.push('- 构建：`' + c.buildCommand + '`')
  if (c.runCommand) cmds.push('- 运行：`' + c.runCommand + '`')
  if (c.testCommand) cmds.push('- 测试：`' + c.testCommand + '`')
  if (cmds.length) { lines.push('', '## 常用命令'); lines.push.apply(lines, cmds) }
  if (extra.features && Object.keys(extra.features).length) {
    lines.push('', '## 能力')
    for (const k of Object.keys(extra.features)) lines.push('- ' + k + '：' + extra.features[k])
  }
  lines.push('', '## 手工补充', extra.handWritten || '（这里可以写项目背景、约定、注意事项 —— 重新生成时会被保留）')
  lines.push('')
  return lines.join('\n')
}

/** 把已有 project.md 里的「手工补充」抠出来，供重新生成时保留 */
function extractHandWritten(md) {
  const s = String(md == null ? '' : md)
  // ⚠️ 两处都只能用「顶层 `## `」：`### ` 不能被当成结尾，
  // 否则用户补充区里的三级标题会被截断，后面的内容在重新生成时**静默丢掉**。
  const m = /^## (?!\s)手工补充[ \t]*$/m.exec(s)
  if (!m) return ''
  const rest = s.slice(m.index + m[0].length).replace(/^\s*\n/, '')
  const end = rest.search(/^## (?!\s)/m)      // `### ` 不匹配（后面紧跟的是 `#`）
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

// ── P11-03 context.json（自动生成）───────────────────────────────────────────
function buildContextJson(ctx, extra = {}) {
  const c = ctx || {}
  return {
    schema: 'moonbit-work/project-context@1',
    generatedAt: Number.isFinite(extra.now) ? extra.now : Date.now(),
    rootDir: c.rootDir || null,
    projectType: c.projectType || null,
    label: c.label || null,
    language: c.language || null,
    commands: {
      build: c.buildCommand || null,
      run: c.runCommand || null,
      test: c.testCommand || null,
    },
    files: Array.isArray(extra.files) ? extra.files.slice(0, 200) : [],
  }
}

// ── P11-04 规则解析 ──────────────────────────────────────────────────────────
/**
 * 规则文件用**极简**语法：一行一条，`- ` 开头；`#` 是分类；`!` 开头表示"硬约束"。
 * 不做复杂的 DSL —— 规则是给人看的，能读能改最重要。
 */
function parseRules(text) {
  const out = []
  const lines = String(text == null ? '' : text).split('\n')
  let section = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('## ')) { section = line.slice(3).trim(); continue }
    if (line.startsWith('# ')) { section = line.slice(2).trim(); continue }
    if (!line.startsWith('- ')) continue
    const body = line.slice(2).trim()
    if (!body) continue
    const hard = body.startsWith('!')
    out.push(Object.freeze({
      id: 'rule-' + (out.length + 1),
      text: hard ? body.slice(1).trim() : body,
      hard,                                  // 硬约束（`!` 开头）
      section,
    }))
  }
  return Object.freeze(out)
}

/** 规则文件的起始模板 */
function renderRulesTemplate() {
  return [
    '# Agent 规则',
    '',
    '> 一行一条，`- ` 开头；`!` 开头表示**硬约束**（Agent 不得违反）。',
    '> ⚠️ 本文件受保护：**未经确认不可修改**（P11-05）。',
    '',
    '## 通用',
    '- 只读优先：先看清楚再动手',
    '- 改文件必须经用户确认（Gate P8）',
    '- 不确定的事情如实说"不知道"，不要猜',
    '',
    '## 本项目',
    '<!-- 在这里写这个项目特有的约定（这行是注释，不会被当成规则） -->',
    '',
  ].join('\n')
}

// ── P11-05 规则写保护 ────────────────────────────────────────────────────────
/**
 * 规则是"约束 Agent 自己"的东西 —— 让 Agent 悄悄改它等于让它自己给自己松绑。
 * 所以写入**必须**带显式确认；没有确认就拒绝，并把原因说清楚。
 */
function canWriteRules(opts = {}) {
  if (opts.confirmed === true) return { ok: true }
  return {
    ok: false,
    error: 'agent-rules.md 受保护：修改规则必须由用户明确确认（P11-05）。'
      + '（规则约束的是 Agent 自己，不能由 Agent 无确认改写。）',
    needsConfirm: true,
  }
}

// ── P11-06 已验证的错误经验 ──────────────────────────────────────────────────
/**
 * 一条经验 = { error, solution, verified }。
 * **只有 verified 为真的才值得长期留着** —— 未被验证的"我猜是这样"不是经验。
 */
function createExperience(input = {}) {
  const errs = []
  const error = clip(input.error, EXPERIENCE_LIMITS.maxErrorChars).trim()
  const solution = clip(input.solution, EXPERIENCE_LIMITS.maxSolutionChars).trim()
  if (!error) errs.push('error 不能为空')
  if (!solution) errs.push('solution 不能为空')
  const tags = []
  for (const t of (Array.isArray(input.tags) ? input.tags : [])) {
    const s = String(t || '').trim()
    if (s && tags.indexOf(s) < 0 && tags.length < EXPERIENCE_LIMITS.maxTags) tags.push(s)
  }
  return Object.freeze({
    ok: errs.length === 0,
    errors: Object.freeze(errs),
    // ⚠️ id 不能只用 Date.now()：同一毫秒内批量添加会撞 id，
    // 之后按 id 删除会一次删掉多条。加一个自增序号避免。
    id: input.id || ('exp-' + (Number.isFinite(input.now) ? input.now : Date.now()).toString(36) + '-' + (++_expSeq)),
    error,
    solution,
    verified: input.verified === true,          // ★ 默认 false（不把"没验过的"当经验）
    files: Object.freeze((Array.isArray(input.files) ? input.files : []).map(String).slice(0, 20)),
    tags: Object.freeze(tags),
    hits: Number.isFinite(input.hits) ? input.hits : 0,
    at: Number.isFinite(input.at) ? input.at : (Number.isFinite(input.now) ? input.now : Date.now()),
  })
}

let _expSeq = 0

/** 归一化错误描述 → 指纹（用于去重与压缩）
 *
 * 边界（写清楚，免得以后误以为它能"智能归类"）：
 *   归一的是**数字**与**字面量**；标识符（foo/bar）**不归一** ——
 *   因为把标识符也抹平会导致"类型不匹配"与"变量名打错"被合到一起。
 *   所以压缩是"按相同句式"合并，宁可少合并也不误合并。
 */
function experienceFingerprint(exp) {
  const s = String((exp && exp.error) || '')
    .toLowerCase()
    .replace(/[0-9]+/g, '#')            // 行号/数字不算区别
    .replace(/['"`][^'"`]*['"`]/g, 'S') // 字面量不算区别
    .replace(/[^a-z0-9\u4e00-\u9fa5#]+/g, ' ')
    .trim()
  // 取前 60 字符做指纹：足够区分不同错误，又不会因为尾巴不同就被当成两类
  return s.slice(0, 60)
}

// ── P11-07 检索（只取与当前任务相关的）──────────────────────────────────────
function tokenize(text) {
  const s = String(text == null ? '' : text).toLowerCase()
  const en = s.match(/[a-z_][a-z0-9_]{2,}/g) || []
  const runs = s.match(/[\u4e00-\u9fa5]{2,}/g) || []
  const zh = []
  for (const r of runs) for (let i = 0; i + 2 <= r.length; i++) zh.push(r.slice(i, i + 2))
  return new Set(en.concat(zh))
}

/**
 * 按相关度排序取经验。**只返回真的相关的那几条**（不是"把库倒出来"）。
 *
 * 打分：关键词命中数 ×1；命中 file 名 ×3；verified ×2；同类被复用过 hits 加权。
 */
function searchExperiences(list, query = {}, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 3
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 2
  const q = tokenize([query.text, query.file, query.error].filter(Boolean).join(' '))
  const file = query.file ? String(query.file) : ''
  const scored = []
  for (const e of (Array.isArray(list) ? list : [])) {
    if (!e) continue
    let score = 0
    const toks = tokenize(e.error + ' ' + e.solution + ' ' + (e.tags || []).join(' '))
    for (const t of q) if (toks.has(t)) score += 1
    // ★ 没有任何关键词交集就直接不看。
    //   否则 `verified` 的加权（+2）自己就能过阈值 —— 那就变成"不管问什么，
    //   已验证的经验都会被倒出来"，正是 P11-07 要避免的（第一版就是这个毛病）。
    if (score === 0) continue
    if (file && (e.files || []).some((f) => String(f) === file || String(f).endsWith(file))) score += 3
    if (e.verified) score += 2
    if (e.hits > 0) score += Math.min(2, e.hits)
    if (score >= minScore) scored.push({ exp: e, score })
  }
  scored.sort((a, b) => b.score - a.score || (b.exp.at - a.exp.at))
  return Object.freeze(scored.slice(0, limit).map((x) => x.exp))
}

// ── P11-08 压缩（同类 100 条 → 1 条总结）─────────────────────────────────────
/**
 * 按指纹分组，同组超过阈值就合成一条：
 *   · 保留**最近**那条的 solution（最新的通常最准）
 *   · 累计 hits（说明这个问题反复出现）
 *   · 若组里有 verified 的，合成条也为 verified
 */
function compressExperiences(list, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : EXPERIENCE_LIMITS.defaultCompressThreshold
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const groups = new Map()
  for (const e of (Array.isArray(list) ? list : [])) {
    if (!e) continue
    const k = experienceFingerprint(e)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(e)
  }
  const kept = []
  const removed = []
  for (const [, arr] of groups) {
    if (arr.length <= threshold) { kept.push.apply(kept, arr); continue }
    arr.sort((a, b) => (b.at || 0) - (a.at || 0))
    const latest = arr[0]
    const merged = Object.freeze(Object.assign({}, latest, {
      id: latest.id,
      hits: arr.reduce((n, x) => n + (x.hits || 0) + 1, 0),
      verified: arr.some((x) => x.verified),
      at: now,
      compressed: true,
      compressedFrom: arr.length,
      error: latest.error,                   // 保留最近那条的错误描述
    }))
    kept.push(merged)
    removed.push.apply(removed, arr)
  }
  return Object.freeze({
    experiences: Object.freeze(kept),
    removedCount: removed.length,
    removedIds: Object.freeze(removed.map((x) => x.id)),
    // ★ review 指出：只给 id 的话，被合并掉的 error/solution **就找不回来了**。
    //   所以把原条目本体也带回去，让调用方（store 层）能归档。
    removed: Object.freeze(removed.slice()),
  })
}

// ── P11-09 删除 ─────────────────────────────────────────────────────────────
function deleteExperience(list, id) {
  const target = String(id || '')
  const arr = Array.isArray(list) ? list : []
  const next = arr.filter((e) => e && e.id !== target)
  return Object.freeze({
    ok: next.length !== arr.length,
    error: next.length === arr.length ? '没有找到这条经验：' + target : null,
    experiences: Object.freeze(next),
  })
}

/** 一行摘要（日志/界面用）*/
function describeMemory(files, rules, experiences) {
  const n = (a) => (Array.isArray(a) ? a.length : 0)
  return '项目知识：文件 ' + n(files) + ' ｜ 规则 ' + n(rules)
    + '（硬约束 ' + (rules || []).filter((r) => r.hard).length + '）'
    + ' ｜ 经验 ' + n(experiences)
    + '（已验证 ' + (experiences || []).filter((e) => e.verified).length + '）'
}

module.exports = {
  MEMORY_DIR,
  MEMORY_FILES,
  EXPERIENCE_LIMITS,
  memoryLayout,
  renderProjectMd,
  extractHandWritten,
  buildContextJson,
  parseRules,
  renderRulesTemplate,
  canWriteRules,
  createExperience,
  experienceFingerprint,
  searchExperiences,
  compressExperiences,
  deleteExperience,
  describeMemory,
}
