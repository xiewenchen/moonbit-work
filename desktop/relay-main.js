// 文件中转站（主进程侧）—— 备份 / 版本历史 / 还原 / 目录监控 / Office 元信息
//
// 设计（用户定的）：
//   · 监控范围：IDE 内打开保存过的文件 + 用户指定的文件夹
//   · 备份位置：~/.moonbit-backups/
//   · 是否备份由用户按按钮决定（不做自动打分）
//   · 解析 Office 元信息（docx/xlsx/pptx 本质是 zip + XML，读 docProps/core.xml）
//
// 文件布局：~/.moonbit-backups/<路径哈希>/
//   index.json                                  —— 记录原路径与版本列表
//   <时间戳>__<内容哈希>__<原文件名>            —— 每个版本的实际内容
// 这样「同一路径」的历次版本聚在一个目录里，且内容相同的版本不会重复存。
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

const BACKUP_ROOT = path.join(os.homedir(), '.moonbit-backups')
const OFFICE_RE = /\.(docx?|xlsx?|pptx?|pdf|wps|et|dps|odt|ods|odp)$/i
const MAX_VERSIONS = 50          // 单个文件最多留多少个版本
const WATCH_DEBOUNCE = 1200      // 文件连续写入时的防抖（Office 保存会触发多次事件）

const sha1 = (v) => crypto.createHash('sha1').update(v).digest('hex')

function ensureRoot() {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true })
  return BACKUP_ROOT
}
function dirOf(p) {
  return path.join(BACKUP_ROOT, sha1(path.resolve(p)).slice(0, 16))
}
function readIndex(p) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(p), 'index.json'), 'utf8'))
  } catch (_) {
    return { src: path.resolve(p), name: path.basename(p), versions: [] }
  }
}
function writeIndex(p, idx) {
  const d = dirOf(p)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(idx, null, 2), 'utf8')
}

// ── ZIP 里取一个文件的内容（Office 文档都是这个格式）────────────────────
// 只做最小实现：定位中央目录 → 取目标条目的 local header → inflateRaw。
// 足够读 docProps/core.xml 这种小文件，不追求支持 zip64/加密。
function readZipEntry(buf, want) {
  // End of Central Directory：签名 0x06054b50，从尾部往前找
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    if (name === want) {
      // local header：签名 0x04034b50，名字与 extra 长度可能和中央目录不同，要重新读
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) return null
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const start = localOff + 30 + lNameLen + lExtraLen
      const data = buf.slice(start, start + compSize)
      try {
        return method === 0 ? data : zlib.inflateRawSync(data)
      } catch (_) {
        return null
      }
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return null
}

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  if (!m) return ''
  return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
}

// 读出 Office 文档的标题/作者等（读不到就返回 null，不影响备份功能）
function readOfficeMeta(file) {
  if (!/\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(file)) return null
  let buf
  try { buf = fs.readFileSync(file) } catch (_) { return null }
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return null   // "PK"
  const core = readZipEntry(buf, 'docProps/core.xml')
  const app = readZipEntry(buf, 'docProps/app.xml')
  const meta = {}
  if (core) {
    const x = core.toString('utf8')
    meta.title = xmlTag(x, 'dc:title')
    meta.creator = xmlTag(x, 'dc:creator')
    meta.modifiedBy = xmlTag(x, 'cp:lastModifiedBy')
    meta.created = xmlTag(x, 'dcterms:created')
    meta.modified = xmlTag(x, 'dcterms:modified')
  }
  if (app) {
    const x = app.toString('utf8')
    meta.pages = xmlTag(x, 'Pages')
    meta.words = xmlTag(x, 'Words')
    meta.sheets = xmlTag(x, 'Worksheets')
    meta.slides = xmlTag(x, 'Slides')
  }
  return Object.keys(meta).length ? meta : null
}

