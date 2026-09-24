'use strict'

/**
 * Agent 安全门（Phase 2 / MBW-P5.5-02 ～ P5.5-09）
 *
 * 清单 Gate P5.5：**没有通过 Path Sandbox / Command Sandbox / Timeout / Output Limit / IPC Review，
 * 禁止进入 Agent Execute / Modify。** 这个文件就是那道门的实现。
 *
 * P5.5-01 的盘点结论（现状有多松）：
 *   · preload 暴露 **82 个 IPC 方法**（能力面很宽）；
 *   · `agent.js` 能 spawn 到**任意 cwd**（来自输入）、能 fs.writeFileSync 到 **workspace 外**；
 *   · `preload.writeFile` → 主进程 `fs:write` 接受**任意绝对路径**。
 * 也就是说：**当前 Agent 面没有沙箱**，所以这一批是"补上"，不是"加固"。
 *
 * 本文件是**纯逻辑**：文件系统与命令执行都由调用方注入，
 * 所以逃逸用例（`..` / 绝对路径 / 符号链接）能在纯 Node 里彻底测。
 */

const path = require('node:path')

// ── P5.5-02 权限等级（与 Command Registry 的权限同名，便于对照）────────────────
const PERMISSION = Object.freeze({ READ: 'read', EXECUTE: 'execute', WRITE: 'write' })
const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSION))

// ── 危险等级 ──────────────────────────────────────────────────────────────────
const DANGER = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' })
const ALL_DANGER = Object.freeze(Object.values(DANGER))

// ── P5.5-03 Tool Manifest ─────────────────────────────────────────────────────
/**
 * 每个工具都**必须**声明：能碰哪里、最长多久、能产生什么副作用。
 * 缺字段直接报错 —— 不允许"默认宽松"。
 */
function createToolManifest(spec = {}) {
  if (!spec || typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new Error('工具必须有非空的 name')
  }
  const name = spec.name.trim()
  if (!ALL_PERMISSIONS.includes(spec.permission)) {
    throw new Error('工具 ' + name + ' 必须有 permission（' + ALL_PERMISSIONS.join('/') + '）')
  }
  if (!(Number(spec.timeoutMs) > 0)) {
    throw new Error('工具 ' + name + ' 必须有正的 timeoutMs（P5.5-06：所有工具都要超时）')
  }
  if (!(Number(spec.maxOutputBytes) > 0)) {
    throw new Error('工具 ' + name + ' 必须有正的 maxOutputBytes（P5.5-07：输出要限额）')
  }
  const danger = ALL_DANGER.includes(spec.danger) ? spec.danger : DANGER.LOW
  return Object.freeze({
    name,
    permission: spec.permission,
    timeoutMs: Math.trunc(Number(spec.timeoutMs)),
    maxOutputBytes: Math.trunc(Number(spec.maxOutputBytes)),
    // workspaceOnly 默认 **true** —— 默认收紧，要放宽必须显式写 false（并说明理由）
    workspaceOnly: spec.workspaceOnly !== false,
    network: spec.network === true,
    danger,
    description: spec.description || '',
  })
}

// ── P5.5-04 路径沙箱 ──────────────────────────────────────────────────────────
/**
 * `target` 是否落在 `root` 之内（纯字符串判断，不看符号链接）。
 * 用 path.relative 而不是 startsWith：后者会把 `/work-other` 误判成在 `/work` 里。
 */
