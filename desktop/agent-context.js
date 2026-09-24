'use strict'

/**
 * AgentContext（Phase 2 / MBW-P5-01 ～ P5-09）
 *
 * 目的：把 Agent 干活需要的**工程事实**组装成一份上下文 —— 而不是把整个项目塞给模型。
 *
 * 本文件是**纯逻辑**：数据全部由调用方注入（project / activeFile / problems / …），
 * 不 require electron、不碰 DOM —— 所以能纯 Node 单测，也就能进 Linux CI。
 *
 * 两个硬约束（清单 P5-08 / P5-09）：
 *   P5-08 有**字符预算**，超了就裁；项目只给**骨架**（路径清单），绝不给全部文件内容。
 *   P5-09 按优先级 `任务 > 问题 > 文件 > 选区 > 项目结构 > 历史` 累加，**先丢低优先级**；
 *         被丢掉的部分要**如实说明**（否则模型会以为自己看到了全部）。
 *
 * 本批只建组装器；从 renderer / 主进程真实取数属下一批。
 */

/** P5-08 各类上限（都可在调用时覆盖）*/
const AGENT_CONTEXT_LIMITS = Object.freeze({
  maxChars: 24000,        // 整份上下文的总预算（约 6k tokens 量级）
  maxFileChars: 8000,     // 单个文件最多带这么多内容
  maxSelectionChars: 2000,
  maxProblemChars: 3000,  // 问题清单最多这么多
  maxProjectFiles: 40,    // 项目结构只列这么多条路径
  maxRecentFiles: 5,
  maxHistoryChars: 1000,
})

/**
 * P5-09 优先级（数组顺序 = 从高到低）。
 * 关键：`problems` 高于 `activeFile` —— 排查问题时，"当前错误"比"整个文件"更值钱。
 */
const CONTEXT_PRIORITY = Object.freeze([
  'task',
  'problems',
  'activeFile',
  'selection',
  'project',
  'history',
])

function clip(text, max) {
  const s = String(text == null ? '' : text)
  if (s.length <= max) return { text: s, clipped: false, dropped: 0 }
  return { text: s.slice(0, max), clipped: true, dropped: s.length - max }
}

function line(label, value) {
  return value == null || value === '' ? null : label + '：' + value
}

/** P5-01 组装一份上下文（字段一律归一；缺的就是 null / []，不编造）*/
function createAgentContext(input = {}) {
  const recent = Array.isArray(input.recentFiles) ? input.recentFiles : []
  return Object.freeze({
    task: input.task == null || input.task === '' ? null : String(input.task),
    project: input.project || null,                       // ProjectContext（含 rootDir / projectType / label …）
    activeFile: input.activeFile || null,                 // { path, content, language }
    selection: input.selection || null,                   // { text, startLine, endLine }
    problems: Array.isArray(input.problems) ? input.problems.slice() : [],
    lastRun: input.lastRun || null,                       // RunResult
    lastTest: input.lastTest || null,                     // { ok, name, output }
    recentFiles: recent.slice(0, AGENT_CONTEXT_LIMITS.maxRecentFiles),
    history: Array.isArray(input.history) ? input.history.slice() : [],
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
  })
}

