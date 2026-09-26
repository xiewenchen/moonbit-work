'use strict'

/**
 * Quality Center 的接线（Phase 2.1 / P16-10～12）
 *
 * 把"工程状态"的聚合**收成唯一实现**：IPC 与 Agent 的 `qualityStatus` 工具共用同一个
 * `snapshotQuality()` —— 上一批 `agent-tools-main.js` 里已经有一份聚合，这次提出来，
 * 免得两处各写一遍再漂移（P14 那次就是这么出问题的）。
 *
 * 仍然**不重跑任何测试**：只读 `desktop/*-result.txt` 这类已有产物。
 */

const fs = require('fs')
const path = require('path')
const {
  createQualityStore,
  fromDesktopVerify,
  overall,
  canProceed,
  describeQuality,
  QUALITY_STATE,
} = require('./quality-result')
// PH3-Q：事实层（溯源 / 新鲜度 / STALE / 退化检测）。
// 渐进：**不改** quality-result.js，而是新层包住旧层 —— 旧字段全部保留。
const { createFactSnapshot, withProvenance, describeFact, VERIFY_ORIGIN } = require('./quality-fact')

/** 从哪里找验证产物（默认本目录 desktop/，与验证脚本输出位置一致）*/
function defaultDir() { return __dirname }

/**
 * PH3-Q-03：这份产物是**什么时候**跑出来的。
 * 依据用**文件的 mtime** —— 这是磁盘上的真实事实，不是我们猜的。
 * 拿不到就返回 null（于是新鲜度会是 unknown，而不是假装"刚跑过"）。
 */
function verifiedAtOf(fullPath) {
  try { return fs.statSync(fullPath).mtimeMs } catch (_) { return null }
}

/**
 * PH3-Q-06：当前 commit（读 .git/HEAD，纯 fs，不起进程；拿不到就 null）。
 * worktree 里 HEAD 可能是 `ref: refs/heads/xxx`，要再读一次那个 ref。
 */
function currentCommit(dir) {
  try {
    let head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref:')) {
      head = fs.readFileSync(path.join(dir, '.git', head.slice(4).trim()), 'utf8').trim()
    }
    return /^[0-9a-f]{7,40}$/.test(head) ? head.slice(0, 8) : null
  } catch (_) { return null }
}

/** 运行环境（PH3-Q-05 里"在哪个环境"）。 */
function currentEnv() {
  const p = process.platform
  if (p === 'win32') return 'windows'
  if (p === 'darwin') return 'mac'
  if (p === 'linux') return 'linux'
  return 'unknown'
}

/**
 * 聚合一份工程状态快照。
 * @param {{dir?: string, sources?: Array<{name:string, text:string, file?:string}>}} [opts]
 */
function snapshotQuality(opts = {}) {
  const dir = opts.dir || defaultDir()
  const st = createQualityStore()

  // 显式传入的来源优先（测试/调用方可以直接喂文本）
  const sources = Array.isArray(opts.sources) ? opts.sources.slice() : []
  let files = []
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('-result.txt')).sort() } catch (e) { files = [] }
  for (const n of files) {
    let text = ''
    const full = path.join(dir, n)
    try { text = fs.readFileSync(full, 'utf8') } catch (e) { text = '' }
    // PH3-Q：顺手把"什么时候跑的"带上 —— 用文件 mtime（真实事实），拿不到就是 null
    sources.push({ name: n, text, file: 'desktop/' + n, verifiedAt: verifiedAtOf(full) })
  }

  const commit = currentCommit(path.resolve(dir, '..'))
  const env = currentEnv()
  for (const s of sources) {
    const base = fromDesktopVerify(String(s.text == null ? '' : s.text), {
      name: s.name,
      // P16-11/12：给每条结果挂上"去哪看"——日志文件与可跳转的文件
      file: s.file || null,
      // PH3-Q-03：能查到就带上（查不到就是 null，不编一个时间）
      verifiedAt: Number.isFinite(s.verifiedAt) ? s.verifiedAt : null,
    })
    // PH3-Q-05：谁跑的 / 什么时候 / 用什么命令 / 在什么环境 / 哪个 commit。
    //   desktop/*-result.txt 是本地跑 verify 脚本产出的 → origin 记 LOCAL（不是 CI）。
    //   工具链命令我们并不知道（结果里没记），所以 command 留 null，不编。
    st.put(withProvenance(base, {
      at: Number.isFinite(s.verifiedAt) ? s.verifiedAt : null,
      origin: s.origin || VERIFY_ORIGIN.LOCAL,
      command: s.command == null ? null : s.command,
      env,
      commit,
    }))
  }

  const failures = st.failures()
  return {
    overall: overall(st),
    canProceed: canProceed(st),
    stats: st.stats(),
    // 失败项带足够的定位信息：P16-11 跳日志（detail/file）、P16-12 跳文件（file）
    failures: failures.map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state,
      detail: r.detail.slice(0, 300),
      file: r.file || null,
      line: r.line == null ? null : r.line,
      source: r.source,
    })),
    all: st.list().map((r) => ({
      id: r.id, name: r.name, state: r.state, file: r.file || null, passed: r.passed, failed: r.failed,
      // PH3-Q：能查到就带上，查不到就是 null
      verifiedAt: Number.isFinite(r.verifiedAt) ? r.verifiedAt : null,
      provenance: r.provenance || null,
    })),
    describe: describeQuality(st),
    scannedDir: dir,
    scannedFiles: files.length,
    // PH3-Q-01：事实快照（结果 + 环境 + 来源 + 时间 + commit，且已把过期的 PASS 标成 STALE）。
    // 旧字段全部保留 —— 这是"加一层"，不是"换一套"。
    fact: (() => {
      const f = createFactSnapshot({
        project: path.resolve(dir, '..'),
        results: st.list(),
        environment: env,
        origin: VERIFY_ORIGIN.LOCAL,
        commit,
      })
      return {
        project: f.project, timestamp: f.timestamp, environment: f.environment,
        origin: f.origin, commit: f.commit, overall: f.overall,
        canProceed: f.canProceed, staleCount: f.staleCount,
        describe: describeFact(f),
      }
    })(),
  }
}

function registerQualityIpc({ ipcMain, onLog }) {
  const log = typeof onLog === 'function' ? onLog : () => {}

  ipcMain.handle('quality:snapshot', (_e, opts = {}) => {
    const snap = snapshotQuality(opts)
    log({ at: 'quality.snapshot', overall: snap.overall, files: snap.scannedFiles, failures: snap.failures.length })
    return { ok: true, snapshot: snap }
  })

  /** 取某条结果对应的日志原文（P16-11：点失败项看日志）*/
  ipcMain.handle('quality:log', (_e, { file } = {}) => {
    const rel = String(file || '')
    // 只允许读 desktop/ 下的 *-result.txt —— 不给"读任意文件"的口子
    const base = path.basename(rel)
    if (!/^[A-Za-z0-9_.-]+-result\.txt$/.test(base)) return { ok: false, error: '不是允许的验证产物：' + rel }
    const full = path.join(defaultDir(), base)
    if (path.dirname(path.resolve(full)) !== path.resolve(defaultDir())) return { ok: false, error: '路径越界' }
    try {
      const text = fs.readFileSync(full, 'utf8')
      return { ok: true, file: 'desktop/' + base, text: text.slice(0, 20000), truncated: text.length > 20000 }
    } catch (e) {
      return { ok: false, error: '读不到：' + String((e && e.message) || e) }
    }
  })

  return { snapshotQuality }
}

module.exports = { registerQualityIpc, snapshotQuality, QUALITY_STATE }
