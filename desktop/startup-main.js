'use strict'

/**
 * 启动恢复 + 环境检查的接线（Phase 2.1 / P20-07、P20-08、P20-09）
 *
 * · 快照存 `~/.moonbit-work/startup.json`（用户目录 —— "我这台机器上次开到哪儿了"，
 *   不是项目该带到仓库里的东西）；
 * · 环境检查用 `spawnSync` 探每个工具的 `--version`：**探不到就如实说探不到**。
 *
 * 一个容易忘的点：**正常退出时必须 markCleanExit()**。忘了这一步，下次启动就会
 * 被判成"异常退出"并降级恢复 —— 用户会以为"我的标签为什么没恢复"。
 * 所以这里注册了 app 的退出钩子。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  createSnapshot,
  sanitizeSnapshot,
  markRunning,
  markCleanExit,
  updateSnapshot,
  planStartup,
  checkEnvironment,
  describeStartup,
} = require('./startup-state')

const DIR = path.join(os.homedir(), '.moonbit-work')
const FILE = path.join(DIR, 'startup.json')

/** 探一个命令的版本；探不到返回 {found:false}，抛错则带上 error（与"没装"分开） */
function probeCommand(bin, args) {
  return () => {
    let r = null
    try {
      r = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' })
    } catch (e) {
      return { found: false, error: String((e && e.message) || e) }
    }
    if (!r || r.error) return { found: false, error: String((r && r.error && r.error.message) || 'spawn 失败') }
    const out = String((r.stdout || '') + (r.stderr || '')).trim()
    // Windows 上找不到命令会给 code 1 且输出本地化文案 —— 用"有没有可读版本号"来判断更稳
    const m = /(\d+\.\d+(?:\.\d+)?(?:[-.\w+]*))/.exec(out)
    if (r.status === 0 || m) return { found: true, version: m ? m[1] : out.slice(0, 40) }
    // 输出很短又不像版本号 → 当作"没装"（与 error 区分：这里不抛）
    if (out && out.length < 200 && !/version|v\d/i.test(out)) return { found: false }
    return { found: false, error: out.slice(0, 120) || '没有可读输出' }
  }
}

/** 五项各自的探测方式 */
function defaultProbes(extra = {}) {
  return {
    moon: probeCommand('moon', ['version']),
    node: () => ({ found: true, version: process.versions.node }),
    git: probeCommand('git', ['--version']),
    docker: probeCommand('docker', ['--version']),
    agent: typeof extra.agentProbe === 'function' ? extra.agentProbe : () => ({ found: false }),
  }
}

function registerStartupIpc({ ipcMain, onLog, probes }) {
  const log = typeof onLog === 'function' ? onLog : () => {}
  let cache = null

  function readSnapshot() {
    try { return sanitizeSnapshot(JSON.parse(fs.readFileSync(FILE, 'utf8'))) } catch (e) { return createSnapshot({}) }
  }
  function writeSnapshot(snap) {
    try {
      fs.mkdirSync(DIR, { recursive: true })
      const tmp = FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, FILE)
      return { ok: true, file: FILE }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  ipcMain.handle('startup:plan', () => {
    const snap = readSnapshot()
    const plan = planStartup(snap)
    log({ at: 'startup.plan', reason: plan.reason, crashed: plan.crashed })
    return { ok: true, plan, snapshot: snap }
  })

  ipcMain.handle('startup:markRunning', () => {
    const w = writeSnapshot(markRunning(readSnapshot(), { now: Date.now() }))
    return { ok: w.ok === true, error: w.error || null }
  })

  ipcMain.handle('startup:markCleanExit', () => {
    const w = writeSnapshot(markCleanExit(readSnapshot(), { now: Date.now() }))
    log({ at: 'startup.markCleanExit', ok: w.ok === true })
    return { ok: w.ok === true, error: w.error || null }
  })

  ipcMain.handle('startup:update', (_e, patch = {}) => {
    const w = writeSnapshot(updateSnapshot(readSnapshot(), patch, { now: Date.now() }))
    return { ok: w.ok === true, error: w.error || null }
  })

  ipcMain.handle('startup:file', () => {
    const s = readSnapshot()
    return { ok: true, file: FILE, keys: Object.keys(s).sort(), snapshot: s }
  })

  // P20-09
  ipcMain.handle('env:check', async (_e, opts = {}) => {
    const ps = probes && typeof probes === 'object' ? probes : defaultProbes()
    const probe = async (id) => {
      const fn = ps[id]
      if (typeof fn !== 'function') return { found: false, error: '没有这个检查项的探测方式' }
      return await fn()
    }
    const r = await checkEnvironment(probe)
    cache = r
    log({ at: 'env.check', ok: r.ok, missing: r.missingCount, errored: r.errorCount })
    return { ok: true, env: r, describe: describeStartup(planStartup(readSnapshot()), r) }
  })
  ipcMain.handle('env:last', () => ({ ok: true, env: cache }))

  /** 给主进程用：启动时标记 running、退出时标记 cleanExit */
  return {
    readSnapshot, writeSnapshot,
    markRunningNow: () => writeSnapshot(markRunning(readSnapshot(), { now: Date.now() })),
    markCleanExitNow: () => { const w = writeSnapshot(markCleanExit(readSnapshot(), { now: Date.now() })); log({ at: 'app.exit', ok: w.ok === true }); return w },
  }
}

module.exports = { registerStartupIpc, defaultProbes, probeCommand, FILE }
