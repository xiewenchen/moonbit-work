'use strict'

/**
 * Patch 的 UI 接线（Phase 2 / P8 补完：真正的"预览 + Apply/Cancel"）
 *
 * 为什么做成**两阶段**：
 *   `agent-patch.js` 里的 `applyPatch` 需要一个 `confirm` 回调 —— 而那本该是**用户点按钮**。
 *   如果硬要在一次 IPC 里等用户点按钮，就得做双向 IPC（主进程↔渲染侧来回问），复杂且易错。
 *   改成两阶段后，"确认"天然由渲染侧的用户动作完成：
 *
 *     propose(patch)  → 校验（沙箱 / 危险 / 文件存在 / old 精确匹配）+ 算出 diff + 返回 token 与 preview
 *     用户看对话框 → 点 Apply  → apply(token)  → 备份 → 写入 → 审计
 *                   点 Cancel → cancel(token) → 丢弃
 *
 * 两个安全细节：
 *   · token **一次性**（apply/cancel 后即失效），且**有有效期**（默认 10 分钟）；
 *   · 备份路径 → 原路径的映射留在主进程内存里，`restore` 不靠猜文件名。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { createPatch, analyzePatch, isDangerousPatch, renderPatchPreview } = require('./agent-patch')
const { resolveInsideWorkspace } = require('./agent-sandbox')

const DEFAULT_TTL_MS = 10 * 60 * 1000

function registerAgentPatchIpc({ ipcMain, getWorkspace, backupDir }) {
  const pending = new Map()          // token → { patch, abs, preview, analysis, expiresAt }
  const backups = new Map()          // backupPath → originalAbs
  const audit = []
  const dir = backupDir || path.join(os.homedir(), '.moonbit-backups')
  let seq = 0

  const now = () => Date.now()
  const rootOf = () => (typeof getWorkspace === 'function' ? getWorkspace() : '')

  function logAudit(entry) {
    audit.push(Object.assign({ timestamp: now() }, entry))
    if (audit.length > 200) audit.splice(0, audit.length - 200)
  }

  function ensureBackupDir() {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (e) {
      if (!fs.existsSync(dir)) throw e
    }
  }

  function gcPending() {
    const t = now()
    for (const [k, v] of Array.from(pending)) if (v.expiresAt <= t) pending.delete(k)
  }

  ipcMain.handle('agentPatch:propose', (_e, patchInput = {}) => {
    gcPending()
    const patch = createPatch(patchInput)
    const root = rootOf()
    if (!root) return { ok: false, reason: 'no-workspace', error: '未打开项目' }

    // ① 沙箱
    let realpath
    try {
      realpath = (p) => fs.realpathSync(p)
    } catch (e) {
      realpath = undefined
    }
    const g = resolveInsideWorkspace(root, patch.file, realpath ? { realpath } : {})
    if (!g.ok) return { ok: false, reason: 'outside-workspace', error: g.error }

    // ② 危险目标
    const danger = isDangerousPatch(patch, { root })
    if (danger.danger) return { ok: false, reason: 'dangerous', error: '危险 patch：' + danger.reason }

    // ③ 文件存在 + ④ diff（含 old 精确匹配）
    let content
    try {
      content = fs.readFileSync(g.path, 'utf8')
    } catch (e) {
      return { ok: false, reason: 'no-file', error: '读不到目标文件：' + String((e && e.message) || e) }
    }
    const analysis = analyzePatch(patch, { fileContent: content })
    if (!analysis.ok) return { ok: false, reason: 'bad-patch', error: analysis.error }

    const token = 'p' + (++seq) + '-' + Math.random().toString(36).slice(2, 8)
    pending.set(token, { patch, abs: g.path, preview: renderPatchPreview(patch), analysis, expiresAt: now() + DEFAULT_TTL_MS })
    return {
      ok: true,
      token,
      file: patch.file,
      abs: g.path,
      summary: patch.summary,
      preview: renderPatchPreview(patch),
      analysis,
      expiresAt: now() + DEFAULT_TTL_MS,
    }
  })

  ipcMain.handle('agentPatch:apply', (_e, { token } = {}) => {
    gcPending()
    const item = pending.get(token)
    if (!item) return { ok: false, reason: 'no-token', error: '确认已过期或不存在（请重新预览）' }
    pending.delete(token)                                  // ★ 一次性

    const original = item.abs
    let backupPath = null
    try {
      ensureBackupDir()
      backupPath = path.join(dir, path.basename(original) + '.' + now() + '.bak')
      fs.copyFileSync(original, backupPath)
      backups.set(backupPath, original)                    // 记住"这个备份属于谁"
    } catch (e) {
      logAudit({ file: item.patch.file, accepted: false, reason: 'backup-failed', error: String((e && e.message) || e) })
      return { ok: false, reason: 'backup-failed', error: '备份失败，已放弃修改：' + String((e && e.message) || e) }
    }

    let before = ''
    try {
      before = fs.readFileSync(original, 'utf8')
    } catch (e) {
      return { ok: false, reason: 'read-failed', error: String((e && e.message) || e), backupPath }
    }
    const next = before.replace(item.patch.old, item.patch.new)
    try {
      fs.writeFileSync(original, next, 'utf8')
    } catch (e) {
      let restored = false
      try {
        fs.copyFileSync(backupPath, original)               // P8-11 失败回滚
        restored = true
      } catch (e2) {
        logAudit({ file: item.patch.file, accepted: false, reason: 'write-failed-restore-failed', error: String((e2 && e2.message) || e2) })
        return { ok: false, reason: 'write-failed-restore-failed', error: '写入失败且恢复失败：' + String((e && e.message) || e), backupPath }
      }
      logAudit({ file: item.patch.file, accepted: false, reason: 'write-failed', error: String((e && e.message) || e), backupPath, restored })
      return { ok: false, reason: 'write-failed', error: '写入失败：' + String((e && e.message) || e), backupPath, restored }
    }

    logAudit({ file: item.patch.file, summary: item.patch.summary, accepted: true, reason: 'applied', backupPath, bytesBefore: before.length, bytesAfter: next.length })
    return { ok: true, file: item.patch.file, abs: original, backupPath, bytesBefore: before.length, bytesAfter: next.length, restored: false }
  })

  ipcMain.handle('agentPatch:cancel', (_e, { token } = {}) => {
    const had = pending.delete(token)
    if (had) logAudit({ accepted: false, reason: 'cancelled' })
    return { ok: true, cancelled: had }
  })

  ipcMain.handle('agentPatch:pending', () => ({ ok: true, pending: Array.from(pending.keys()) }))
  ipcMain.handle('agentPatch:audit', () => ({ ok: true, audit: audit.slice() }))

  return { pendingCount: () => pending.size, audit: () => audit.slice() }
}

module.exports = { registerAgentPatchIpc, DEFAULT_TTL_MS }
