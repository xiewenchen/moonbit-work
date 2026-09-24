'use strict'

/**
 * TaskUnderstanding —— 可验证的"任务理解结果"（Phase 2.1 / P9A-01）
 *
 * 清单里有句关键约束：
 *   > 这里的 Understand **不做「展示模型思维链」**。它应该是：**可验证的任务理解结果**。
 *
 * 所以本模块刻意做成**确定性推导**：每一栏都来自能指着说的来源，而不是模型的自我叙述。
 *
 *   goal              用户这句话本身
 *   project           真实 ProjectContext（哪个项目、什么类型）
 *   relevantFiles     任务文本里提到的路径 + 当前文件 + 问题涉及的文件（各标来源）
 *   relevantProblems  统一问题模型里匹配得上的（带 id，可点开）
 *   proposedActions   按**规则**推出的动作序列（每条标 rule），不是模型编的计划
 *   constraints       来自门禁（当前能不能改文件、要不要确认）
 *
 * 将来的真实 LLM 可以**覆盖** proposedActions（见 `applyLlmPlan`），
 * 但 goal / project / relevantFiles / relevantProblems 这几栏永远由事实决定 —— 这样"理解错了"
 * 是能被看出来的，而不是一段无法核对的话。
 *
 * 纯逻辑、零依赖（文件存在性用注入的 `exists` 判断），可直接进 CI。
 */

