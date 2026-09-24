'use strict'

/**
 * Agent 修改（Patch）—— Phase 2 / MBW-P8-01 ～ P8-11
 *
 * ⚠️ 这是**风险最高**的一批：Agent 第一次可能改动真实文件。
 * 所以这里有四条"防呆"是硬性的，不靠调用方自觉：
 *
 *   P8-02 Agent 只能产生 Patch，**不能直接写文件** —— 唯一入口是 applyPatch()；
 *   P8-05 **没有明确的 confirm，就拒绝应用**（默认拒绝，不是默认通过）；
 *   P8-07/08 `old` 必须与文件内容**精确匹配**，否则拒绝 —— 绝不"猜到哪就写哪"；
 *   P8-11 应用失败 → **自动从备份恢复**，并把"已恢复"写进结果。
 *
 * 顺序照清单 P8-04：`backup → calculate patch → preview`（**先备份，再算，再给看**）。
 *
 * 纯逻辑：文件读写、备份、确认回调全部注入 —— 所以"失败恢复""old 不匹配"这些
 * 只有在真实文件系统上才敢验的行为，能在纯 Node 里彻底测。
 */

const path = require('node:path')
const { resolveInsideWorkspace, isDestructiveTarget } = require('./agent-sandbox')

/** P8-09 危险目标的判定表 */
const DANGEROUS_PATH_RE = /(^|[\\/])\.git([\\/]|$)|(^|[\\/])(\.env|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials|\.aws)([\\/]|$)|\.(pem|key|pfx|p12)$/i

/** 单次 patch 的规模上限（防止"整仓替换"这种"patch"）*/
const PATCH_LIMITS = Object.freeze({
  maxOldChars: 200000,
  maxNewChars: 200000,
  maxAddedLines: 2000,
  maxRemovedLines: 2000,
})

// ── P8-01 Patch Model ─────────────────────────────────────────────────────────
function createPatch(input = {}) {
  return {
    file: String(input.file == null ? '' : input.file).trim(),
    old: String(input.old == null ? '' : input.old),
    new: String(input.new == null ? '' : input.new),
    summary: String(input.summary == null ? '' : input.summary),
  }
}

// ── P8-08 Diff 检查 ───────────────────────────────────────────────────────────
function countLines(text) {
  const s = String(text == null ? '' : text)
  return s === '' ? 0 : s.split(/\r?\n/).length
}

function analyzePatch(patch, { fileContent } = {}) {
  const oldText = String(patch.old == null ? '' : patch.old)
  const newText = String(patch.new == null ? '' : patch.new)
  if (oldText === '' && newText === '') return { ok: false, error: 'patch 没有内容（old 与 new 都为空）' }
  if (oldText === newText) return { ok: false, error: 'patch 没有实际改动（old 与 new 相同）' }
  if (oldText.length > PATCH_LIMITS.maxOldChars || newText.length > PATCH_LIMITS.maxNewChars) {
    return { ok: false, error: 'patch 过大（超过 ' + PATCH_LIMITS.maxOldChars + ' 字）' }
  }
  const addedLines = Math.max(0, countLines(newText) - countLines(oldText))
  const removedLines = Math.max(0, countLines(oldText) - countLines(newText))
  if (addedLines > PATCH_LIMITS.maxAddedLines || removedLines > PATCH_LIMITS.maxRemovedLines) {
    return { ok: false, error: 'patch 行数过多（可能不是"局部修改"）' }
  }
  if (typeof fileContent === 'string') {
    const hits = fileContent.split(oldText).length - 1
    if (hits === 0) return { ok: false, error: 'old 片段在文件里找不到（拒绝盲改）' }
    if (hits > 1) return { ok: false, error: 'old 片段在文件里出现 ' + hits + ' 次（有歧义，拒绝）' }
  }
  return { ok: true, addedLines, removedLines, oldLines: countLines(oldText), newLines: countLines(newText) }
}

// ── P8-09 危险 Patch ──────────────────────────────────────────────────────────
function isDangerousPatch(patch, { root } = {}) {
  if (isDestructiveTarget(root, patch.file)) return { danger: true, reason: '目标是 workspace 根' }
  if (DANGEROUS_PATH_RE.test(patch.file)) return { danger: true, reason: '目标是受保护路径（.git / 密钥 / 凭据）' }
  const oldText = String(patch.old || '')
  const newText = String(patch.new || '')
  // 把整段内容清空（old 有内容、new 为空）→ 相当于"删除文件内容"
  if (oldText.trim() !== '' && newText === '') return { danger: true, reason: '会把文件内容清空' }
  return { danger: false, reason: null }
}

