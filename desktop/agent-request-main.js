'use strict'

/**
 * AgentRequest 的接线（Phase 2.1 / P5A-03、P5A-04、P5A-05）
 *
 * 分工（为什么不把契约搬到渲染进程）：
 *   · **渲染侧**才有真实状态 —— 当前文件、选区、问题列表（Problem Model）、上一次运行结果；
 *   · **主进程**才方便 require 本地模块。
 *   所以渲染侧只做「收集」，通过 IPC 交给这里做「校验 + 组装 + 快照」。
 *   这样也避开了把两个 CommonJS 模块改成双环境导出的风险
 *   （P2 踩过：多个模块顶层 `const` 在同一全局作用域里会重复声明报错）。
 *
 * 快照的意义（P5A-05）：开发时能**直接看到 Agent 实际收到了什么**，而不是去猜 prompt。
 */

const {
  createAgentRequest,
  collectAgentInputs,
  buildContextSnapshot,
  describeSnapshot,
} = require('./agent-request')

function registerAgentRequestIpc({ ipcMain, onLog }) {
  const log = typeof onLog === 'function' ? onLog : () => {}
  let lastSnapshot = null

  ipcMain.handle('agent:buildRequest', async (_e, payload = {}) => {
    const incoming = (payload && payload.inputs) || {}
    // 「键不存在」与「键存在但为空」是两回事：前者 = 还没接线，后者 = 本轮无数据。
    const has = (k) => Object.prototype.hasOwnProperty.call(incoming, k)
    const src = (k) => (has(k) ? () => incoming[k] : undefined)
    // 问题可能很多、单条 message 可能很长；在进上下文前先收一下（review 指出无上限）
    const problems = (Array.isArray(incoming.problems) ? incoming.problems.slice(0, 50) : [])
      .map((p) => Object.assign({}, p, { message: String((p && p.message) || '').slice(0, 300) }))

    // 每一项都当作"数据源"；没传的记为 absent，传了但空的记为 empty，抛错的记为 error
    const { inputs, sources } = await collectAgentInputs({
      getContext: src('projectContext'),
      listProblems: has('problems') ? () => problems : undefined,
      getActiveFile: src('activeFile'),
      getSelection: src('selection'),
      getLastRun: src('lastRun'),
      getLastTest: src('lastTest'),
      getRecentFiles: src('recentFiles'),
    })
    inputs.task = payload && payload.message

    const req = createAgentRequest({
      message: payload && payload.message,
      sessionId: payload && payload.sessionId,
      projectContext: inputs.project,
      activeFile: inputs.activeFile,
      selection: inputs.selection,
    })
    if (!req.ok) return { ok: false, errors: req.errors }

    const snapshot = buildContextSnapshot(req, inputs, sources)
    lastSnapshot = snapshot
    const describe = describeSnapshot(snapshot)
    log({ at: 'agent.buildRequest', text: describe })
    return { ok: true, request: req, snapshot, describe }
  })

  ipcMain.handle('agent:lastSnapshot', () => ({
    ok: true,
    snapshot: lastSnapshot,
    describe: lastSnapshot ? describeSnapshot(lastSnapshot) : null,
  }))

  return { getLastSnapshot: () => lastSnapshot }
}

module.exports = { registerAgentRequestIpc }
