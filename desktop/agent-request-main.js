'use strict'

/**
 * Agent 请求/理解的接线（Phase 2.1 / P5A-01～05 + P9A-01～05）
 *
 * 分工（为什么不把契约搬到渲染进程）：
 *   · **渲染侧**才有真实状态 —— 当前文件、选区、问题列表、上一次运行结果；
 *   · **主进程**才方便 require 本地模块。
 *   所以渲染侧只做「收集」，通过 IPC 交给这里做「校验 + 组装 + 快照 + 理解」。
 *   这样也避开了把 CommonJS 模块改成双环境导出的风险
 *   （P2 踩过：多个模块顶层 `const` 在同一全局作用域里会重复声明报错）。
 */

const fs = require('fs')
const path = require('path')
const {
  createAgentRequest,
  collectAgentInputs,
  buildContextSnapshot,
  describeSnapshot,
} = require('./agent-request')
const { buildTaskUnderstanding, describeUnderstanding } = require('./task-understanding')

function registerAgentRequestIpc({ ipcMain, onLog, getWorkspace, getWindow }) {
  const log = typeof onLog === 'function' ? onLog : () => {}
  const workspace = () => (typeof getWorkspace === 'function' ? (getWorkspace() || '') : '')
  // PH3-IDE-12/13：发通知要拿窗口来推事件回去。没注入时**如实报错**，不静默不弹。
  const win = () => (typeof getWindow === 'function' ? getWindow() : null)
  let lastSnapshot = null
  let lastUnderstanding = null

  /**
   * 从渲染侧 payload 组装出 request + inputs。
   * `buildRequest` 与 `understand` 共用同一段 —— 不给"理解"另开一条取数路径（否则两边会不一致）。
   */
  async function assemble(payload = {}) {
    const incoming = (payload && payload.inputs) || {}
    // 「键不存在」与「键存在但为空」是两回事：前者 = 还没接线，后者 = 本轮无数据。
    const has = (k) => Object.prototype.hasOwnProperty.call(incoming, k)
    const src = (k) => (has(k) ? () => incoming[k] : undefined)
    // 问题可能很多、单条 message 可能很长；在进上下文前先收一下
    const problems = (Array.isArray(incoming.problems) ? incoming.problems.slice(0, 50) : [])
      .map((p) => Object.assign({}, p, { message: String((p && p.message) || '').slice(0, 300) }))

    const { inputs, sources } = await collectAgentInputs({
      getContext: src('projectContext'),
      listProblems: has('problems') ? () => problems : undefined,
      getActiveFile: src('activeFile'),
      getSelection: src('selection'),
      // PH3-IDE-03/04/05：用户指着的那条问题（由渲染侧点亮某条时传入）
      getFocusProblem: src('focusProblem'),
      getLastRun: src('lastRun'),
      getLastTest: src('lastTest'),
      getRecentFiles: src('recentFiles'),
    })
    inputs.task = payload && payload.message
    // 决策用的策略（Auto-start / Confirm-first）也一并带上，供 understanding 的 constraints 使用
    inputs.policy = (payload && payload.policy) || {}

    const request = createAgentRequest({
      message: payload && payload.message,
      sessionId: payload && payload.sessionId,
      projectContext: inputs.project,
      activeFile: inputs.activeFile,
      selection: inputs.selection,
      focusProblem: inputs.focusProblem,   // PH3-IDE-03：面向前端一条问题的提问
    })
    if (!request.ok) return { ok: false, errors: request.errors }
    return { ok: true, request, inputs, sources }
  }

  /**
   * PH3-IDE-12/13：Agent 任务完成/失败的通知。
   * ⚠️ 通知本身是“告知”，不是“结果” —— 所以它**只带一个可点的入口**
   *    （点回去看到的是真实的 Problem/会话），不在通知里渲染结论。
   */
  ipcMain.handle('agent:notify', async (_e, payload = {}) => {
    const p = payload || {}
    const w = win()
    if (!w || (w.isDestroyed && w.isDestroyed())) return { ok: false, error: '没有窗口（getWindow 未注入或窗口已关）' }
    let notified = false
    try {
      const { Notification } = require('electron')
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        const s = { title: String(p.title || 'MoonBit Work'), body: String(p.body || '').slice(0, 200) }
        if (p.file) s.body = s.body + '\n' + String(p.file)
        const n = new Notification(s)
        // 点通知 → 让窗口回到前台（**不一定**跳文件：跳转由真实的 Problem 路径决定）
        n.on('click', () => { try { if (w.show) w.show(); if (w.focus) w.focus() } catch (_) { /* 聚焦失败不影响通知本身 */ } })
        n.show()
        notified = true
      }
    } catch (e) { notified = false }
    // 无论系统通知能不能弹，都把事件推回渲染侧（让它能高亮那条问题）
    try { w.webContents.send('agent:notified', { ok: notified, kind: p.kind || null, file: p.file || null }) } catch (_) { /* 推不回也不抛 */ }
    return { ok: true, notified, supported: notified }
  })

  ipcMain.handle('agent:buildRequest', async (_e, payload = {}) => {
    const a = await assemble(payload)
    if (!a.ok) return { ok: false, errors: a.errors }
    const snapshot = buildContextSnapshot(a.request, a.inputs, a.sources)
    lastSnapshot = snapshot
    const describe = describeSnapshot(snapshot)
    log({ at: 'agent.buildRequest', text: describe })
    return { ok: true, request: a.request, snapshot, describe }
  })

  /**
   * P9A：产出**可验证的**任务理解（不是展示思维链）。
   *
   * relevantFiles 里的路径会用 workspace 做一次**存在性**过滤 —— 只在真实工作区里认路径，
   * 免得把 `/users` 这种 URL 片段当成文件。无工作区时不过滤（宁可多列也不假装知道）。
   */
  ipcMain.handle('agent:understand', async (_e, payload = {}) => {
    const a = await assemble(payload)
    if (!a.ok) return { ok: false, errors: a.errors }
    const root = workspace()
    const understanding = buildTaskUnderstanding(a.request, a.inputs, {
      // ⚠️ 必须限制在 workspace 内：`extractPathLike` 的字符集含 `.` 与 `/`，
      // 用户消息里写 `../../foo` 会形成 `..` 段逃出去 —— 那样这个
      // “存在性判断”就成了探测 root 之外任意路径的手段（review 指出），
      // 也与 task-understanding 里“workspace 之外一律拒绝”的说明矛盾。
      exists: (rel) => {
        if (!root) return true                      // 无工作区时不做存在性过滤
        const abs = path.resolve(root, rel)
        const relToRoot = path.relative(root, abs)
        if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return false
        return fs.existsSync(abs)
      },
      policy: a.inputs.policy,
    })
    lastUnderstanding = understanding
    const describe = describeUnderstanding(understanding)
    log({ at: 'agent.understand', text: describe })
    return { ok: true, understanding, describe }
  })

  ipcMain.handle('agent:lastSnapshot', () => ({
    ok: true,
    snapshot: lastSnapshot,
    describe: lastSnapshot ? describeSnapshot(lastSnapshot) : null,
  }))

  ipcMain.handle('agent:lastUnderstanding', () => ({
    ok: true,
    understanding: lastUnderstanding,
    describe: lastUnderstanding ? describeUnderstanding(lastUnderstanding) : null,
  }))

  return {
    getLastSnapshot: () => lastSnapshot,
    getLastUnderstanding: () => lastUnderstanding,
  }
}

module.exports = { registerAgentRequestIpc }
