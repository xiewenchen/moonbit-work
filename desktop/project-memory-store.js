'use strict'

/**
 * 项目级记忆的文件层（Phase 2.1 / P11-01、P11-02、P11-05）
 *
 * 把 `project-memory.js` 的纯逻辑落到项目里的 `.moonbit-work/`：
 *
 *   ensureLayout(root)   建目录 + 缺什么补什么（**已存在的 project.md 里的手工补充会被保留**）
 *   loadRules / writeRules（写规则走 `canWriteRules` —— 没确认就拒绝，P11-05）
 *   loadExperiences / saveExperiences / appendExperience
 *
 * 注意：这里的 root 是**项目根**（绝对路径），所有写入都在它下面。
 */

const fs = require('fs')
const path = require('path')
const {
  memoryLayout,
  renderProjectMd,
  extractHandWritten,
  buildContextJson,
  renderRulesTemplate,
  parseRules,
  canWriteRules,
  describeMemory,
} = require('./project-memory')

function safeRoot(root) {
  const r = String(root || '')
  if (!r) return null
  try {
    return fs.existsSync(r) && fs.statSync(r).isDirectory() ? r : null
  } catch (e) {
    return null
  }
}

function abs(root, rel) {
  return path.join(root, rel)
}

function readText(root, rel) {
  try { return fs.readFileSync(abs(root, rel), 'utf8') } catch (e) { return null }
}

/**
 * P11-01 / P11-02 / P11-03：保证 `layout` 齐全。
 * 关键行为：**不覆盖已有的手工内容** —— 重新生成 project.md 时会先把它里面
 * `## 手工补充` 一节抠出来再写回去（否则用户写的东西会被静默冲掉）。
 */
