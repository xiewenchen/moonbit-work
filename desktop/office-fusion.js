// PH3-OFFICE：办公能力与工程能力融合（清单 §21）。
//
// 原有 office-link.js 已有：关联项目 / 构建预览 / 送 Agent 的片段 / 把结论追加到便签。
// workbench.js 已有：待办与便签的存取。
// 这一层补的是"**它们之间怎么接**"：
//   02 Office 文件关联到某个 Task
//   05 便签 → Agent Context
//   06 待办 → Agent 任务（"Start with Agent"）
//   07 日历事件 → 项目任务
//   08 并在结构上守住：这些操作**不得改 ProjectContext**
//
// ⚠️ 整个文件包在 IIFE 里：它会被 index.html 当**全局脚本**加载，
//    顶层 const 污染全局就会与别的脚本撞名（workspace.js 刚栽过）。
(function () {
'use strict'

const FUSION_LIMITS = Object.freeze({
  maxNoteChars: 2000,
  maxTitleChars: 80,
  maxTodos: 20,
})

function clip(s, n) { return String(s == null ? '' : s).slice(0, n) }

/**
 * PH3-OFFICE-02：把一条办公文件关联挂到某个 Task 上。
 * ⚠️ 只改这条 link 的 `taskId`，**不碰别的东西** —— 尤其是 ProjectContext。
 */
function linkToTask(link, taskId) {
  if (!link || !link.file) return { ok: false, error: '不是一条有效的文件关联' }
  const id = taskId == null || taskId === '' ? null : String(taskId)
  return { ok: true, link: Object.assign({}, link, { taskId: id }) }
}

/** 从关联里找出属于某个任务的那些（给"这个任务用了哪些文档"用）。 */
function linksOfTask(links, taskId) {
  const id = taskId == null ? null : String(taskId)
  const list = Array.isArray(links) ? links : []
  return list.filter((l) => l && (l.taskId || null) === id)
}

/**
 * PH3-OFFICE-05：便签 → Agent Context。
 *
 * ⚠️ 两条边界：
 *   ① **限量**：便签可能很长，进上下文前要截断并**如实说明截了**；
 *   ② **不注入空便签**：没写过的便签不该在上下文里占一格（那是噪音），
 *      返回 null 表示"这一路没有内容"。
 */
function noteToContext(note, opts = {}) {
  const max = Number.isFinite(opts.maxChars) ? opts.maxChars : FUSION_LIMITS.maxNoteChars
  const text = String(note == null ? '' : note).trim()
  if (!text) return null                        // ★ 空的就不注入
  const truncated = text.length > max
  return {
    kind: 'note',
    text: truncated ? text.slice(0, max) : text,
    truncated,
    chars: Math.min(text.length, max),
    note: truncated ? ('便签共 ' + text.length + ' 字，只带了前 ' + max + ' 字') : null,
  }
}

/**
 * PH3-OFFICE-06：待办 → Agent 任务（界面上就是"Start with Agent"）。
 *
 * ⚠️ **不猜意图**：直接把待办文本当目标，**不**自动补"请修复/请实现"之类的话术。
 *    猜错了会让 Agent 去做用户没要求的事 —— 那比不做更糟。
 *    真正需要补充说明的，由用户在点之前自己写进待办里。
 */
function todoToAgentTask(todo, opts = {}) {
  const t = todo || {}
  const text = String(t.text == null ? '' : t.text).trim()
  if (!text) return { ok: false, error: '这条待办是空的，不能当任务' }
  if (t.done === true) return { ok: false, error: '这条待办已完成，不重复发起' }
  return {
    ok: true,
    task: Object.freeze({
      goal: clip(text, FUSION_LIMITS.maxTitleChars * 4),
      todoId: t.id == null ? null : String(t.id),
      projectRoot: opts.projectRoot || null,
      // 只有待办本身带说明时才带上 —— 我们**不替用户编**
      detail: t.detail ? clip(t.detail, 300) : null,
    }),
    prompt: text,                               // ★ 原样，不加话术
    note: '待办文本**原样**当任务目标 —— 不自动补"请修复/请实现"之类的话（猜错意图比不做更糟）',
  }
}

/**
 * PH3-OFFICE-07：日历事件 → 项目任务。
 * ⚠️ 只做**映射**，不建日历系统（冻结项）—— 输入是外面给的 {title, at, note}。
 */
function calendarToProjectTask(event, opts = {}) {
  const e = event || {}
  const title = String(e.title == null ? '' : e.title).trim()
  if (!title) return { ok: false, error: '事件没有标题' }
  const at = Number.isFinite(e.at) ? e.at : null
  return {
    ok: true,
    task: Object.freeze({
      text: clip(title, FUSION_LIMITS.maxTitleChars),
      dueAt: at,                                // 拿不到时间就是 null，**不编一个**
      projectRoot: opts.projectRoot || null,
      from: 'calendar',
      detail: e.note ? clip(e.note, 300) : null,
    }),
  }
}

/**
 * PH3-OFFICE-08：**结构保证** —— 这一层能碰什么、绝不能碰什么。
 *
 * 之前 P13-08 已经声明过 Workbench 不反向污染 IDE 状态；这里把同一原则
 * 扩到 Office 融合这一层，并且**在代码里**（不是文档里）标出来，供断言核对。
 */
const FUSION_SCOPE = Object.freeze({
  // 本层可以写的（都在用户目录或项目内的 .moonbit-work，不进源码）
  writes: ['office-links.json(用户目录)', 'workbench.json(用户目录)', 'agent session(用户目录)'],
  // 本层**绝不**写这些
  neverWrites: ['ProjectContext', '项目源码', 'agent-rules.md(需用户确认)', 'providers.json(含 Key)'],
})

/** 把便签 + 待办 + 关联文档凑成一份"给 Agent 的办公上下文"（限量的、可测的）。 */
function buildOfficeContext(input = {}) {
  const i = (input && typeof input === 'object') ? input : {}
  const note = noteToContext(i.note, i)
  const todos = (Array.isArray(i.todos) ? i.todos : [])
    .filter((t) => t && t.done !== true && String(t.text || '').trim())
    .slice(0, FUSION_LIMITS.maxTodos)
    .map((t) => clip(String(t.text).trim(), 200))
  const docs = (Array.isArray(i.links) ? i.links : []).map((l) => ({
    file: l && l.file ? String(l.file) : null,
    name: (l && l.name) || (l && l.file ? String(l.file).split(/[\\/]/).pop() : null),
    taskId: (l && l.taskId) || null,
  })).filter((d) => d.name)
  // ★ 全空就不返回（与"空便签不注入"同一条原则）
  if (!note && !todos.length && !docs.length) return null
  return { note, todos, docs, counts: { note: note ? 1 : 0, todos: todos.length, docs: docs.length } }
}

const API = {
  FUSION_LIMITS, FUSION_SCOPE,
  linkToTask, linksOfTask, noteToContext, todoToAgentTask, calendarToProjectTask, buildOfficeContext,
}

if (typeof module !== 'undefined' && module.exports) module.exports = API
if (typeof window !== 'undefined') window.moonbitOfficeFusion = API
})()