// ── P8-03 Preview ─────────────────────────────────────────────────────────────
function renderPatchPreview(patch) {
  return '文件：' + patch.file + (patch.summary ? '（' + patch.summary + '）' : '') + '\n' +
    '--- 旧 ---\n' + patch.old + '\n--- 新 ---\n' + patch.new
}

// ── P8-04 ～ P8-11 应用流程 ───────────────────────────────────────────────────
/**
 * @param {object} deps
 *   root / readFile(abs) / writeFile(abs, content) / backup(abs) → backupPath / restore(backupPath)
 *   confirm({ patch, preview, analysis }) → Promise<boolean>    ← **不提供就视为未确认**
 *   now() / onAudit(entry) / sessionId
 */
async function applyPatch(patchInput, deps = {}) {
  const patch = createPatch(patchInput)
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const started = now()
  const audit = (entry) => {
    const row = Object.assign({ timestamp: now(), session: deps.sessionId || null, file: patch.file, summary: patch.summary, duration: now() - started }, entry)
    if (typeof deps.onAudit === 'function') deps.onAudit(row)
    return row
  }
  const done = (r) => {
    audit({ accepted: r.ok === true, result: r.ok ? 'applied' : (r.reason || 'rejected'), error: r.error || null, restored: r.restored === true })
    return r
  }

  // ① P8-06 workspace 检查
  if (typeof deps.readFile !== 'function' || typeof deps.writeFile !== 'function') {
    return done({ ok: false, reason: 'no-io', error: '缺少 readFile/writeFile 注入' })
  }
  const g = resolveInsideWorkspace(deps.root, patch.file, deps.realpath ? { realpath: deps.realpath } : {})
  if (!g.ok) return done({ ok: false, reason: 'outside-workspace', error: g.error })
  const abs = g.path        // 注意：resolveInsideWorkspace 返回的键是 `path`（不是 abs）

  // ② P8-09 危险 Patch
  const danger = isDangerousPatch(patch, { root: deps.root })
  if (danger.danger) return done({ ok: false, reason: 'dangerous', error: '危险 patch：' + danger.reason })

  // ③ P8-07 文件存在性
  let content
  try {
    content = await deps.readFile(abs)
  } catch (e) {
    return done({ ok: false, reason: 'no-file', error: '读不到目标文件：' + String((e && e.message) || e) })
  }
  if (typeof content !== 'string') return done({ ok: false, reason: 'no-file', error: '目标不是文本文件' })

  // ④ P8-08 Diff 检查（含 old 精确匹配 —— 拒绝盲改）
  const analysis = analyzePatch(patch, { fileContent: content })
  if (!analysis.ok) return done({ ok: false, reason: 'bad-patch', error: analysis.error })

  const preview = renderPatchPreview(patch)

  // ⑤ P8-05 用户确认：**没有确认就不改**（默认拒绝）
  const confirmed = typeof deps.confirm === 'function' ? await deps.confirm({ patch, preview, analysis }) : false
  if (confirmed !== true) return done({ ok: false, reason: 'not-confirmed', error: '未确认（需要用户明确同意）', preview })

  // ⑥ P8-04 备份（**在写入之前**）
  let backupPath = null
  try {
    backupPath = typeof deps.backup === 'function' ? await deps.backup(abs) : null
  } catch (e) {
    return done({ ok: false, reason: 'backup-failed', error: '备份失败，已放弃修改：' + String((e && e.message) || e) })
  }

  // ⑦ 写入
  const nextContent = content.replace(patch.old, patch.new)
  try {
    await deps.writeFile(abs, nextContent)
  } catch (e) {
    // ⑧ P8-11 失败自动恢复
    let restored = false
    if (backupPath && typeof deps.restore === 'function') {
      try {
        await deps.restore(backupPath)
        restored = true
      } catch (e2) {
        return done({ ok: false, reason: 'write-failed-restore-failed', error: '写入失败且恢复失败：' + String((e && e.message) || e) + ' / ' + String((e2 && e2.message) || e2), backupPath })
      }
    }
    return done({ ok: false, reason: 'write-failed', error: '写入失败：' + String((e && e.message) || e), backupPath, restored })
  }

  return done({
    ok: true,
    file: patch.file,
    abs,
    backupPath,
    preview,
    analysis,
    bytesBefore: content.length,
    bytesAfter: nextContent.length,
    restored: false,
  })
}

module.exports = {
  PATCH_LIMITS,
  DANGEROUS_PATH_RE,
  createPatch,
  analyzePatch,
  isDangerousPatch,
  renderPatchPreview,
  applyPatch,
}
