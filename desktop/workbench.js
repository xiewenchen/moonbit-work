'use strict'

/**
 * 工作台数据层（Phase 2.1 / P13-01、P13-02、P13-03、P13-08）
 *
 * 三样东西：
 *   · Recent Projects —— 最近打开过的项目
 *   · Project Todo    —— 项目待办
 *   · Project Note    —— 项目便签
 *
 * ## P13-08 是这一层的核心约束：「工作台不允许反向污染 IDE 状态」
 *
 * 落实成三条可检验的设计：
 *   ① **只读**：这里只接受"从外面读来的项目信息"（root / projectType / label），
 *      从不写回 IDE（没有 export 任何写 IDE 的函数）。
 *   ② **分开存**：工作台自己的数据（待办/便签/最近）放在同一个 store 里，
 *      与 IDE 的状态（打开的标签、当前文件、运行状态）**不是一回事**。
 *   ③ **按项目隔离**：待办与便签都挂在项目根下 —— 一个项目的待办不会出现在另一个项目里。
 *
 * 纯逻辑、零依赖，可直接进 CI。
 */

const WB_LIMITS = Object.freeze({
  maxRecent: 20,
  maxTodosPerProject: 200,
  maxTodoChars: 300,
  maxNoteChars: 20000,
  maxProjects: 100,
})

function nowDefault() { return Date.now() }

function trimRoot(v) {
  const s = String(v == null ? '' : v).trim()
  return s || null
}

/** 把一个可能损坏的 store 归一成安全形状（**不抛** —— 存储坏了不该让工作台打不开） */
function sanitizeStore(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const recent = Array.isArray(s.recent) ? s.recent : []
  const todos = s.todos && typeof s.todos === 'object' ? s.todos : {}
  const notes = s.notes && typeof s.notes === 'object' ? s.notes : {}
  return {
    version: 1,
    recent: recent.filter((r) => r && trimRoot(r.root)).map((r) => ({
      root: trimRoot(r.root),
      label: r.label ? String(r.label) : null,
      projectType: r.projectType ? String(r.projectType) : null,
      at: Number.isFinite(r.at) ? r.at : 0,
    })).slice(0, WB_LIMITS.maxRecent),
    todos: Object.fromEntries(Object.entries(todos)
      .filter(([k]) => trimRoot(k))
      .map(([k, v]) => [k, (Array.isArray(v) ? v : []).filter((t) => t && typeof t.text === 'string')])),
    notes: Object.fromEntries(Object.entries(notes)
      .filter(([k]) => trimRoot(k))
      .map(([k, v]) => [k, String(v == null ? '' : v).slice(0, WB_LIMITS.maxNoteChars)])),
  }
}

function emptyStore() { return { version: 1, recent: [], todos: {}, notes: {} } }

// ── P13-01 Recent Projects ───────────────────────────────────────────────────
/**
 * 记一次"打开过"。**同根去重**（再打开一次是把它提到最前，不是追加）。
 * 只接受从外面读来的信息，不反过来写 IDE。
 */
function touchRecent(store, project, opts = {}) {
  const s = sanitizeStore(store)
  const root = trimRoot(project && project.rootDir)
  if (!root) return s
  const rest = s.recent.filter((r) => r.root !== root)
  const entry = {
    root,
    label: (project && project.label) ? String(project.label) : null,
    projectType: (project && project.projectType) ? String(project.projectType) : null,
    at: Number.isFinite(opts.now) ? opts.now : nowDefault(),
  }
  return Object.assign({}, s, { recent: [entry].concat(rest).slice(0, WB_LIMITS.maxRecent) })
}

function listRecent(store, limit) {
  const s = sanitizeStore(store)
  const n = Number.isFinite(limit) ? Math.max(0, limit) : WB_LIMITS.maxRecent
  return s.recent.slice(0, n).map((r) => Object.assign({}, r))   // 返回副本，别让调用方改到 store
}

function forgetRecent(store, root) {
  const s = sanitizeStore(store)
  const r = trimRoot(root)
  if (!r) return s
  return Object.assign({}, s, { recent: s.recent.filter((x) => x.root !== r) })
}