function isInsideWorkspace(root, target) {
  if (!root || typeof root !== 'string') return false
  if (typeof target !== 'string' || target.trim() === '') return false
  const r = path.resolve(root)
  const t = path.resolve(root, target)
  const rel = path.relative(r, t)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * P5.5-04 的完整判定：先做字符串判断，再对**已存在的路径做 realpath**，
 * 防住「workspace 里有个指向外部的符号链接」这种逃逸。
 *
 * @param {string} root  workspace 根
 * @param {string} target 相对或绝对路径
 * @param {{realpath?: (p:string)=>string}} [deps] 注入以便纯逻辑测试
 */
function resolveInsideWorkspace(root, target, deps = {}) {
  if (!root || typeof root !== 'string') return { ok: false, error: '未打开项目（workspace root 为空）' }
  if (typeof target !== 'string' || target.trim() === '') return { ok: false, error: '路径为空' }
  const abs = path.resolve(root, target)
  if (!isInsideWorkspace(root, abs)) {
    return { ok: false, error: '路径越出 workspace：' + target }
  }
  const realpath = typeof deps.realpath === 'function' ? deps.realpath : null
  if (realpath) {
    let real
    try {
      real = realpath(abs)
    } catch (e) {
      // 路径可能还不存在（要新建文件）→ 退而校验它的**父目录**
      const parent = path.dirname(abs)
      try {
        real = path.join(realpath(parent), path.basename(abs))
      } catch (e2) {
        return { ok: false, error: '无法解析真实路径：' + String((e2 && e2.message) || e2) }
      }
    }
    if (!isInsideWorkspace(root, real) && path.resolve(real) !== path.resolve(root)) {
      return { ok: false, error: '真实路径（realpath）越出 workspace：' + real }
    }
    return { ok: true, path: real }
  }
  return { ok: true, path: abs }
}

/** P5.5-09：禁止把 workspace 根本身（或整个 workspace）当成删除/清空目标 */
function isDestructiveTarget(root, target) {
  if (!root || !target) return false
  const r = path.resolve(root)
  const t = path.resolve(root, target)
  return t === r                                  // 目标就是 workspace 根 → 绝不允许
}

// ── P5.5-05 命令沙箱 ──────────────────────────────────────────────────────────
const DEFAULT_ALLOWED_BINS = Object.freeze([
  'moon', 'node', 'npm', 'npx', 'git', 'cargo', 'go', 'python', 'python3', 'pytest',
])

/** 明确危险的可执行（不在这张表里的也可能危险，所以还配合白名单）*/
const FORBIDDEN_BINS = Object.freeze(['rm', 'rmdir', 'del', 'format', 'mkfs', 'shutdown', 'reboot', 'diskpart', 'taskkill', 'reg', 'sudo', 'runas'])

/** 常见破坏性参数组合（即使 bin 在白名单里也要拦）*/
const DESTRUCTIVE_ARG_RE = /(^|\s)(-rf|--recursive|--force|\/s|\/q)(\s|$)|^\.\.(\/|\\|$)/i

/**
 * Agent 不允许自己 exec 任意命令（P5.5-05）—— 必须过这一关。
 * @param {{allow?: string[], allowDestructive?: boolean}} [opts]
 */
function checkCommand(bin, args = [], opts = {}) {
  const b = String(bin || '').trim().toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  if (!b) return { ok: false, error: '缺少命令' }
  if (FORBIDDEN_BINS.includes(b)) return { ok: false, error: '命令被禁：' + b }
  const allow = (opts.allow || DEFAULT_ALLOWED_BINS).map((x) => String(x).toLowerCase())
  if (!allow.includes(b)) return { ok: false, error: '命令不在白名单：' + b + '（允许：' + allow.join('/') + '）' }

  const list = (Array.isArray(args) ? args : [args]).map((a) => String(a))
  const joined = list.join(' ')
  if (!opts.allowDestructive && DESTRUCTIVE_ARG_RE.test(joined)) {
    return { ok: false, error: '参数看起来是破坏性的：' + joined.slice(0, 80) }
  }
  if (DESTRUCTIVE_ARG_RE.test(joined) && !opts.allowDestructive) {
    return { ok: false, error: '参数含递归/强制删除语义' }
  }
  return { ok: true, bin: b, args: list }
}

// ── P5.5-08 预算：最多调用多少次 / 总共多久 ────────────────────────────────────
function createBudget({ maxCalls = 20, maxTotalMs = 120000, now } = {}) {
  const clock = typeof now === 'function' ? now : Date.now
  const startedAt = clock()
  let calls = 0
  return {
    get calls() { return calls },
    get elapsed() { return clock() - startedAt },
    /** 在执行**下一个**工具前调用；超了就拒绝，不是"跑完再说" */
    tryConsume() {
      if (calls >= maxCalls) return { ok: false, error: '已达最大调用次数（' + maxCalls + '）' }
      if (clock() - startedAt >= maxTotalMs) return { ok: false, error: '已达最大总时长（' + maxTotalMs + 'ms）' }
      calls++
      return { ok: true, remaining: maxCalls - calls }
    },
    stats() { return { calls, maxCalls, elapsed: clock() - startedAt, maxTotalMs } },
  }
}

// ── P5.5-06 / P5.5-07：统一执行包装（超时 + 输出限额）──────────────────────────
/**
 * @param {object} manifest createToolManifest 的产物
 * @param {object} deps { runCommand: (spec, {timeoutMs}) => Promise<{code,stdout,stderr}>, budget?, now? }
 */
async function runTool(manifest, spec = {}, deps = {}) {
  if (!manifest || !manifest.name) return { ok: false, error: '缺少工具声明' }
  const runCommand = deps.runCommand
  if (typeof runCommand !== 'function') return { ok: false, error: '缺少 runCommand 注入' }

  if (deps.budget) {
    const b = deps.budget.tryConsume()
    if (!b.ok) return { ok: false, error: b.error }
  }
  const started = Date.now()
  let out
  try {
    out = await runCommand(spec, { timeoutMs: manifest.timeoutMs })
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), duration: Date.now() - started }
  }
  const limit = manifest.maxOutputBytes
  const clip = (s) => {
    const v = String(s == null ? '' : s)
    return v.length <= limit ? { text: v, clipped: false } : { text: v.slice(0, limit), clipped: true }
  }
  const so = clip(out && out.stdout)
  const se = clip(out && out.stderr)
  return {
    ok: !!(out && out.code === 0),
    code: out && typeof out.code === 'number' ? out.code : -1,
    stdout: so.text,
    stderr: se.text,
    clipped: so.clipped || se.clipped,
    duration: Date.now() - started,
  }
}

module.exports = {
  PERMISSION,
  ALL_PERMISSIONS,
  DANGER,
  ALL_DANGER,
  DEFAULT_ALLOWED_BINS,
  FORBIDDEN_BINS,
  createToolManifest,
  isInsideWorkspace,
  resolveInsideWorkspace,
  isDestructiveTarget,
  checkCommand,
  createBudget,
  runTool,
}