// ── 备份 ─────────────────────────────────────────────────────────────────
function backupFile(src, note) {
  ensureRoot()
  const abs = path.resolve(src)
  let st
  try { st = fs.statSync(abs) } catch (_) { return { ok: false, error: '文件不存在或不可读' } }
  if (!st.isFile()) return { ok: false, error: '不是普通文件' }

  const buf = fs.readFileSync(abs)
  const contentHash = sha1(buf).slice(0, 16)
  const idx = readIndex(abs)

  // 内容没变就跳过（避免同一内容存一堆）—— 但仍告知用户
  const dup = idx.versions.find((v) => v.contentHash === contentHash)
  if (dup) {
    return { ok: true, skipped: true, reason: '内容与已有版本相同，未重复备份', version: dup, index: idx }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = dirOf(abs)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `${stamp}__${contentHash}__${path.basename(abs)}`
  fs.writeFileSync(path.join(dir, fileName), buf)

  const ver = {
    stamp,
    file: fileName,
    contentHash,
    size: buf.length,
    savedAt: new Date().toISOString(),
    mtime: st.mtime.toISOString(),
    note: note || '',
  }
  idx.versions.push(ver)
  // 超出上限就从最旧的开始删（用户主动备份的，不静默删太多）
  while (idx.versions.length > MAX_VERSIONS) {
    const old = idx.versions.shift()
    try { fs.unlinkSync(path.join(dir, old.file)) } catch (_) {}
  }
  idx.name = path.basename(abs)
  writeIndex(abs, idx)
  return { ok: true, version: ver, index: idx }
}

function listVersions(src) {
  const abs = path.resolve(src)
  const idx = readIndex(abs)
  // 顺手校验文件是否还在（用户可能在外面删了）
  const versions = idx.versions.map((v) => {
    let exists = true
    try { fs.statSync(path.join(dirOf(abs), v.file)) } catch (_) { exists = false }
    return { ...v, exists }
  })
  return { src: abs, name: idx.name || path.basename(abs), count: versions.length, versions }
}

// 还原：**先把当前状态备份**，再覆盖 —— 否则还原这一步本身就不可逆
function restoreVersion(src, stamp) {
  const abs = path.resolve(src)
  const idx = readIndex(abs)
  const ver = idx.versions.find((v) => v.stamp === stamp)
  if (!ver) return { ok: false, error: '找不到该版本' }
  const from = path.join(dirOf(abs), ver.file)
  try { fs.statSync(from) } catch (_) { return { ok: false, error: '该版本的备份文件已丢失' } }

  let pre = null
  try {
    if (fs.existsSync(abs)) pre = backupFile(abs, '还原前自动备份当前版本')
  } catch (_) {}
  try {
    fs.copyFileSync(from, abs)
  } catch (e) {
    return { ok: false, error: '写入失败（文件可能被 Word/WPS 占用）：' + e.message }
  }
  return { ok: true, restored: ver, preBackup: pre && pre.skipped ? null : pre }
}

// 删掉某个版本
function deleteVersion(src, stamp) {
  const abs = path.resolve(src)
  const idx = readIndex(abs)
  const i = idx.versions.findIndex((v) => v.stamp === stamp)
  if (i < 0) return { ok: false, error: '找不到该版本' }
  const [v] = idx.versions.splice(i, 1)
  try { fs.unlinkSync(path.join(dirOf(abs), v.file)) } catch (_) {}
  writeIndex(abs, idx)
  return { ok: true, count: idx.versions.length }
}

// 全部备份汇总（供界面列「已备份的文件」）
function listAll() {
  ensureRoot()
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(BACKUP_ROOT) } catch (_) { return out }
  for (const d of dirs) {
    const p = path.join(BACKUP_ROOT, d, 'index.json')
    if (!fs.existsSync(p)) continue
    let idx
    try { idx = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { continue }
    const last = idx.versions[idx.versions.length - 1]
    out.push({
      src: idx.src,
      name: idx.name || path.basename(idx.src || ''),
      count: idx.versions.length,
      lastSavedAt: last ? last.savedAt : null,
      lastSize: last ? last.size : 0,
      exists: (() => { try { return fs.statSync(idx.src).isFile() } catch (_) { return false } })(),
      root: path.join(BACKUP_ROOT, d),
    })
  }
  out.sort((a, b) => String(b.lastSavedAt).localeCompare(String(a.lastSavedAt)))
  return out
}

// ── 目录监控 ──────────────────────────────────────────────────────────────
// 只关心 Office/PDF 类文档，并过滤 Office 打开时产生的 ~$ 临时文件
function createWatcher(onChange) {
  const watchers = new Map()   // dir -> fs.FSWatcher
  const pending = new Map()    // path -> timer（防抖）
  const recent = []            // 最近变动的文件（供界面显示）

  // 同一文件只保留最近一条；新的插在最前
  function pushRecent(rec) {
    const i = recent.findIndex((r) => r.path === rec.path)
    if (i >= 0) recent.splice(i, 1)
    recent.unshift(rec)
    while (recent.length > 200) recent.pop()
  }

  function statRec(file) {
    let st
    try { st = fs.statSync(file) } catch (_) { return null }
    if (!st.isFile()) return null
    return {
      path: file,
      name: path.basename(file),
      ext: path.extname(file).toLowerCase(),
      size: st.size,
      mtime: st.mtime.toISOString(),
      at: new Date().toISOString(),
    }
  }

  function note(file) {
    const abs = path.resolve(file)
    const key = abs
    clearTimeout(pending.get(key))
    pending.set(key, setTimeout(() => {
      pending.delete(key)
      const rec = statRec(abs)
      if (!rec) return
      pushRecent(rec)
      try { onChange(rec) } catch (_) {}
    }, WATCH_DEBOUNCE))
  }

  // 初始扫描：把目录里**已经存在**的 Office 文档也纳入列表。
  // 只靠 fs.watch 的话，启动前就在的文件永远不会出现 —— 用户报过：
  // 桌面上的 .doc/.docx 明明在，中转站里却一个都看不到。
  // 递归最多 3 层、总数上限 500，避免大目录（下载）拖慢启动。
  function scanInto(dir, depth, out, maxDepth, maxFiles) {
    if (depth > maxDepth || out.length >= maxFiles) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      if (out.length >= maxFiles) return
      if (/^~\$/.test(e.name)) continue                 // Office 临时文件
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { scanInto(full, depth + 1, out, maxDepth, maxFiles); continue }
      if (!e.isFile()) continue
      if (!OFFICE_RE.test(full)) continue               // 只看文档类
      const rec = statRec(full)
      if (rec) out.push(rec)
    }
  }

  // 同步 IO 放到下一轮事件循环，避免 add() 卡住启动流程
  function scanLater(dir) {
    setImmediate(() => {
      const found = []
      scanInto(path.resolve(dir), 1, found, 3, 500)
      // 旧 → 新逐个 pushRecent（它插在最前），最终列表就是「新的在前」
      found.sort((a, b) => String(a.mtime).localeCompare(String(b.mtime)))
      for (const rec of found) pushRecent(rec)
      if (found.length) {
        console.log(`[relay] 初始扫描 ${dir}：发现 ${found.length} 个文档`)
        try { onChange(found[0]) } catch (_) {}          // 通知界面刷新
      }
    })
  }

  function add(dir) {
    const abs = path.resolve(dir)
    if (watchers.has(abs)) return { ok: true, already: true }
    try {
      const w = fs.watch(abs, { recursive: true }, (ev, name) => {
        if (!name) return
        const base = path.basename(String(name))
        if (/^~\$/.test(base)) return            // Office 临时文件
        const full = path.join(abs, String(name))
        if (!OFFICE_RE.test(full)) return        // 只看文档类
        note(full)
      })
      watchers.set(abs, w)
      scanLater(abs)                             // 把已存在的文档也读进来
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }
  function remove(dir) {
    const abs = path.resolve(dir)
    const w = watchers.get(abs)
    if (!w) return { ok: false, error: '未监控该目录' }
    try { w.close() } catch (_) {}
    watchers.delete(abs)
    return { ok: true }
  }
  function list() { return [...watchers.keys()] }
  function recentList() { return recent.slice() }
  function closeAll() { for (const w of watchers.values()) { try { w.close() } catch (_) {} } watchers.clear() }

  return { add, remove, list, recent: recentList, closeAll }
}

// ── 监控目录的持久化（下次启动自动恢复）──────────────────────────────────
function watchedFile() { return path.join(BACKUP_ROOT, 'watched.json') }
function loadWatched() {
  try { const v = JSON.parse(fs.readFileSync(watchedFile(), 'utf8')); return Array.isArray(v) ? v : [] } catch (_) { return [] }
}
function saveWatched(list) {
  ensureRoot()
  try { fs.writeFileSync(watchedFile(), JSON.stringify(list, null, 2), 'utf8') } catch (_) {}
}

// 固定监控目录：**下载** 与 **桌面**（用户指定）
// 这两个是默认就有的，且不允许移除 —— 办公文档最常落在这里。
// 注意用 os.homedir() 拼而不是写死 C:\Users\xxx：用户可能改过个人文件夹位置；
// 目录不存在的（如某些精简系统无 Downloads）会自动跳过。
const DEFAULT_WATCH = ['Downloads', 'Desktop'].map((d) => path.join(os.homedir(), d))

// 保证默认目录在监控列表里（首次运行或列表被清空时自动补上）
function ensureDefaults() {
  const cur = loadWatched()
  let changed = false
  for (const d of DEFAULT_WATCH) {
    if (fs.existsSync(d) && !cur.includes(d)) { cur.push(d); changed = true }
  }
  if (changed) saveWatched(cur)
  return cur
}

// ── IPC 注册（与 backend.js / api-debug.js 用同一套模式）──────────────────
// 注意签名要收「对象」—— main.js 那边是 registerRelayIpc({ ipcMain, getWindow })，
// 写成两个位置参数会让 ipcMain 变成 undefined，报 "ipcMain.handle is not a function"（踩过）。
function registerRelayIpc({ ipcMain, getWindow }) {
  const send = (ch, payload) => {
    const w = getWindow && getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload)
  }
  const watcher = createWatcher((rec) => send('relay:changed', rec))
  const touched = new Map()   // IDE 内打开/保存过的文件（用户选的监控范围之一）

  // 恢复上次的监控目录，并保证「下载 / 桌面」始终在里面
  for (const d of ensureDefaults()) {
    const r = watcher.add(d)
    if (!r.ok) console.log('[relay] 监控目录不可用:', d, r.error)
  }
  console.log('[relay] 默认监控:', DEFAULT_WATCH.join(' | '))

  ipcMain.handle('relay:status', () => ({
    root: BACKUP_ROOT,
    watched: watcher.list(),
    recent: watcher.recent(),
    touched: [...touched.values()].slice(0, 200),
  }))

  // IDE 里打开/保存文件时上报（渲染进程调用）
  ipcMain.handle('relay:touch', (_e, file) => {
    if (!file) return { ok: false }
    const abs = path.resolve(file)
    let st
    try { st = fs.statSync(abs) } catch (_) { return { ok: false } }
    if (!st.isFile()) return { ok: false }
    touched.set(abs, {
      path: abs,
      name: path.basename(abs),
      ext: path.extname(abs).toLowerCase(),
      size: st.size,
      mtime: st.mtime.toISOString(),
      at: new Date().toISOString(),
      office: OFFICE_RE.test(abs),
    })
    return { ok: true }
  })

  ipcMain.handle('relay:list', () => listAll())
  ipcMain.handle('relay:meta', (_e, file) => readOfficeMeta(file))

  // 用系统默认程序打开（双击文件时用）—— 交给 shell 而不是自己起进程
  ipcMain.handle('relay:open', async (_e, file) => {
    const { shell } = require('electron')
    const abs = path.resolve(file)
    try { if (!fs.statSync(abs).isFile()) return { ok: false, error: '文件不存在' } } catch (_) { return { ok: false, error: '文件不存在' } }
    const msg = await shell.openPath(abs)
    return msg ? { ok: false, error: msg } : { ok: true }
  })

  // 在资源管理器里选中该文件
  ipcMain.handle('relay:reveal', (_e, file) => {
    const { shell } = require('electron')
    try { shell.showItemInFolder(path.resolve(file)); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  })

  // 原文件是否还在（界面据此把已删除的标出来）
  ipcMain.handle('relay:exists', (_e, file) => {
    try { return { ok: true, exists: fs.statSync(path.resolve(file)).isFile() } } catch (_) { return { ok: true, exists: false } }
  })
  ipcMain.handle('relay:backup', (_e, { file, note }) => backupFile(file, note))
  ipcMain.handle('relay:versions', (_e, file) => listVersions(file))
  ipcMain.handle('relay:restore', (_e, { file, stamp }) => restoreVersion(file, stamp))
  ipcMain.handle('relay:delete', (_e, { file, stamp }) => deleteVersion(file, stamp))

  ipcMain.handle('relay:watch:add', (_e, dir) => {
    const r = watcher.add(dir)
    if (r.ok) {
      const list = watcher.list()
      saveWatched(list)
    }
    return { ...r, watched: watcher.list() }
  })
  ipcMain.handle('relay:watch:remove', (_e, dir) => {
    const abs = path.resolve(dir)
    // 固定目录不允许移除 —— 否则用户会以为还在保护
    if (DEFAULT_WATCH.some((d) => path.resolve(d) === abs)) {
      return { ok: false, error: '下载和桌面是固定的监控目录，不能移除', watched: watcher.list(), fixed: true }
    }
    const r = watcher.remove(abs)
    saveWatched(watcher.list())
    return { ...r, watched: watcher.list() }
  })

  return watcher
}

module.exports = {
  BACKUP_ROOT, OFFICE_RE, DEFAULT_WATCH,
  backupFile, listVersions, restoreVersion, deleteVersion, listAll,
  readOfficeMeta, readZipEntry,
  createWatcher, registerRelayIpc, loadWatched, saveWatched, ensureDefaults,
}
