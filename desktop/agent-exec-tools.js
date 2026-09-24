'use strict'

/**
 * Agent 执行工具（Phase 2 / MBW-P7-01 ～ P7-10）
 *
 * Gate P7：**Agent 可以 Build / Test / Run / Stop / Health / API，但仍不能修改源文件。**
 *
 * 与只读表（agent-tools.js）的关系：
 *   · 只读表拒绝一切非 `read`；
 *   · 本表拒绝 `write`，只放 `execute` —— 于是"能跑但不能改"同样是**结构保证**。
 *
 * 三个硬要求写进实现里，而不是靠约定：
 *   P7-01 执行**必须经 Command Registry**（`Agent → Command → build → CommandResult`），不自己 spawn；
 *   P7-08 每次调用都留审计日志（timestamp / session / tool / command / result / duration）；
 *   P7-09 有预算（最大次数 + 最大总时长），超了**在执行前**拒绝。
 *   P7-10 失败就返回失败，**不自动重试**（代码里根本没有重试路径）。
 */

const { PERMISSION, createToolManifest, createBudget } = require('./agent-sandbox')
const { toolResult } = require('./agent-tools')

/** P7-07 API 的输出/规模限制（不是文档约定，是实现里强制）*/
const API_LIMITS = Object.freeze({
  maxBodyBytes: 256 * 1024,
  maxHeaderCount: 64,
  maxHeaderBytes: 8192,
  maxResponseBytes: 256 * 1024,
})

/** P7-01 ～ P7-06 六个执行工具 */
const EXEC_TOOL_SPECS = Object.freeze([
  { name: 'build', permission: PERMISSION.EXECUTE, timeoutMs: 10 * 60 * 1000, maxOutputBytes: 256 * 1024, danger: 'high', network: false, description: '编译当前项目（经命令表 project.build）' },
  { name: 'test', permission: PERMISSION.EXECUTE, timeoutMs: 10 * 60 * 1000, maxOutputBytes: 256 * 1024, danger: 'high', network: false, description: '跑当前项目测试（经命令表 project.test）' },
  { name: 'run', permission: PERMISSION.EXECUTE, timeoutMs: 20000, maxOutputBytes: 65536, danger: 'medium', network: false, description: '启动项目（经命令表 project.run）' },
  { name: 'stop', permission: PERMISSION.EXECUTE, timeoutMs: 15000, maxOutputBytes: 32768, danger: 'low', network: false, description: '停止正在运行的项目（经命令表 project.stop）' },
  { name: 'health', permission: PERMISSION.EXECUTE, timeoutMs: 10000, maxOutputBytes: 32768, danger: 'low', network: true, description: '探活本地服务（默认 /health）' },
  { name: 'apiRequest', permission: PERMISSION.EXECUTE, timeoutMs: 30000, maxOutputBytes: API_LIMITS.maxResponseBytes, danger: 'medium', network: true, description: '对本地 API 发请求（P7-06/07）' },
])

/**
 * @param {object} deps
 *   executeCommand(name, args, opts) → P3 命令表的执行结果（**必须注入**，不自己 spawn）
 *   request({url, method, headers, body, timeoutMs, maxBodyBytes}) → HTTP 结果
 *   runLog() → 最近一次运行结果（给 health 用）
 *   now() / onAudit(entry) / sessionId
 */
