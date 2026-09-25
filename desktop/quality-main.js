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

/** 从哪里找验证产物（默认本目录 desktop/，与验证脚本输出位置一致）*/
function defaultDir() { return __dirname }

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
    try { text = fs.readFileSync(path.join(dir, n), 'utf8') } catch (e) { text = '' }
    sources.push({ name: n, text, file: 'desktop/' + n })
  }

  for (const s of sources) {
    const r = fromDesktopVerify(String(s.text == null ? '' : s.text), {
      name: s.name,
      // P16-11/12：给每条结果挂上"去哪看"——日志文件与可跳转的文件
      file: s.file || null,
    })
    st.put(r)
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
    all: st.list().map((r) => ({ id: r.id, name: r.name, state: r.state, file: r.file || null, passed: r.passed, failed: r.failed })),
    describe: describeQuality(st),
    scannedDir: dir,
    scannedFiles: files.length,
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
