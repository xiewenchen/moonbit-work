'use strict'

/**
 * 办公文件 ↔ 项目联动的接线（Phase 2.1 / P13-04 ～ P13-07）
 *
 * 两件事分开：
 *   · 关联表存 `~/.moonbit-work/office-links.json`（**用户目录** —— 它是"我这台机器上
 *     把哪些文件归到哪个项目"，不是项目该带到仓库里的东西）；
 *   · P13-07 的便签**复用** `workbench-main` 的 setNote（便签本来就属于项目，存在工作台里）。
 *
 * 所以这里**不重复实现存储**，只做编排。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  createLinkStore,
  linkFile,
  unlinkFile,
  linksFor,
  projectOf,
  buildOfficePreview,
  toAgentSnippet,
  appendSummaryToNote,
  describeOfficeLink,
} = require('./office-link')

const DIR = path.join(os.homedir(), '.moonbit-work')
const FILE = path.join(DIR, 'office-links.json')

function readStore() {
  try { return createLinkStore(JSON.parse(fs.readFileSync(FILE, 'utf8'))) } catch (e) { return createLinkStore(null) }
}

function writeStore(store) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const tmp = FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(createLinkStore(store), null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, FILE)
    return { ok: true, file: FILE }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function registerOfficeLinkIpc({ ipcMain, onLog, readNote, writeNote }) {
  const log = typeof onLog === 'function' ? onLog : () => {}

  // P13-04：关联 / 解除 / 列表
  ipcMain.handle('office:link', (_e, payload = {}) => {
    const r = linkFile(readStore(), payload, { now: Date.now() })
    if (r.ok !== true) return { ok: false, error: r.error }
    const w = writeStore(r.store)
    log({ at: 'office.link', file: r.link.name, project: r.link.projectRoot })
    return { ok: w.ok === true, error: w.error || null, link: r.link, links: linksFor(r.store, r.link.projectRoot) }
  })

  ipcMain.handle('office:unlink', (_e, { file } = {}) => {
    const r = unlinkFile(readStore(), file)
    if (r.ok !== true) return { ok: false, error: r.error }
    const w = writeStore(r.store)
    return { ok: w.ok === true, error: w.error || null }
  })

  ipcMain.handle('office:links', (_e, { projectRoot } = {}) => {
    const s = readStore()
    return { ok: true, links: linksFor(s, projectRoot), describe: describeOfficeLink(s, projectRoot), file: FILE }
  })

  ipcMain.handle('office:projectOf', (_e, { file } = {}) => ({ ok: true, projectRoot: projectOf(readStore(), file) }))

  // P13-05：预览（复用 relay 已解析出的元信息，不重新解析）
  ipcMain.handle('office:preview', (_e, { meta, kind, file } = {}) => ({ ok: true, preview: buildOfficePreview(meta, { kind, file }) }))

  // P13-06：做成 Agent 输入片段
  ipcMain.handle('office:toAgent', (_e, payload = {}) => {
    const s = readStore()
    const linked = projectOf(s, payload.file)
    const r = toAgentSnippet(Object.assign({}, payload, { projectRoot: payload.projectRoot || linked }), { now: Date.now() })
    log({ at: 'office.toAgent', file: payload.file, hasBody: r.hasBody })
    return r
  })

  // P13-07：结论追加到项目便签（**复用** workbench 的便签存储）
  ipcMain.handle('office:summaryToNote', (_e, { projectRoot, summary, title } = {}) => {
    if (!projectRoot) return { ok: false, error: '缺少 projectRoot' }
    const cur = typeof readNote === 'function' ? readNote(projectRoot) : ''
    const r = appendSummaryToNote(cur, summary, { title, now: Date.now() })
    if (r.ok !== true) return r
    if (typeof writeNote !== 'function') return { ok: false, error: '便签写入能力未注入' }
    const w = writeNote(projectRoot, r.note)
    log({ at: 'office.summaryToNote', project: projectRoot, ok: w && w.ok === true })
    return { ok: !!(w && w.ok === true), error: (w && w.error) || null, note: r.note }
  })

  return { readStore, writeStore, FILE }
}

module.exports = { registerOfficeLinkIpc, readStore, writeStore, FILE }
