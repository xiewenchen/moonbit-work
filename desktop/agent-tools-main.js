'use strict'

/**
 * 只读工具的真实接线（Phase 2 / P6 接线段）
 *
 * `agent-tools.js` 是纯逻辑（工具定义 + 沙箱），这里只做两件事：
 *   ① 注入真实实现（fs / 搜索 / 符号索引 / 问题模型 / 运行结果 / 项目识别）；
 *   ② 暴露 IPC，让渲染侧与（将来的）Agent 能调。
 *
 * **关于 workspace 根**（安全关键）：它由渲染侧**显式设置**（用户在打开项目时告知），
 * 主进程保存后工具只认它。Agent **无法**设置它 —— 它只能调 `agentTools:call`。
 * 若让调用方每次传 root，沙箱就被绕过了（传任意路径即可）。
 */

const fs = require('fs')
const path = require('path')
const fsops = require('./fsops')
const { searchInDir } = require('./search')
const { loadSymbols, searchSymbols } = require('./symbols')
const { detectProject } = require('./project-detect')
const { createReadOnlyToolRegistry } = require('./agent-tools')
const { createQualityStore, fromDesktopVerify, overall, canProceed, describeQuality } = require('./quality-result')
const { createExecuteToolRegistry, API_LIMITS } = require('./agent-exec-tools')
const http = require('http')
const https = require('https')

/** 极简 HTTP 请求（带响应体上限）—— 供 apiRequest / health 工具用 */
function simpleRequest({ url, method = 'GET', headers = {}, body = '', timeoutMs = 15000, maxBodyBytes = API_LIMITS.maxResponseBytes }) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      resolve({ ok: false, error: 'URL 非法：' + String((e && e.message) || e) })
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      let data = ''
      let truncated = false
      res.on('data', (chunk) => {
        if (data.length >= maxBodyBytes) { truncated = true; return }
        data += chunk.toString('utf8')
        if (data.length > maxBodyBytes) { data = data.slice(0, maxBodyBytes); truncated = true }
      })
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, headers: res.headers, body: data, truncated }))
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时（' + timeoutMs + 'ms）')) })
    req.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }))
    if (body) req.write(body)
    req.end()
  })
}

function registerAgentToolIpc({ ipcMain, getWindow, getRunner, executeCommand, backendStatus }) {
  let workspace = ''

  /**
   * 工具用的 workspace 根：**只认「被显式设置过」的那个**，没设过就返回空串。
   * 空串会让路径沙箱直接回「未打开项目」—— 这是刻意的：
   * 之前写成 `workspace || DEFAULT_CWD`，结果「关闭项目后仍能读启动目录」（实测抓到）。
   * 安全上宁可“没打开项目时工具全废”，也不要“默默退到某个目录”。
   */
  const rootOf = () => workspace

  const registry = createReadOnlyToolRegistry({
    rootOf,
    // 符号链接复核：workspace 里指向外部的链接要被挡住
    realpath: (p) => fs.realpathSync(p),

    readFile: async (abs) => {
      const r = fsops.readTextFile(abs)          // 形状：{ path, content, language }
      return r && typeof r.content === 'string' ? r.content : ''
    },

    listDir: async (abs) => {
      if (!fs.existsSync(abs)) return null       // 让工具报"目录不存在"
      return fsops.listDir(abs)                  // [{ name, path, dir }]
    },

    search: async ({ query, root }) => {
      const r = searchInDir(root, query, { maxResults: 200 })
      return { results: r.results, scanned: r.scanned, truncated: r.truncated }
    },

    symbols: async ({ query }) => {
      const all = loadSymbols(rootOf())          // 不存在 → []
      if (!all.length) return { symbols: [], note: '没有 symbols.jsonl（可用 IDE 的符号索引生成）' }
      const hit = query ? searchSymbols(all, query, 50) : all.slice(0, 200)
      return { symbols: hit, total: all.length }
    },

    // 问题模型住在渲染侧（P4 的 Store 在浏览器里）；主进程通过它对外暴露的只读接口取。
    // 这是一处刻意的"跨进程取值"：问题状态本来就是渲染侧算出来的。
    problems: async () => {
      const w = getWindow && getWindow()
      if (!w || w.isDestroyed()) return []
      try {
        const raw = await w.webContents.executeJavaScript(
          'JSON.stringify((window.moonbitIDE && window.moonbitIDE.problems) ? window.moonbitIDE.problems.list() : [])')
        return JSON.parse(raw || '[]')
      } catch (e) {
        return { error: '读取问题模型失败：' + String((e && e.message) || e) }
      }
    },

    runLog: async () => {
      const r = getRunner && getRunner()
      return r ? { state: r.state, result: r.result || null } : null
    },

    projectInfo: async () => detectProject(rootOf()),

    // P14-12：后端状态（健康/端口/PG/Redis）—— 只读；未注入时该工具会直接报“能力未注入”
    backendStatus: typeof backendStatus === 'function' ? () => backendStatus() : undefined,

    // P16-13：工程状态（Quality Center）。
    // **从已有的验证产物聚合**（desktop/*-result.txt），不重跑任何测试 ——
    // 所以它能秒回、能离线用。“没跑过”会被如实标成 NOT_RUN。
    qualitySnapshot: async () => {
      const st = createQualityStore()
      let files = []
      try {
        files = fs.readdirSync(__dirname).filter((n) => n.endsWith('-result.txt'))
      } catch (e) {
        files = []
      }
      for (const n of files) {
        let text = ''
        try { text = fs.readFileSync(path.join(__dirname, n), 'utf8') } catch (e) { text = '' }
        st.put(fromDesktopVerify(text, { name: n }))
      }
      return {
        overall: overall(st),
        canProceed: canProceed(st),
        stats: st.stats(),
        failures: st.failures().map((r) => ({ name: r.name, state: r.state, detail: r.detail.slice(0, 200) })),
        describe: describeQuality(st),
      }
    },
  })

  ipcMain.handle('agentTools:setWorkspace', (_e, root) => {
    const r = String(root == null ? '' : root).trim()
    if (!r) {
      workspace = ''
      return { ok: true, workspace: '' }
    }
    if (!fs.existsSync(r)) return { ok: false, error: '目录不存在：' + r }
    workspace = r
    return { ok: true, workspace }
  })

  ipcMain.handle('agentTools:getWorkspace', () => ({ ok: true, workspace: rootOf() }))
  ipcMain.handle('agentTools:list', () => ({ ok: true, tools: registry.list() }))
  ipcMain.handle('agentTools:call', (_e, payload = {}) =>
    registry.call(payload.name, payload.args || {}))

  // ── P7 执行工具：**一律经命令表**（P7-01），不自己 spawn ──────────────────────
  const execRegistry = createExecuteToolRegistry({
    executeCommand: (name, args, opts) => {
      if (typeof executeCommand !== 'function') throw new Error('命令表未就绪')
      return executeCommand(name, args, opts)
    },
    request: simpleRequest,
    runLog: async () => {
      const r = getRunner && getRunner()
      return r ? { state: r.state, result: r.result || null } : null
    },
  })
  ipcMain.handle('agentTools:execList', () => ({ ok: true, tools: execRegistry.list() }))
  ipcMain.handle('agentTools:execCall', (_e, payload = {}) =>
    execRegistry.call(payload.name, payload.args || {}))
  ipcMain.handle('agentTools:execAudit', () => ({ ok: true, audit: execRegistry.audit(), budget: execRegistry.budget() }))

  return { read: registry, exec: execRegistry, getWorkspace: () => workspace }
}

module.exports = { registerAgentToolIpc, simpleRequest }