function createExecuteToolRegistry(deps = {}) {
  if (typeof deps.executeCommand !== 'function') {
    throw new Error('执行工具必须注入 executeCommand（P7-01：一律经 Command Registry）')
  }
  const tools = new Map()
  const audit = []
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const budget = createBudget(deps.budget || { maxCalls: 10, maxTotalMs: 5 * 60 * 1000, now })

  function logAudit(entry) {
    const row = Object.assign({ timestamp: now(), session: deps.sessionId || null }, entry)
    audit.push(row)
    if (typeof deps.onAudit === 'function') deps.onAudit(row)
    return row
  }

  function register(spec, impl) {
    const manifest = createToolManifest(spec)
    // ★ Gate P7 的结构性保证：执行表**拒绝 write** —— Agent 能跑，但不能改源文件
    if (manifest.permission === PERMISSION.WRITE) {
      throw new Error('执行表不允许 write 权限的工具：' + manifest.name + '（改文件属 P8 的 Patch 流程）')
    }
    tools.set(manifest.name, { manifest, impl })
    return manifest
  }

  function clipTo(text, manifest) {
    const s = String(text == null ? '' : text)
    return s.length <= manifest.maxOutputBytes
      ? { text: s, truncated: false }
      : { text: s.slice(0, manifest.maxOutputBytes), truncated: true }
  }

  async function call(name, args = {}) {
    const t = tools.get(name)
    if (!t) return toolResult({ ok: false, error: '未知或不允许的执行工具：' + name })

    // P7-09：预算在**执行前**检查，超了直接拒绝（不是"跑完再说"）
    const b = budget.tryConsume()
    if (!b.ok) {
      logAudit({ tool: name, command: null, result: 'blocked', duration: 0, error: b.error })
      return toolResult({ ok: false, error: b.error })
    }

    const started = now()
    try {
      const r = await Promise.resolve(t.impl(args, { manifest: t.manifest, deps }))
      const out = r && r.ok === false ? toolResult(r) : toolResult(Object.assign({ ok: true }, r || {}))
      const c = clipTo(out.data && out.data.stdout ? out.data.stdout : '', t.manifest)
      logAudit({
        tool: name,
        command: (out.data && out.data.command) || args.command || null,
        result: out.ok ? 'ok' : 'fail',
        duration: now() - started,
        error: out.error || null,
        truncated: c.truncated || out.truncated === true,
      })
      // P7-10：失败**不重试**，原样返回
      return out
    } catch (e) {
      const err = String((e && e.message) || e)
      logAudit({ tool: name, command: args.command || null, result: 'error', duration: now() - started, error: err })
      return toolResult({ ok: false, error: err })
    }
  }

  // ── P7-01 ～ P7-04：经命令表执行（**不自己 spawn**）──────────────────────────
  const viaCommand = (cmdName, label) => async (args) => {
    const r = await deps.executeCommand(cmdName, args || {}, {})
    return toolResult({
      ok: r && r.ok === true,
      data: { command: cmdName, label, result: r ? { ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr, duration: r.duration } : null },
      error: r && r.error ? r.error : null,
    })
  }
  register(EXEC_TOOL_SPECS[0], viaCommand('project.build', '编译项目'))
  register(EXEC_TOOL_SPECS[1], viaCommand('project.test', '跑测试'))
  register(EXEC_TOOL_SPECS[2], viaCommand('project.run', '运行项目'))
  register(EXEC_TOOL_SPECS[3], viaCommand('project.stop', '停止运行'))

  // ── P7-05 health：探活本地服务 ──────────────────────────────────────────────
  register(EXEC_TOOL_SPECS[4], async (args = {}) => {
    if (typeof deps.request !== 'function') return toolResult({ ok: false, error: 'request 能力未注入' })
    const url = String(args.url || '').trim()
    if (!url) {
      // 没给 URL 时，退而报告"最近一次运行"的状态（不含猜测）
      const log = typeof deps.runLog === 'function' ? await deps.runLog() : null
      return toolResult({ ok: true, data: { url: null, runLog: log, note: '未提供 url；返回最近一次运行状态' } })
    }
    const r = await deps.request({ url, method: 'GET', timeoutMs: Math.min(args.timeoutMs || 5000, 10000), maxBodyBytes: API_LIMITS.maxResponseBytes })
    return toolResult({
      ok: !!(r && r.ok),
      data: { url, status: r && r.status, body: r && r.body },
      error: r && r.error ? r.error : null,
    })
  })

  // ── P7-06/07 apiRequest：带规模限制 ─────────────────────────────────────────
  register(EXEC_TOOL_SPECS[5], async (args = {}) => {
    if (typeof deps.request !== 'function') return toolResult({ ok: false, error: 'request 能力未注入' })
    const url = String(args.url || '').trim()
    if (!url) return toolResult({ ok: false, error: '缺少 url' })

    const headers = args.headers && typeof args.headers === 'object' ? args.headers : {}
    const headerNames = Object.keys(headers)
    if (headerNames.length > API_LIMITS.maxHeaderCount) {
      return toolResult({ ok: false, error: '请求头过多（>' + API_LIMITS.maxHeaderCount + '）' })
    }
    if (JSON.stringify(headers).length > API_LIMITS.maxHeaderBytes) {
      return toolResult({ ok: false, error: '请求头过大（>' + API_LIMITS.maxHeaderBytes + ' 字节）' })
    }
    const body = args.body == null ? '' : String(args.body)
    if (body.length > API_LIMITS.maxBodyBytes) {
      return toolResult({ ok: false, error: '请求体过大（>' + API_LIMITS.maxBodyBytes + ' 字节）' })
    }

    const r = await deps.request({
      url,
      method: (args.method || 'GET').toUpperCase(),
      headers,
      body,
      timeoutMs: Math.min(args.timeoutMs || 15000, 30000),
      maxBodyBytes: API_LIMITS.maxResponseBytes,
    })
    return toolResult({
      ok: !!(r && r.ok),
      data: { url, status: r && r.status, headers: r && r.headers, body: r && r.body },
      error: r && r.error ? r.error : null,
      truncated: r && r.truncated === true,
    })
  })

  return {
    list: () => Array.from(tools.values()).map((t) => ({
      name: t.manifest.name,
      permission: t.manifest.permission,
      timeoutMs: t.manifest.timeoutMs,
      maxOutputBytes: t.manifest.maxOutputBytes,
      network: t.manifest.network,
      danger: t.manifest.danger,
      description: t.manifest.description,
    })),
    has: (n) => tools.has(n),
    call,
    audit: () => audit.slice(),
    budget: () => budget.stats(),
    register,
  }
}

module.exports = { API_LIMITS, EXEC_TOOL_SPECS, createExecuteToolRegistry }
