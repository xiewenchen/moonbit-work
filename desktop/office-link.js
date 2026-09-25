'use strict'

/**
 * 办公文件 ↔ 项目的联动（Phase 2.1 / P13-04 ～ P13-07）
 *
 * 四件事，但都**不重复造已有的东西**：
 *
 *   P13-04 File Relay → Project   把中转站里的文件**显式关联**到某个项目（关联是记下来的，
 *                                 不是靠路径猜）
 *   P13-05 Office Preview         复用 `relay-main.js` 已有的 Office 元信息解析（docProps/core.xml）
 *                                 —— 这里只负责把它整理成"预览该显示什么"
 *   P13-06 Office → Agent         把文件（正文摘要 + 元信息）做成 Agent 能吃的输入片段
 *   P13-07 Agent Summary → Note   把 Agent 的结论写进**项目便签**（走 P13-03 的 setNote）
 *
 * 设计原则与 P13 一致：**只读外部信息，自己的关联表单独存**；
 * 且这里的输出都是"给人/给 Agent 看的文本"，不反过来改 IDE 状态。
 *
 * 纯逻辑、零依赖，可直接进 CI。
 */

const LINK_LIMITS = Object.freeze({
  maxLinks: 500,
  maxSnippetChars: 4000,
  maxSummaryChars: 20000,
})

function nowDefault() { return Date.now() }

function trim(v) {
  const s = String(v == null ? '' : v).trim()
  return s || null
}

/** 归一一个"文件→项目"的关联记录 */
function normalizeLink(input = {}) {
  const file = trim(input.file)
  const root = trim(input.projectRoot)
  if (!file || !root) return { ok: false, error: 'file 与 projectRoot 都不能为空' }
  return {
    ok: true,
    link: {
      file,
      projectRoot: root,
      name: trim(input.name) || file.split(/[\\/]/).pop(),
      kind: trim(input.kind),                     // docx / xlsx / txt …
      at: Number.isFinite(input.at) ? input.at : nowDefault(),
    },
  }
}

/** 关联表：只存"文件归属哪个项目"，不存文件内容 */
function createLinkStore(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const links = Array.isArray(s.links) ? s.links.filter((l) => l && trim(l.file) && trim(l.projectRoot)) : []
  return { version: 1, links: links.slice(0, LINK_LIMITS.maxLinks) }
}

/** P13-04：把文件关联到项目（同文件重复关联 = 更新，不追加） */
function linkFile(store, input = {}, opts = {}) {
  const n = normalizeLink(Object.assign({}, input, { at: opts.now }))
  if (n.ok !== true) return { ok: false, error: n.error, store: createLinkStore(store) }
  const s = createLinkStore(store)
  const rest = s.links.filter((l) => l.file !== n.link.file)
  return { ok: true, link: n.link, store: { version: 1, links: [n.link].concat(rest).slice(0, LINK_LIMITS.maxLinks) } }
}

function unlinkFile(store, file) {
  const s = createLinkStore(store)
  const f = trim(file)
  if (!f) return { ok: false, error: '缺少 file', store: s }
  const links = s.links.filter((l) => l.file !== f)
  return { ok: links.length !== s.links.length, error: links.length === s.links.length ? '没有这条关联' : null, store: { version: 1, links } }
}

/** 列出关联到某个项目的文件（**只返回本项目的** —— 与 P13 的隔离原则一致）*/
function linksFor(store, projectRoot) {
  const s = createLinkStore(store)
  const r = trim(projectRoot)
  if (!r) return []
  return s.links.filter((l) => l.projectRoot === r).map((l) => Object.assign({}, l))
}

/** 反过来：这个文件属于哪个项目 */
function projectOf(store, file) {
  const s = createLinkStore(store)
  const f = trim(file)
  if (!f) return null
  const hit = s.links.find((l) => l.file === f)
  return hit ? hit.projectRoot : null
}

// ── P13-05 Office 预览 ───────────────────────────────────────────────────────
/**
 * 把 `relay-main.js` 解析出来的 Office 元信息，整理成"预览面板该显示什么"。
 *
 * **不在这里重新解析 docx/xlsx** —— 那件事 relay-main 已经做过、也已经有测试覆盖了。
 * 这里只做展示层的整理，并明确区分"有元信息"与"没解析出来"。
 */
