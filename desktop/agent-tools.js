'use strict'

/**
 * Agent 只读工具（Phase 2 / MBW-P6-01 ～ P6-10）
 *
 * Gate P6：**Agent 可以「理解项目」，但不能修改、不能执行。**
 *
 * 这份实现让"只读"成为**结构保证**而不是约定：
 *   注册表在 register 时就拒绝任何非 `read` 权限的工具（见 createReadOnlyToolRegistry.register）。
 *   于是"Agent 不会写文件 / 不会跑命令"不需要靠代码评审发现 —— 它压根没有那样的工具可调。
 *
 * 安全原语全部复用 `agent-sandbox.js`（Manifest 必填字段 + 路径沙箱），不另写一套。
 * 文件系统等能力由调用方注入 —— 所以能纯 Node 单测（含越界用例）。
 */

const { PERMISSION, createToolManifest, resolveInsideWorkspace } = require('./agent-sandbox')

/** P6-08 统一的工具结果形状 */
function toolResult(input = {}) {
  return {
    ok: !!input.ok,
    data: input.data === undefined ? null : input.data,
    error: input.error == null ? null : String(input.error),
    truncated: input.truncated === true,
  }
}

/** P6-09 审计用的工具声明（超时 / 输出限额都是 Manifest 必填项）*/
const READ_TOOL_SPECS = Object.freeze([
  { name: 'readFile', permission: PERMISSION.READ, timeoutMs: 5000, maxOutputBytes: 65536, workspaceOnly: true, description: '读 workspace 内的文本文件' },
  { name: 'listDir', permission: PERMISSION.READ, timeoutMs: 5000, maxOutputBytes: 32768, workspaceOnly: true, description: '列目录（workspace 内）' },
  { name: 'search', permission: PERMISSION.READ, timeoutMs: 10000, maxOutputBytes: 65536, workspaceOnly: true, description: '在 workspace 内做文本搜索' },
  { name: 'symbols', permission: PERMISSION.READ, timeoutMs: 5000, maxOutputBytes: 65536, workspaceOnly: true, description: '查符号索引（定义/引用）' },
  { name: 'getDiagnostics', permission: PERMISSION.READ, timeoutMs: 2000, maxOutputBytes: 32768, workspaceOnly: false, description: '读统一问题模型（P4 的 Store）' },
  { name: 'getRunLog', permission: PERMISSION.READ, timeoutMs: 2000, maxOutputBytes: 32768, workspaceOnly: false, description: '读最近一次运行结果' },
  { name: 'getProjectInfo', permission: PERMISSION.READ, timeoutMs: 2000, maxOutputBytes: 16384, workspaceOnly: false, description: '读单一工程上下文（P2）' },
  // P14-12：读后端状态（健康/端口/PG/Redis）—— **只读**，不启动、不构建
  { name: 'backendStatus', permission: PERMISSION.READ, timeoutMs: 8000, maxOutputBytes: 32768, workspaceOnly: false, description: '当前项目的后端状态（健康/端口/PG/Redis）' },
])

/**
 * 建一个**只读**工具注册表。
 * @param {object} deps 能力注入：
 *   readFile(absPath) / listDir(absPath) / search({query, root}) /
 *   symbols({query, root}) / problems({filter}) / runLog() / projectInfo() /
 *   rootOf() → workspace 根 / realpath(p)（可选，用于符号链接复核）
 */
