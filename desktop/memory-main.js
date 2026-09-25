'use strict'

/**
 * 项目级记忆的接线（Phase 2.1 / P11-04、P11-06～09）
 *
 *   memory:ensure       建/刷新 .moonbit-work/（保留手工补充；不覆盖已有规则）
 *   memory:rules        读规则（Agent 启动时读它 —— P11-04）
 *   memory:writeRules   写规则（**必须带 confirmed**，否则拒绝 —— P11-05）
 *   memory:experiences  列经验 / memory:add 追加（P11-06）/ memory:delete（P11-09）
 *   memory:compress     压缩（P11-08）/ memory:search 按当前任务检索（P11-07）
 *
 * 设计：所有涉及"项目"的入口都要求 `projectRoot`，且都在 store 层校验它是**真目录**；
 * 没有任何按名字猜项目、或跨项目读写的路径。
 */

const {
  createExperience,
  searchExperiences,
  compressExperiences,
  deleteExperience,
  describeMemory,
} = require('./project-memory')
const store = require('./project-memory-store')

function registerMemoryIpc({ ipcMain, onLog }) {
  const log = typeof onLog === 'function' ? onLog : () => {}

  ipcMain.handle('memory:ensure', (_e, { projectRoot, projectContext } = {}) => {
    const r = store.ensureLayout(projectRoot, projectContext)
    log({ at: 'memory.ensure', root: projectRoot || null, ok: r.ok === true, created: r.created || [] })
    return r
  })

  ipcMain.handle('memory:rules', (_e, { projectRoot } = {}) => {
    const r = store.loadRules(projectRoot)
    log({ at: 'memory.rules', root: projectRoot || null, count: (r.rules || []).length })
    return r
  })

  /** P11-05：写规则必须确认 —— 由 store 里的 canWriteRules 把关 */
  ipcMain.handle('memory:writeRules', (_e, { projectRoot, raw, confirmed } = {}) => {
    const r = store.writeRules(projectRoot, raw, { confirmed: confirmed === true })
    log({ at: 'memory.writeRules', root: projectRoot || null, ok: r.ok === true, refused: r.needsConfirm === true })
    return r
  })

  ipcMain.handle('memory:experiences', (_e, { projectRoot } = {}) => {
    const r = store.loadExperiences(projectRoot)
    return Object.assign({}, r, { describe: describeMemory([], [], r.experiences || []) })
  })

  /** P11-06：只接受**已经验证过**的（未验证的不进库 —— 那是"我猜"）*/
  ipcMain.handle('memory:add', (_e, { projectRoot, experience } = {}) => {
    const cur = store.loadExperiences(projectRoot)
    if (cur.ok !== true) return cur
    const e = createExperience(experience || {})
    if (e.ok !== true) return { ok: false, error: e.errors.join('；') }
    if (e.verified !== true) {
      return { ok: false, error: '只保存已验证（verified: true）的经验 —— 没验证过的"我猜是这样"不是经验' }
    }
    const next = (cur.experiences || []).concat([e])
    const w = store.saveExperiences(projectRoot, next)
    return Object.assign({ ok: w.ok === true, error: w.error || null, experience: e, count: next.length })
  })

  /** P11-07：按当前任务/文件检索，**只给相关的那几条** */
  ipcMain.handle('memory:search', (_e, { projectRoot, query, limit } = {}) => {
    const cur = store.loadExperiences(projectRoot)
    if (cur.ok !== true) return cur
    const hits = searchExperiences(cur.experiences || [], query || {}, { limit })
    log({ at: 'memory.search', root: projectRoot || null, hits: hits.length })
    return { ok: true, hits, total: (cur.experiences || []).length }
  })

  ipcMain.handle('memory:compress', (_e, { projectRoot, threshold } = {}) => {
    const cur = store.loadExperiences(projectRoot)
    if (cur.ok !== true) return cur
    const r = compressExperiences(cur.experiences || [], { threshold })
    // ★ 先归档被合并掉的原始条目 —— 压缩可以“合”，但不能“丢”（review 指出）
    const arch = store.archiveExperiences(projectRoot, r.removed)
    const w = store.saveExperiences(projectRoot, r.experiences)
    log({ at: 'memory.compress', root: projectRoot || null, before: (cur.experiences || []).length, after: r.experiences.length, archived: arch.count })
    return {
      ok: w.ok === true,
      error: w.error || null,
      before: (cur.experiences || []).length,
      after: r.experiences.length,
      removedCount: r.removedCount,
      archivedFile: arch.file || null,
      archivedCount: arch.count || 0,
    }
  })

  ipcMain.handle('memory:delete', (_e, { projectRoot, id } = {}) => {
    const cur = store.loadExperiences(projectRoot)
    if (cur.ok !== true) return cur
    const r = deleteExperience(cur.experiences || [], id)
    if (r.ok !== true) return { ok: false, error: r.error }
    const w = store.saveExperiences(projectRoot, r.experiences)
    return { ok: w.ok === true, error: w.error || null, count: r.experiences.length }
  })
}

module.exports = { registerMemoryIpc }
