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
// PH3-SESSION-VIEW：导出 / 回放 —— 这个模块建了很久但从未接到界面
//（查缺补漏扫出来的：它的 10 个导出函数只在 test-session-view 里被调用过）。
// ⚠️ listSessions 要的是"一批会话"，而 session-store 是**按项目**存的（一个项目一个会话），
//    所以真正有用的是 exportSession / replaySession，而不是"列表"。
const { exportSession, replaySession } = require('./session-view')

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

  /**
   * PH3-SESSION-VIEW：把当前项目的会话**导出**（json 或 md）供人带走。
   *
   * ⚠️ 导出走 `replaySession` 的**白名单**取字段（不是把整个 session JSON 化）——
   *    这样"以后新增的字段默认不进导出"，不会哪天把思维链之类的内部内容漏出去。
   */
  ipcMain.handle('session:export', (_e, { projectRoot, format } = {}) => {
    const root = String(projectRoot || '')
    if (!root) return { ok: false, error: '没有指定项目' }
    const cur = sessions.get(root) || (() => { try { return store.load(root) } catch (_) { return null } })()
    if (!cur) return { ok: false, error: '这个项目还没有会话可导出' }
    const r = exportSession(cur, format || 'md')
    if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || '导出失败' }
    log({ at: 'session.export', root, format: format || 'md', bytes: String(r.text || '').length })
    return { ok: true, text: String(r.text || ''), format: r.format || (format || 'md'), title: (() => { try { return require('./session-view').titleOf(cur) } catch (_) { return null } })() }
  })

  /** PH3-SESSION-VIEW：回放（白名单取字段）—— 给"看这次会话到底发生了什么"用 */
  ipcMain.handle('session:replay', (_e, { projectRoot } = {}) => {
    const root = String(projectRoot || '')
    const cur = sessions.get(root) || (() => { try { return store.load(root) } catch (_) { return null } })()
    if (!cur) return { ok: false, error: '这个项目还没有会话' }
    return { ok: true, replay: replaySession(cur) }
  })

  return { get: (root) => sessions.get(root) || null }
}

module.exports = { registerSessionIpc }
