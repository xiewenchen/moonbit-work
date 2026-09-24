'use strict'

/**
 * 验证闭环的接线（Phase 2 / P9 接线段）
 *
 * 流程边界（很重要）：
 *   **改文件仍然要用户点确认**（走 P8 的 propose → Apply）——
 *   闭环本身**没有**"自动改文件"的能力，它只负责：改完之后自动证明没改坏。
 *
 *   用户点 Apply  → 文件已落盘 → 自动跑 check → test → run → health → 出报告
 *
 * 四步的真实实现：
 *   check  → `moon check --target native`（文本交给 P4 的 fromCompilerOutput 解析）
 *   test   → 命令表 project.test（P3：与 UI 走同一条路）
 *   run    → 命令表 project.run
 *   health → 对 run 出来的 URL 发一次请求（复用 agent-tools-main 的 simpleRequest）
 */

const { createVerifyLoop, buildVerifyReport, renderVerifyReport } = require('./agent-verify')
const { fromCompilerOutput } = require('./problem-model')

function registerAgentVerifyIpc({ ipcMain, getWindow, getRunner, runCommand, executeCommand, getWorkspace, request }) {
  let lastSession = null
  let lastReport = null

  const send = (ch, payload) => {
    const w = getWindow && getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload)
  }

  async function runCheck(root) {
    const r = await runCommand({ bin: 'moon', args: ['check', '--target', 'native'], cwd: root })
    const output = String((r && (r.stdout || r.stderr)) || '')
    // 退出码 0 = 通过；非 0 时把文本解析成问题（复用 P4 的解析器）
    const problems = r && r.code === 0 ? [] : fromCompilerOutput(output)
    return {
      ok: !!(r && r.code === 0),
      error: r && r.code === 0 ? null : 'moon check 未通过（退出码 ' + (r ? r.code : '?') + '）',
      output,
      problems,
    }
  }

  async function runTest() {
    if (typeof executeCommand !== 'function') return { ok: false, error: '命令表未就绪' }
    const r = await executeCommand('project.test', {}, {})
    return { ok: r && r.ok === true, error: r && r.error ? r.error : null, output: (r && r.stdout) || '', name: 'project.test' }
  }

  async function startRun() {
    if (typeof executeCommand !== 'function') return { ok: false, error: '命令表未就绪' }
    const r = await executeCommand('project.run', {}, {})
    return { ok: r && r.ok === true, error: r && r.error ? r.error : null, detail: r && r.data ? r.data : null }
  }

  async function healthCheck() {
    const runner = getRunner && getRunner()
    const url = runner && runner.result && runner.result.url
    if (!url) return { ok: false, error: '没有拿到运行地址（服务可能还没就绪）', url: null }
    if (typeof request !== 'function') return { ok: false, error: 'request 能力未注入', url }
    const r = await request({ url, method: 'GET', timeoutMs: 5000 })
    return { ok: !!(r && r.ok), error: r && r.ok ? null : String((r && r.error) || ('HTTP ' + (r && r.status))), url, status: r && r.status }
  }

  ipcMain.handle('agentVerify:run', async (_e, { file } = {}) => {
    const root = typeof getWorkspace === 'function' ? getWorkspace() : ''
    if (!root) return { ok: false, error: '未打开项目' }

    send('agentVerify:progress', { phase: 'start', file: file || null })
    // 闭环本身**不自动修**（fix 需要模型提议，等 Ask/Understand 接上再给）；
    // 所以这里 maxRounds=1：跑一遍、如实报告。
    const loop = createVerifyLoop({ maxRounds: 1 })
    const session = await loop.run({
      // 修改已由用户在 P8 的对话框里确认并落盘 —— 这里不重复写文件
      patch: { file: file || '(已确认的修改)' },
      deps: {
        applyPatch: async () => ({ ok: true, file: file || null }),
        check: () => runCheck(root),
        test: () => runTest(),
        run: () => startRun(),
        health: () => healthCheck(),
        onProgress: (p) => send('agentVerify:progress', p),
      },
    })

    // 跑失败就停掉服务（别留着它）
    if (session && !session.ok) {
      try {
        if (typeof executeCommand === 'function') await executeCommand('project.stop', {}, {})
      } catch (e) {
        // 停不掉不影响验证结论
        send('agentVerify:progress', { phase: 'stop-failed', error: String((e && e.message) || e) })
      }
    }

    lastSession = session
    lastReport = buildVerifyReport(session)
    const text = renderVerifyReport(lastReport)
    send('agentVerify:done', { ok: lastReport.ok, report: lastReport, text })
    return { ok: true, verified: lastReport.ok, report: lastReport, text }
  })

  ipcMain.handle('agentVerify:last', () => ({ ok: true, report: lastReport }))

  return { lastReport: () => lastReport, lastSession: () => lastSession }
}

module.exports = { registerAgentVerifyIpc }