function ensureLayout(root, ctx, opts = {}) {
  const r = safeRoot(root)
  if (!r) return { ok: false, error: '项目根无效：' + String(root) }
  const L = memoryLayout()
  const created = []
  try {
    if (!fs.existsSync(abs(r, L.dir))) { fs.mkdirSync(abs(r, L.dir), { recursive: true }); created.push(L.dir) }
    if (!fs.existsSync(abs(r, L.historyDir))) { fs.mkdirSync(abs(r, L.historyDir), { recursive: true }); created.push(L.historyDir) }

    // project.md：
    //  ★ 保护：若已存在但**找不到“由 MoonBit Work 自动生成”标记**，说明它被手工改写/替换过 ——
    //    这时宁可不刷新，也不要拿模板把它盖掉（否则用户写的东西就没了）。
    //  ★ 正常刷新前先存一份 `.bak`，出了意外能找回。
    const existingMd = readText(r, L.project)
    const looksGenerated = existingMd !== null && existingMd.indexOf('由 MoonBit Work 自动生成') >= 0
    if (existingMd !== null && !looksGenerated) {
      return {
        ok: false,
        skipped: true,
        error: 'project.md 已被手工改写（找不到自动生成标记），为避克丢失内容已跳过刷新',
        layout: L,
      }
    }
    const hand = existingMd !== null ? extractHandWritten(existingMd) : ''
    if (existingMd !== null) {
      try { fs.writeFileSync(abs(r, L.project + '.bak'), existingMd, 'utf8') } catch (e) {
        console.log('[WARN] 备份 project.md 失败：' + String((e && e.message) || e))
      }
    }
    fs.writeFileSync(abs(r, L.project), renderProjectMd(ctx || opts.ctx || null, { handWritten: hand }), 'utf8')
    if (existingMd === null) created.push(L.project)

    // rules：**只在不存在时**建模板（存在就绝不碰 —— 那是用户的规则）
    if (readText(r, L.rules) === null) {
      fs.writeFileSync(abs(r, L.rules), renderRulesTemplate(), 'utf8')
      created.push(L.rules)
    }

    // context.json：每次刷新（它是机器生成的）
    fs.writeFileSync(abs(r, L.context), JSON.stringify(buildContextJson(ctx || opts.ctx || null, { now: opts.now }), null, 2) + '\n', 'utf8')
    created.push(L.context)

    return { ok: true, created, layout: L, handWrittenKept: hand.length > 0, backedUp: existingMd !== null }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** P11-04：读规则（Agent 启动时就该读它）*/
function loadRules(root) {
  const r = safeRoot(root)
  if (!r) return { ok: false, error: '项目根无效', rules: [] }
  const raw = readText(r, memoryLayout().rules)
  if (raw === null) return { ok: true, exists: false, rules: [], raw: '' }
  return { ok: true, exists: true, raw, rules: parseRules(raw) }
}

/**
 * P11-05：写规则。**没有 confirmed 就拒绝** —— 而且拒绝时把原因写清楚，
 * 因为"为什么不能改"比"不能改"更重要（规则约束的是 Agent 自己）。
 */
function writeRules(root, raw, opts = {}) {
  const r = safeRoot(root)
  if (!r) return { ok: false, error: '项目根无效' }
  const gate = canWriteRules(opts)
  if (gate.ok !== true) return gate
  try {
    fs.writeFileSync(abs(r, memoryLayout().rules), String(raw == null ? '' : raw), 'utf8')
    return { ok: true, file: memoryLayout().rules }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// ── 经验库（存 history/experiences.json）──────────────────────────────────────
const EXP_FILE = 'experiences.json'

function loadExperiences(root) {
  const r = safeRoot(root)
  if (!r) return { ok: false, error: '项目根无效', experiences: [] }
  const rel = memoryLayout().historyDir + '/' + EXP_FILE
  const raw = readText(r, rel)
  if (raw === null) return { ok: true, exists: false, experiences: [] }
  try {
    const j = JSON.parse(raw)
    return { ok: true, exists: true, experiences: Array.isArray(j && j.experiences) ? j.experiences : [] }
  } catch (e) {
    return { ok: true, exists: true, experiences: [], warning: '经验文件损坏，已当空处理' }
  }
}

function saveExperiences(root, list) {
  const r = safeRoot(root)
  if (!r) return { ok: false, error: '项目根无效' }
  const rel = memoryLayout().historyDir + '/' + EXP_FILE
  try {
    fs.mkdirSync(abs(r, memoryLayout().historyDir), { recursive: true })
    fs.writeFileSync(abs(r, rel), JSON.stringify({ schema: 'moonbit-work/experiences@1', experiences: list || [] }, null, 2) + '\n', 'utf8')
    return { ok: true, file: rel, count: (list || []).length }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 把被压缩掉的原始条目**归档**到 history/archive-<ts>.json。
 * review 指出：只返回 removedIds 的话，被合并的 error/solution 就找不回来了 ——
 * 压缩可以“合”，但不能“丢”。
 */
function archiveExperiences(root, items, opts = {}) {
  const r = safeRoot(root)
  if (!r) return { ok: false, error: '项目根无效' }
  const arr = Array.isArray(items) ? items : []
  if (!arr.length) return { ok: true, file: null, count: 0 }
  const ts = Number.isFinite(opts.now) ? opts.now : Date.now()
  const rel = memoryLayout().historyDir + '/archive-' + ts + '.json'
  try {
    fs.mkdirSync(abs(r, memoryLayout().historyDir), { recursive: true })
    fs.writeFileSync(abs(r, rel), JSON.stringify({ schema: 'moonbit-work/experience-archive@1', archivedAt: ts, experiences: arr }, null, 2) + '\n', 'utf8')
    return { ok: true, file: rel, count: arr.length }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 一行状态（给界面/日志）*/
function describe(root) {
  const r = safeRoot(root)
  if (!r) return '（无项目）'
  const rules = loadRules(r)
  const exps = loadExperiences(r)
  return describeMemory([memoryLayout().project, memoryLayout().context], rules.rules || [], exps.experiences || [])
}

module.exports = {
  EXP_FILE,
  ensureLayout,
  loadRules,
  writeRules,
  loadExperiences,
  saveExperiences,
  archiveExperiences,
  describe,
}