function createReadOnlyToolRegistry(deps = {}) {
  const tools = new Map()

  const rootOf = () => {
    const r = typeof deps.rootOf === 'function' ? deps.rootOf() : deps.root
    return typeof r === 'string' ? r : ''
  }

  /** 路径沙箱：越界返回错误结果，否则返回绝对路径 */
  function guardPath(target) {
    const opts = typeof deps.realpath === 'function' ? { realpath: deps.realpath } : {}
    const r = resolveInsideWorkspace(rootOf(), target, opts)
    return r.ok ? { ok: true, abs: r.path } : { ok: false, error: r.error }
  }

  function clipTo(text, manifest) {
    const s = String(text == null ? '' : text)
    return s.length <= manifest.maxOutputBytes
      ? { text: s, truncated: false }
      : { text: s.slice(0, manifest.maxOutputBytes), truncated: true }
  }

  function register(spec, impl) {
    const manifest = createToolManifest(spec)
    // ★ Gate P6 的结构性保证：只读注册表**不接受**任何非 read 权限的工具
    if (manifest.permission !== PERMISSION.READ) {
      throw new Error('只读注册表不允许 ' + manifest.permission + ' 权限的工具：' + manifest.name)
    }
    if (typeof impl !== 'function') throw new Error('工具 ' + manifest.name + ' 必须有实现')
    tools.set(manifest.name, { manifest, impl })
    return manifest
  }

  function list() {
    return Array.from(tools.values()).map((t) => ({
      name: t.manifest.name,
      permission: t.manifest.permission,
      timeoutMs: t.manifest.timeoutMs,
      maxOutputBytes: t.manifest.maxOutputBytes,
      workspaceOnly: t.manifest.workspaceOnly,
      description: t.manifest.description,
    }))
  }

  async function call(name, args = {}) {
    const t = tools.get(name)
    if (!t) return toolResult({ ok: false, error: '未知或不允许的工具：' + name })
    const ctx = {
      manifest: t.manifest,
      root: rootOf(),
      guardPath,
      clip: (s) => clipTo(s, t.manifest),
      args,
    }
    try {
      const r = await Promise.resolve(t.impl(args, ctx))
      if (r && r.ok === false) return toolResult(r)          // 实现自己报的错，原样返回
      return toolResult(Object.assign({ ok: true }, r || {}))
    } catch (e) {
      return toolResult({ ok: false, error: String((e && e.message) || e) })
    }
  }

  // ── P6-01 readFile ──────────────────────────────────────────────────────────
  register(READ_TOOL_SPECS[0], async (args, ctx) => {
    if (typeof deps.readFile !== 'function') return toolResult({ ok: false, error: 'readFile 能力未注入' })
    const g = ctx.guardPath(args.path)
    if (!g.ok) return toolResult({ ok: false, error: g.error })
    // 注意：`guardPath` 返回的键是 **abs**（它把 resolveInsideWorkspace 的 path 翻译成了 abs）
    const text = await deps.readFile(g.abs)
    const c = ctx.clip(text)
    return toolResult({ ok: true, data: { path: args.path, abs: g.abs, content: c.text }, truncated: c.truncated })
  })

  // ── P6-02 listDir ───────────────────────────────────────────────────────────
  register(READ_TOOL_SPECS[1], async (args, ctx) => {
    if (typeof deps.listDir !== 'function') return toolResult({ ok: false, error: 'listDir 能力未注入' })
    const g = ctx.guardPath(args.path == null ? '.' : args.path)
    if (!g.ok) return toolResult({ ok: false, error: g.error })
    const entries = await deps.listDir(g.abs)
    if (entries == null) return toolResult({ ok: false, error: '目录不存在：' + args.path })
    const c = ctx.clip(JSON.stringify(entries))
    return toolResult({ ok: true, data: { path: args.path || '.', entries }, truncated: c.truncated })
  })

  // ── P6-03 search ────────────────────────────────────────────────────────────
  register(READ_TOOL_SPECS[2], async (args, ctx) => {
    if (typeof deps.search !== 'function') return toolResult({ ok: false, error: 'search 能力未注入' })
    if (!args || !args.query) return toolResult({ ok: false, error: '缺少 query' })
    const g = ctx.guardPath(args.path == null ? '.' : args.path)
    if (!g.ok) return toolResult({ ok: false, error: g.error })
    const hits = await deps.search({ query: String(args.query), root: g.abs })
    const c = ctx.clip(JSON.stringify(hits))
    return toolResult({ ok: true, data: { query: args.query, hits }, truncated: c.truncated })
  })

  // ── P6-04 symbols（复用现有符号索引）────────────────────────────────────────
  register(READ_TOOL_SPECS[3], async (args, ctx) => {
    if (typeof deps.symbols !== 'function') return toolResult({ ok: false, error: 'symbols 能力未注入' })
    const found = await deps.symbols({ query: args && args.query ? String(args.query) : '' })
    const c = ctx.clip(JSON.stringify(found))
    return toolResult({ ok: true, data: found, truncated: c.truncated })
  })

  // ── P6-05 getDiagnostics（读 P4 的统一 Problem 模型）─────────────────────────
  register(READ_TOOL_SPECS[4], async (args, ctx) => {
    if (typeof deps.problems !== 'function') return toolResult({ ok: false, error: 'problems 能力未注入' })
    const items = await deps.problems({ filter: (args && args.filter) || {} })
    const c = ctx.clip(JSON.stringify(items))
    return toolResult({ ok: true, data: items, truncated: c.truncated })
  })

  // ── P6-06 getRunLog（读最近一次运行结果）────────────────────────────────────
  register(READ_TOOL_SPECS[5], async (args, ctx) => {
    if (typeof deps.runLog !== 'function') return toolResult({ ok: false, error: 'runLog 能力未注入' })
    const r = await deps.runLog()
    const c = ctx.clip(JSON.stringify(r))
    return toolResult({ ok: true, data: r, truncated: c.truncated })
  })

  // ── P6-07 getProjectInfo（读 P2 的单一工程上下文）───────────────────────────
  register(READ_TOOL_SPECS[6], async (args, ctx) => {
    if (typeof deps.projectInfo !== 'function') return toolResult({ ok: false, error: 'projectInfo 能力未注入' })
    const info = await deps.projectInfo()
    const c = ctx.clip(JSON.stringify(info))
    return toolResult({ ok: true, data: info, truncated: c.truncated })
  })

  // ── P14-12 backendStatus ────────────────────────────────────────────────────
  // 只读地表征"后端现在怎么样"：健康、端口、PG/Redis。它是**读**，所以放在只读表里；
  // 真正要 build/run/stop 的话走执行表（`agent-exec-tools.js`，一律经命令表）。
  register(READ_TOOL_SPECS[7], async (_args, ctx) => {
    if (typeof deps.backendStatus !== 'function') return toolResult({ ok: false, error: 'backendStatus 能力未注入' })
    let st = null
    try { st = await deps.backendStatus() } catch (e) { return toolResult({ ok: false, error: String((e && e.message) || e) }) }
    const c = ctx.clip(JSON.stringify(st))
    return toolResult({ ok: true, data: st, truncated: c.truncated })
  })

  return { list, has: (n) => tools.has(n), call, register }
}

module.exports = { toolResult, READ_TOOL_SPECS, createReadOnlyToolRegistry }