/** 渲染单个片段（返回 null 表示这类没有内容）*/
function renderPiece(key, ctx, limits) {
  switch (key) {
    case 'task':
      return ctx.task ? '## 当前任务\n' + ctx.task : null

    case 'problems': {
      if (!ctx.problems.length) return null
      const lines = ctx.problems.map((p) => {
        const where = p.file ? p.file + ':' + p.line + (p.column ? ':' + p.column : '') : '（无位置）'
        return '- [' + p.severity + '] ' + where + ' ' + p.message + (p.source ? '  <' + p.source + '>' : '')
      }).join('\n')
      return '## 当前问题（' + ctx.problems.length + '）\n' + clip(lines, limits.maxProblemChars).text
    }

    case 'activeFile': {
      if (!ctx.activeFile || !ctx.activeFile.path) return null
      const head = '## 当前文件（' + ctx.activeFile.path + (ctx.activeFile.language ? ' · ' + ctx.activeFile.language : '') + '）'
      const body = clip(ctx.activeFile.content == null ? '' : ctx.activeFile.content, limits.maxFileChars)
      const note = body.clipped ? '\n…（文件过长，已截断，省略 ' + body.dropped + ' 字）' : ''
      return head + '\n```\n' + body.text + '\n```' + note
    }

    case 'selection': {
      if (!ctx.selection || !ctx.selection.text) return null
      const s = clip(ctx.selection.text, limits.maxSelectionChars)
      const range = (ctx.selection.startLine != null && ctx.selection.endLine != null)
        ? '（第 ' + ctx.selection.startLine + '–' + ctx.selection.endLine + ' 行）' : ''
      return '## 当前选区' + range + '\n```\n' + s.text + '\n```'
    }

    case 'project': {
      const p = ctx.project
      if (!p || !p.rootDir) return null
      const files = Array.isArray(p.files) ? p.files.slice(0, limits.maxProjectFiles) : []
      const head = '## 项目结构（' + (p.label || p.projectType || '项目') + ' @ ' + p.rootDir + '）'
      // **只列路径，不给内容** —— 这是 P5-08「禁止把整个项目塞给模型」的落点
      const body = files.length ? files.map((f) => '- ' + f).join('\n') : '（未提供文件清单）'
      const more = Array.isArray(p.files) && p.files.length > limits.maxProjectFiles
        ? '\n…（共 ' + p.files.length + ' 个文件，只列了前 ' + limits.maxProjectFiles + ' 个）' : ''
      return head + '\n' + body + more
    }

    case 'history': {
      const h = ctx.history
      if (!h.length) return null
      const text = h.map((x) => '- ' + (typeof x === 'string' ? x : (x && x.summary) || '')).join('\n')
      return '## 必要历史\n' + clip(text, limits.maxHistoryChars).text
    }

    default:
      return null
  }
}

/**
 * 按优先级组装成给模型的文本（P5-08 预算 + P5-09 优先级）。
 * @returns {{text: string, used: number, maxChars: number, included: string[], omitted: string[], clipped: boolean}}
 */
function renderAgentContext(ctx, opts = {}) {
  const limits = Object.assign({}, AGENT_CONTEXT_LIMITS, opts.limits || {})
  const maxChars = opts.maxChars || limits.maxChars
  const pieces = []
  for (const key of CONTEXT_PRIORITY) {
    const text = renderPiece(key, ctx, limits)
    if (text) pieces.push({ key, text })
  }

  const included = []
  const omitted = []
  let used = 0
  let clippedAny = false
  const chunks = []

  for (const p of pieces) {
    if (used + p.text.length > maxChars) {
      // 预算不够：先试着按剩余空间截断**这一块**（只对可截断的块有意义），否则整块丢掉
      const remain = maxChars - used
      if (remain > 400) {
        const c = clip(p.text, remain)
        chunks.push(c.text + '\n…（因预算不足截断）')
        included.push(p.key + '(截断)')
        used += c.text.length
        clippedAny = true
      } else {
        omitted.push(p.key)
        clippedAny = true
      }
      continue
    }
    chunks.push(p.text)
    included.push(p.key)
    used += p.text.length
  }

  let text = chunks.join('\n\n')
  if (omitted.length) {
    // **如实说明**：模型必须知道自己少看了什么
    text += '\n\n> 注：因上下文预算（' + maxChars + ' 字）不足，以下部分**未提供**：' + omitted.join('、') +
      '。如果需要，请明确要求我读取某一项。'
  }

  return { text, used, maxChars, included, omitted, clipped: clippedAny }
}

/**
 * P5-02 ～ P5-07：从注入的"数据源"取数并组装。
 * sources 里每一项都是**函数或值**；给函数的会 await（允许异步取，如读文件）。
 */
async function buildAgentContext(sources = {}, opts = {}) {
  const pick = async (name) => {
    const v = sources[name]
    return typeof v === 'function' ? await v() : v
  }
  const [task, project, activeFile, selection, problems, lastRun, lastTest, recentFiles, history] = await Promise.all([
    pick('task'), pick('project'), pick('activeFile'), pick('selection'),
    pick('problems'), pick('lastRun'), pick('lastTest'), pick('recentFiles'), pick('history'),
  ])
  const ctx = createAgentContext({
    task, project, activeFile, selection,
    problems: Array.isArray(problems) ? problems : [],
    lastRun, lastTest,
    recentFiles: Array.isArray(recentFiles) ? recentFiles : [],
    history: Array.isArray(history) ? history : [],
    createdAt: opts.createdAt,
  })
  return opts.render === false ? ctx : Object.assign({ ctx }, renderAgentContext(ctx, opts))
}

module.exports = {
  AGENT_CONTEXT_LIMITS,
  CONTEXT_PRIORITY,
  createAgentContext,
  renderAgentContext,
  buildAgentContext,
  renderPiece,
}