function buildOfficePreview(meta, opts = {}) {
  const m = meta && typeof meta === 'object' ? meta : {}
  const rows = []
  if (trim(m.title)) rows.push(['标题', String(m.title)])
  if (trim(m.creator)) rows.push(['作者', String(m.creator)])
  if (trim(m.modifiedBy)) rows.push(['最后修改', String(m.modifiedBy)])
  if (trim(m.created)) rows.push(['创建时间', String(m.created)])
  if (trim(m.modified)) rows.push(['修改时间', String(m.modified)])
  if (trim(m.pages)) rows.push(['页数', String(m.pages)])
  if (trim(m.words)) rows.push(['字数', String(m.words)])
  if (trim(m.sheets)) rows.push(['工作表', String(m.sheets)])
  if (trim(m.slides)) rows.push(['幻灯片', String(m.slides)])
  return {
    hasMeta: rows.length > 0,
    kind: trim(opts.kind) || null,
    file: trim(opts.file) || null,
    rows,
    // 说明白"能预览到什么程度" —— 我们只读元信息，不做排版还原
    note: rows.length > 0
      ? '以上来自 Office 文件内置的文档属性（docProps/core.xml）——不是排版还原，但足够确认"这是哪份文档"。'
      : '这份文件没有可读的内置属性（或不是 Office 文档）。',
  }
}

// ── P13-06 Office → Agent ───────────────────────────────────────────────────
/**
 * 把一份文件做成 Agent 的输入片段。
 *
 * 刻意**带上来源说明**（哪个文件、哪来的、时间），因为 Agent 收到的每样东西都该能指着说
 * 出处 —— 这也是 [[P5A]] 那条"可核对"的原则。
 */
function toAgentSnippet(input = {}, opts = {}) {
  const file = trim(input.file) || '（未知文件）'
  const kind = trim(input.kind)
  const text = String(input.text == null ? '' : input.text)
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : null
  const projectRoot = trim(input.projectRoot)

  const head = []
  head.push('【来自中转站的办公文件】')
  head.push('- 文件：' + file)
  if (kind) head.push('- 类型：' + kind)
  if (projectRoot) head.push('- 已关联项目：' + projectRoot)
  if (meta) {
    const preview = buildOfficePreview(meta, { file, kind })
    for (const [k, v] of preview.rows) head.push('- ' + k + '：' + v)
  }

  const body = text ? text.slice(0, LINK_LIMITS.maxSnippetChars) : ''
  const truncated = text.length > LINK_LIMITS.maxSnippetChars
  return {
    ok: true,
    snippet: head.join('\n') + '\n\n' + (body || '（没有正文文本；只能依据上面的元信息判断）')
      + (truncated ? '\n\n（正文已截断，只取了前 ' + LINK_LIMITS.maxSnippetChars + ' 字）' : ''),
    hasBody: body.length > 0,
    truncated,
    source: { file, kind, projectRoot, at: Number.isFinite(opts.now) ? opts.now : nowDefault() },
  }
}

// ── P13-07 Agent Summary → Note ─────────────────────────────────────────────
/**
 * 把 Agent 的结论**追加**到项目便签（不是覆盖 —— 便签是用户的，不能因为 Agent 写一次就没了）。
 * 返回新的便签文本，交给 P13-03 的 `setNote` 落盘。
 */
function appendSummaryToNote(currentNote, summary, opts = {}) {
  const body = String(summary == null ? '' : summary).trim()
  if (!body) return { ok: false, error: '总结内容为空' }
  const head = trim(opts.title) || 'Agent 小结'
  const at = Number.isFinite(opts.now) ? new Date(opts.now) : new Date()
  const stamp = at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0')
    + ' ' + String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
  const block = '── ' + head + '（' + stamp + '）──\n' + body
  const cur = String(currentNote == null ? '' : currentNote)
  const next = (cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' : '') + block
  return {
    ok: true,
    note: next.slice(-LINK_LIMITS.maxSummaryChars),   // 太长就保留最近的（便签也不该无限长）
    appended: true,
  }
}

/** 一行摘要 */
function describeOfficeLink(store, projectRoot) {
  const list = linksFor(store, projectRoot)
  return '办公文件联动：本项目关联 ' + list.length + ' 个文件'
    + (list.length ? '（' + list.slice(0, 3).map((l) => l.name).join('、') + (list.length > 3 ? '…' : '') + '）' : '')
}

module.exports = {
  LINK_LIMITS,
  normalizeLink,
  createLinkStore,
  linkFile,
  unlinkFile,
  linksFor,
  projectOf,
  buildOfficePreview,
  toAgentSnippet,
  appendSummaryToNote,
  describeOfficeLink,
}
