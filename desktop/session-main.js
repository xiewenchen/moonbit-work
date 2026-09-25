'use strict'

/**
 * Session 的接线（Phase 2.1 / P10-02、P10-08、P10-09）
 *
 * 三个 IPC：
 *   session:resume  —— 按 ProjectContext 恢复/新建会话（**并落盘**）
 *   session:save    —— 保存（原子写）
 *   session:clear   —— 清掉某项目的会话文件
 *
 * 关键：`resume` **只认传入的 ProjectContext**，读也只读那个项目自己的存储文件。
 * 所以"跨项目拿到同一个会话"在这条路径上不可能发生（P10-11）。
 */

const {
  createSession,
  addMessage,
  addToolCall,
  addPatch,
  addVerification,
  setOpencodeSessionId,
  endSession,
  describeSession,
} = require('./session')
const store = require('./session-store')

function registerSessionIpc({ ipcMain, onLog }) {
  const log = typeof onLog === 'function' ? onLog : () => {}
  const sessions = new Map()          // root → session（内存缓存；落盘仍以 store 为准）

  ipcMain.handle('session:resume', (_e, payload = {}) => {
    const ctx = payload.projectContext || null
    const root = (ctx && ctx.rootDir) || ''
    if (!root) {
      // 没打开项目：允许建一个"不绑定项目"的会话，但它不落盘、也不与任何项目匹配
      const s = createSession({ projectContext: null })
      log({ at: 'session.resume', project: null, id: s.id })
      return { ok: true, session: s, restored: false, describe: describeSession(s) }
    }
    const existing = sessions.get(root)
    const s = (existing && existing.state !== 'ended') ? existing : store.resumeOrCreate(ctx)
    const restored = !!s && !!s.projectRoot && (s.messages.length > 0 || !!s.opencodeSessionId)
    sessions.set(root, s)
    const w = store.save(s)
    log({ at: 'session.resume', project: root, id: s.id, restored })
    return { ok: true, session: s, restored, saved: w.ok, describe: describeSession(s) }
  })

  ipcMain.handle('session:save', (_e, { session } = {}) => {
    const r = store.save(session)
    if (session && session.projectRoot) sessions.set(session.projectRoot, session)
    return r
  })

  /** 追加记录（渲染侧不必自己拼 session 对象，避免两边形状不一致）*/
  ipcMain.handle('session:append', (_e, { projectRoot, kind, entry } = {}) => {
    const cur = sessions.get(String(projectRoot || ''))
    if (!cur) return { ok: false, error: '没有该项目的活跃会话' }
    const fns = { message: addMessage, toolCall: addToolCall, patch: addPatch, verification: addVerification }
    const fn = fns[kind]
    if (typeof fn !== 'function') return { ok: false, error: '未知的记录类型：' + kind }
    let next = fn(cur, entry || {})
    if (kind === 'message' && entry && entry.opencodeSessionId) next = setOpencodeSessionId(next, entry.opencodeSessionId)
    sessions.set(next.projectRoot, next)
    store.save(next)
    return { ok: true, session: next }
  })

  ipcMain.handle('session:clear', (_e, { projectRoot } = {}) => {
    const root = String(projectRoot || '')
    if (root) sessions.delete(root)
    return store.clear(root)
  })

  /** P10-10：结束会话上下文（关闭项目时调用）*/
  ipcMain.handle('session:end', (_e, { projectRoot } = {}) => {
    const root = String(projectRoot || '')
    const cur = sessions.get(root)
    if (!cur) return { ok: false, error: '没有该项目的活跃会话' }
    const ended = endSession(cur, {})
    sessions.set(root, ended)
    store.save(ended)
    return { ok: true, session: ended }
  })

  return { get: (root) => sessions.get(root) || null }
}

module.exports = { registerSessionIpc }
