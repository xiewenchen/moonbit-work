'use strict'

/**
 * 工作台的接线（Phase 2.1 / P13-01～03 的持久化 + P13-08 的守门）
 *
 * 数据存 `~/.moonbit-work/workbench.json`（**用户目录**，不进项目）——
 * 和 P10 的会话、P12 的 Provider 一样：它是"我这台机器上的工作台"，
 * 不是一个项目该带到仓库里的东西。
 *
 * ⚠️ P13-08 在这里再守一道：`workbench:save` **只接受工作台自己的三个键**
 * （recent / todos / notes）。别的键（尤其是 IDE 状态）会被**丢掉**，
 * 而不是"存下来再说" —— 否则"不反向污染"就只是一句口号。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
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
} = require('./workbench')

const WB_DIR = path.join(os.homedir(), '.moonbit-work')
const WB_FILE = path.join(WB_DIR, 'workbench.json')

/** 只保留工作台自己的键（P13-08 的最后一道闸）*/
function onlyOwnKeys(store) {
  const s = store && typeof store === 'object' ? store : {}
  return { version: 1, recent: s.recent, todos: s.todos, notes: s.notes }
}

function readStore() {
  try {
    const raw = fs.readFileSync(WB_FILE, 'utf8')
    return sanitizeStore(JSON.parse(raw))
  } catch (e) {
    return emptyStore()      // 不存在 / 损坏 → 空（不抛；存储坏了不该让工作台打不开）
  }
}

function writeStore(store) {
  try {
    fs.mkdirSync(WB_DIR, { recursive: true })
    const target = WB_FILE
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(onlyOwnKeys(sanitizeStore(store)), null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, target)      // 原子写
    return { ok: true, file: WB_FILE }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function registerWorkbenchIpc({ ipcMain, onLog }) {
  const log = typeof onLog === 'function' ? onLog : () => {}

  async function reply(store, extra) {
    const w = writeStore(store)
    return Object.assign({ ok: w.ok === true, error: w.error || null, file: WB_FILE }, extra)
  }

  /** 全量读（含最近项目、待办、便签与摘要）*/
  ipcMain.handle('workbench:load', (_e, { projectRoot } = {}) => {
    const s = readStore()
    return {
      ok: true,
      store: s,
      recent: listRecent(s),
      todos: todosFor(s, projectRoot || null),
      note: noteFor(s, projectRoot || null),
      describe: describeWorkbench(s),
      file: WB_FILE,
    }
  })

  /** 记一次"打开过某个项目"（只吃项目信息，不碰 IDE 状态）*/
  ipcMain.handle('workbench:touchRecent', async (_e, project = {}) => {
    const s = touchRecent(readStore(), project && project.projectContext ? project.projectContext : project, { now: Date.now() })
    const r = await reply(s, { recent: listRecent(s) })
    log({ at: 'wb.touchRecent', count: listRecent(s).length })
    return r
  })

  ipcMain.handle('workbench:forgetRecent', async (_e, { projectRoot } = {}) => {
    const s = forgetRecent(readStore(), projectRoot)
    return reply(s, { recent: listRecent(s) })
  })

  ipcMain.handle('workbench:addTodo', async (_e, { projectRoot, text } = {}) => {
    const r = addTodo(readStore(), projectRoot, text, { now: Date.now() })
    if (r.ok !== true) return { ok: false, error: r.error }
    const w = await reply(r.store, { item: r.item })
    return Object.assign(w, { todos: todosFor(r.store, projectRoot) })
  })

  ipcMain.handle('workbench:toggleTodo', async (_e, { projectRoot, id, done } = {}) => {
    const r = toggleTodo(readStore(), projectRoot, id, { done })
    if (r.ok !== true) return { ok: false, error: r.error }
    const w = await reply(r.store, {})
    return Object.assign(w, { todos: todosFor(r.store, projectRoot) })
  })

  ipcMain.handle('workbench:removeTodo', async (_e, { projectRoot, id } = {}) => {
    const r = removeTodo(readStore(), projectRoot, id)
    if (r.ok !== true) return { ok: false, error: r.error }
    const w = await reply(r.store, {})
    return Object.assign(w, { todos: todosFor(r.store, projectRoot) })
  })

  ipcMain.handle('workbench:setNote', async (_e, { projectRoot, text } = {}) => {
    const r = setNote(readStore(), projectRoot, text)
    if (r.ok !== true) return { ok: false, error: r.error }
    const w = await reply(r.store, {})
    return Object.assign(w, { note: noteFor(r.store, projectRoot) })
  })

  /** 整份保存（界面侧批量改动时用）—— 只取工作台自己的键 */
  ipcMain.handle('workbench:save', async (_e, { store } = {}) => {
    const w = writeStore(store)
    log({ at: 'wb.save', ok: w.ok === true })
    return w
  })

  /** 供验证脚本用：直接看一眼磁盘上都有些什么键（证明没混进 IDE 状态）*/
  ipcMain.handle('workbench:file', () => {
    const s = readStore()
    return { ok: true, file: WB_FILE, keys: Object.keys(s).sort() }
  })

  return { readStore, writeStore, WB_FILE }
}

module.exports = { registerWorkbenchIpc, readStore, writeStore, onlyOwnKeys, WB_FILE }
