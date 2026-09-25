'use strict'

/**
 * Session 持久化（Phase 2.1 / P10-08）
 *
 * 存放位置：**用户目录** `~/.moonbit-work/sessions/<按项目根派生的文件名>.json`
 *
 * 为什么不放项目里：会话含对话内容与文件片段，放进项目就会出现在 `git status` /
 * 被误提交（和 P12 把 Provider Key 放用户目录是同一个理由）。
 *
 * 为什么**按项目一个文件**而不是一个大文件：一个文件会随项目数无限增长，
 * 而且任何项目的一次写入都要重写全部会话；按项目分开，读一个项目只碰它自己那份，
 * 顺带天然隔离了"读到别的项目的会话"。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { createSession, SESSION_STATE } = require('./session')

const SESSION_DIR = path.join(os.homedir(), '.moonbit-work', 'sessions')
const MAX_PROJECT_FILES = 200      // 兜底：避免目录无限膨胀

/** 项目根 → 文件名（只留安全字符，够唯一即可；再叠一层短哈希避免歧义）*/
function fileFor(root) {
  const safe = String(root || '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-80) || 'no-project'
  let h = 0
  const s = String(root || '')
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0 }
  return safe + '-' + h.toString(16).padStart(8, '0') + '.json'
}

function ensureDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
}

/** 读某项目的会话；没有就返回 null（**不会**顺手新建 —— 新建由上层决定）*/
function load(root) {
  if (!root) return null
  try {
    const raw = fs.readFileSync(path.join(SESSION_DIR, fileFor(root)), 'utf8')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object' || !j.id) return null
    // 防御：文件里的 projectRoot 必须与请求的一致（避免文件名碰撞导致串项目）
    if (j.projectRoot !== root) return null
    // 归一成 session 形状（数组字段兜底，避免旧文件缺字段时下游崩）
    return Object.freeze(Object.assign({
      messages: [], toolCalls: [], patches: [], verifications: [],
      state: SESSION_STATE.ACTIVE, opencodeSessionId: null, projectType: null,
      createdAt: 0, updatedAt: 0,
    }, j))
  } catch (e) {
    return null          // 不存在 / 损坏 → 当作没有（不抛）
  }
}

/** 写某项目的会话（原子写：先写临时文件再 rename）*/
function save(session) {
  if (!session || !session.projectRoot) return { ok: false, error: '会话没有绑定项目，拒绝落盘' }
  try {
    ensureDir()
    const target = path.join(SESSION_DIR, fileFor(session.projectRoot))
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8')
    fs.renameSync(tmp, target)
    return { ok: true, file: target }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 删掉某项目的会话文件 */
function clear(root) {
  if (!root) return { ok: false, error: '缺少项目根' }
  try {
    const f = path.join(SESSION_DIR, fileFor(root))
    if (fs.existsSync(f)) fs.unlinkSync(f)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 已有会话文件的项目数（诊断用）*/
function countFiles() {
  try { return fs.readdirSync(SESSION_DIR).filter((n) => n.endsWith('.json')).length } catch (e) { return 0 }
}

/**
 * P10-08 的恢复入口：**读回**某项目的会话；没有就按 projectContext 新建。
 * 注意它**只认该项目自己的文件** —— 从存储层就杜绝了跨项目读取。
 */
function resumeOrCreate(projectContext, opts = {}) {
  const root = (projectContext && projectContext.rootDir) || ''
  const existing = root ? load(root) : null
  if (existing && existing.state === SESSION_STATE.ACTIVE) {
    // 项目类型可能变了（比如同一个目录换了工程类型）→ 更新成当前的
    return Object.freeze(Object.assign({}, existing, { projectType: (projectContext && projectContext.projectType) || existing.projectType }))
  }
  if (existing && existing.state === SESSION_STATE.ENDED) {
    // 已结束的会话不复活 —— 新建（P10-09 的语义）
  }
  return createSession(Object.assign({}, opts, { projectContext }))
}

module.exports = { SESSION_DIR, fileFor, load, save, clear, countFiles, resumeOrCreate, MAX_PROJECT_FILES }