/** 从一句话里认出"像文件路径"的 token，例如 conduit/users.mbt、src/app.ts */
const PATH_LIKE = /[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+|[A-Za-z0-9_\-]+\.(?:mbt|moon|ts|js|json|sql|yml|yaml|md|py|go|rs|java)/g

function uniq(arr) {
  const seen = new Set()
  const out = []
  for (const x of arr) {
    const s = String(x == null ? '' : x).trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/** 从任务描述里抽"可能是文件路径"的词（去重、按出现顺序）*/
function extractPathLike(text) {
  const m = String(text == null ? '' : text).match(PATH_LIKE)
  return uniq(m || [])
}

/**
 * P9A-01：构造 TaskUnderstanding。
 *
 * @param {object} req        AgentRequest（P5A）
 * @param {object} inputs     真实输入（P5A 的 collectAgentInputs 产物）
 * @param {object} [deps]
 * @param {(p: string) => boolean} [deps.exists]  判断路径是否真的存在（注入以便纯逻辑测试）
 * @param {{confirmBeforeApply?: boolean, autoStart?: boolean}} [deps.policy]
 */
function buildTaskUnderstanding(req = {}, inputs = {}, deps = {}) {
  const goal = typeof req.message === 'string' ? req.message.trim() : ''
  const exists = typeof deps.exists === 'function' ? deps.exists : () => true   // 不注入时不做存在性过滤
  const policy = deps.policy || {}

  // ── project：直接来自真实上下文 ────────────────────────────────
  const pc = inputs.project || null
  const project = (pc && pc.rootDir)
    ? { rootDir: pc.rootDir, projectType: pc.projectType || null, label: pc.label || null, source: 'projectContext' }
    : null

  // ── relevantFiles / relevantProblems：**两阶段**推 ──────
  // ① 先算"种子文件"：任务里提到的 + 当前文件；
  // ② 用种子去匹配问题；
  // ③ 再把"相关问题涉及的文件"并进来。
  //    ⚠️ 不能先把所有问题的文件都算成"相关" —— 那样每个问题文件都会命中自己，
  //    "相关"就失去意义（测试里 unrelated.mbt 就是这么错进来的）。
  const fromText = extractPathLike(goal).filter((p) => exists(p))
  const fromActive = inputs.activeFile && inputs.activeFile.path ? [inputs.activeFile.path] : []
  const problems = Array.isArray(inputs.problems) ? inputs.problems : []
  const seed = uniq([...fromText, ...fromActive])
  const seedSet = new Set(seed)
  const keywords = extractKeywords(goal)

  const relevant = problems.map((p, i) => ({ p, i })).filter(({ p }) => {
    if (!p) return false
    if (p.file && seedSet.has(p.file)) return true          // 文件对得上（种子里）
    return keywords.some((k) => String(p.message || '').toLowerCase().includes(k))
  }).map(({ p, i }) => ({
    id: p.id || ('problem-' + i),
    severity: p.severity || 'unknown',
    file: p.file || null,
    line: Number.isFinite(p.line) ? p.line : null,
    message: String(p.message || '').slice(0, 200),
    source: p.source || null,
  }))

  const fromProblems = relevant.map((p) => p.file).filter(Boolean)
  const files = uniq([...seed, ...fromProblems]).map((path) => ({
    path,
    why: fromActive.indexOf(path) >= 0 ? 'activeFile'
      : fromText.indexOf(path) >= 0 ? 'mentionedInTask'
        : 'hasProblem',
  }))

  // ── proposedActions：**规则**推出来的，每条带 rule 说明为什么 ──
  const hasError = relevant.some((p) => p.severity === 'error')
  const actions = []
  const target = files[0] ? files[0].path : null
  if (relevant.length) {
    actions.push({ action: 'readFile', target, rule: hasError ? '有 error 级问题 → 先读相关文件' : '有问题 → 先读相关文件' })
    if (target) {
      actions.push({ action: 'proposePatch', target, rule: '打算修改（须用户确认后才写入 —— Gate P8）' })
    } else {
      // 没定位到文件时不该推出"改某处"——否则会得到一个"改哪里都不知道"的补丁动作
      // （review 指出：relevant 非空但都没 file、且无当前文件时 target 是 null）
      actions.push({ action: 'locateFile', target: null, rule: '还没定位到文件 —— 先找到要改的地方' })
    }
    actions.push({ action: 'check', target: null, rule: '改完先静态检查' })
    actions.push({ action: 'test', target: null, rule: '再跑测试证明没改坏' })
  } else if (goal) {
    actions.push({ action: 'readFile', target, rule: '先读相关文件建立事实' })
    actions.push({ action: 'check', target: null, rule: '确认当前状态' })
  }

  // ── constraints：门禁决定，不是模型"自律" ─────────────────────
  const constraints = {
    needsConfirmBeforeApply: policy.confirmBeforeApply !== false,   // 默认就要确认（Gate P8）
    canModifyFiles: false,                                          // 是否放开写权限：当前为 false（P8 的 apply 才写）
    autoStart: policy.autoStart === true,
    notes: [
      'Agent 只能读；写必须经 proposePatch + 用户确认。',
      'workspace 之外的路径一律拒绝。',
    ],
  }

  return Object.freeze({
    goal,
    project,
    relevantFiles: Object.freeze(files),
    relevantProblems: Object.freeze(relevant),
    proposedActions: Object.freeze(actions),
    constraints: Object.freeze(constraints),
    // 快照视角：这份理解是基于哪次请求、什么时候
    requestId: req.requestId || null,
    createdAt: Date.now(),
  })
}

/** 从任务描述里抽关键词（中文按 2 字滑窗，英文按词），用于匹配问题描述 */
function extractKeywords(text) {
  const s = String(text == null ? '' : text).toLowerCase()
  const en = (s.match(/[a-z_][a-z0-9_]{2,}/g) || [])
  // 中文没有空格：连续汉字片段还要**按 2 字滑窗拆开**，否则「接口返回」整体成一个词，
  // 而问题描述里只写了「接口」或「返回」就匹配不上（review 指出）。
  const runs = (s.match(/[\u4e00-\u9fa5]{2,}/g) || [])
  const zh = []
  for (const run of runs) {
    for (let i = 0; i + 2 <= run.length; i++) zh.push(run.slice(i, i + 2))
  }
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'how', 'why', 'fix'])
  return uniq([...en, ...zh].filter((w) => !stop.has(w))).slice(0, 16)
}

/**
 * 用真实 LLM 产出的计划**覆盖** proposedActions（P9B 之后接上）。
 * 只允许覆盖 `proposedActions` —— 其余几栏是事实，不允许模型改。
 */
function applyLlmPlan(understanding, plan) {
  if (!understanding || !Array.isArray(plan)) return understanding
  const actions = plan.map((a) => ({
    action: String((a && a.action) || '').trim() || 'unknown',
    target: a && a.target ? String(a.target) : null,
    rule: 'llmPlan',
  })).filter((a) => a.action !== 'unknown')
  // 计划**全非法**时保留原计划 —— 把 proposedActions 清空会让 Agent 无事可做，
  // 而"模型这次没给出可用计划"不该等价于"不需要做事"。
  if (!actions.length) return understanding
  return Object.freeze(Object.assign({}, understanding, {
    proposedActions: Object.freeze(actions),
    planSource: 'llm',
  }))
}

/** 一行摘要（给界面/日志用）*/
function describeUnderstanding(u) {
  if (!u) return '（无理解结果）'
  const f = (u.relevantFiles || []).map((x) => x.path).slice(0, 3).join(',')
  const p = (u.relevantProblems || []).length
  return 'goal=' + JSON.stringify(u.goal)
    + ' ｜ 项目=' + (u.project ? (u.project.projectType || '?') : '无')
    + ' ｜ 相关文件=' + (f || '无')
    + ' ｜ 相关问题=' + p
    + ' ｜ 计划=' + (u.proposedActions || []).length + ' 步'
    + (u.constraints && u.constraints.needsConfirmBeforeApply ? ' ｜ 需确认' : '')
}

module.exports = {
  buildTaskUnderstanding,
  applyLlmPlan,
  describeUnderstanding,
  extractPathLike,
  extractKeywords,
}