// ── P13-02 Project Todo ──────────────────────────────────────────────────────
function todosFor(store, root, opts = {}) {
  const s = sanitizeStore(store)
  const r = trimRoot(root)
  if (!r) return []
  const list = s.todos[r] || []
  const out = opts.includeDone === false ? list.filter((t) => !t.done) : list
  return out.map((t) => Object.assign({}, t))
}

function addTodo(store, root, text, opts = {}) {
  const s = sanitizeStore(store)
  const r = trimRoot(root)
  const body = String(text == null ? '' : text).trim().slice(0, WB_LIMITS.maxTodoChars)
  if (!r || !body) return { ok: false, error: !r ? '缺少项目根' : '待办内容为空', store: s }
  const list = (s.todos[r] || []).slice()
  const item = { id: 't-' + ((Number.isFinite(opts.now) ? opts.now : nowDefault()).toString(36)) + '-' + (list.length + 1), text: body, done: false, at: Number.isFinite(opts.now) ? opts.now : nowDefault() }
  list.push(item)
  const capped = list.slice(-WB_LIMITS.maxTodosPerProject)
  return { ok: true, item, store: Object.assign({}, s, { todos: Object.assign({}, s.todos, { [r]: capped }) }) }
}

function toggleTodo(store, root, id, opts = {}) {
  const s = sanitizeStore(store)
  const r = trimRoot(root)
  if (!r) return { ok: false, error: '缺少项目根', store: s }
  const list = (s.todos[r] || []).map((t) => t.id === String(id) ? Object.assign({}, t, { done: opts.done === undefined ? !t.done : opts.done === true }) : t)
  const found = (s.todos[r] || []).some((t) => t.id === String(id))
  return { ok: found, error: found ? null : '没有这条待办', store: Object.assign({}, s, { todos: Object.assign({}, s.todos, { [r]: list }) }) }
}

function removeTodo(store, root, id) {
  const s = sanitizeStore(store)
  const r = trimRoot(root)
  if (!r) return { ok: false, error: '缺少项目根', store: s }
  const before = s.todos[r] || []
  const list = before.filter((t) => t.id !== String(id))
  return { ok: list.length !== before.length, error: list.length === before.length ? '没有这条待办' : null, store: Object.assign({}, s, { todos: Object.assign({}, s.todos, { [r]: list }) }) }
}

// ── P13-03 Project Note ──────────────────────────────────────────────────────
function noteFor(store, root) {
  const s = sanitizeStore(store)
  const r = trimRoot(root)
  return r ? (s.notes[r] || '') : ''
}

function setNote(store, root, text) {
  const s = sanitizeStore(store)
  const r = trimRoot(root)
  if (!r) return { ok: false, error: '缺少项目根', store: s }
  const body = String(text == null ? '' : text).slice(0, WB_LIMITS.maxNoteChars)
  return { ok: true, store: Object.assign({}, s, { notes: Object.assign({}, s.notes, { [r]: body }) }) }
}

// ── P13-08 自查 ──────────────────────────────────────────────────────────────
/**
 * 这一层"能碰什么、不能碰什么"的书面声明。
 * 测试会断言它：**不许**出现任何能改 IDE 状态的键（tabs / activeFile / runState…）。
 */
const WORKBENCH_SCOPE = Object.freeze({
  owns: Object.freeze(['recent', 'todos', 'notes']),
  reads: Object.freeze(['projectContext.rootDir', 'projectContext.projectType', 'projectContext.label']),
  neverWritesIDE: Object.freeze(['tabs', 'activeFile', 'runState', 'problems', 'session']),
})

/** 一行摘要 */
function describeWorkbench(store) {
  const s = sanitizeStore(store)
  const todoCount = Object.values(s.todos).reduce((n, l) => n + l.length, 0)
  const openCount = Object.values(s.todos).reduce((n, l) => n + l.filter((t) => !t.done).length, 0)
  const noteCount = Object.values(s.notes).filter((x) => x && x.length > 0).length
  return '工作台：最近 ' + s.recent.length + ' 个项目 ｜ 待办 ' + todoCount + '（未完成 ' + openCount + '）｜ 有便签的项目 ' + noteCount
}

module.exports = {
  WB_LIMITS,
  WORKBENCH_SCOPE,
  emptyStore,
  sanitizeStore,
  touchRecent,
  listRecent,
  forgetRecent,
  todosFor,
  addTodo,
  toggleTodo,
  removeTodo,
  noteFor,
  setNote,
  describeWorkbench,
}
