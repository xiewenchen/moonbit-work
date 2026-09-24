'use strict'

/**
 * AI Provider 的接线（Phase 2 / P12 接线段）
 *
 * 两件事：
 *   ① 本地存储（**用户目录**，绝不在项目里 —— P12-09）；
 *   ② IPC：清单（**读回来就已脱敏**）、保存、删除、连通性探测。
 *
 * 存储位置刻意放在 `~/.moonbit-work/providers.json`：
 * 它不是项目文件，所以 `git status` 永远不会看到 Key；项目之间共享同一份配置。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  createProvider,
  validateProvider,
  listForUi,
  testConnection,
} = require('./ai-provider')
// 复用 agent.js 的 opencode 配置读写 —— 保证「Provider 面板」与「配置模型」弹窗
// 写的是**同一份配置、同一种格式**
const { readConfig, writeConfig, CFG_FILE } = require('./agent')

const STORAGE_DIR = path.join(os.homedir(), '.moonbit-work')
const STORAGE_FILE = path.join(STORAGE_DIR, 'providers.json')

// ── P12 激活：Provider 名 → opencode 的 provider id ────────────────────────────
/**
 * 只保留小写字母/数字/_/-，避免把不合法的字符写进配置键。
 * 空的话兜底 `custom`（比如中文名会被整段替换掉）。
 */
function pidOf(name) {
  const s = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'custom'
}

function registerAiProviderIpc({ ipcMain, request, onLog }) {
  const log = typeof onLog === 'function' ? onLog : () => {}

  /** 读全部（文件不存在或损坏 → 当空处理，并把损坏的那份挪开以免丢数据）*/
  function readAll() {
    let raw
    try {
      raw = fs.readFileSync(STORAGE_FILE, 'utf8')
    } catch (e) {
      return []                                   // 首次使用：文件本来就不存在
    }
    try {
      const j = JSON.parse(raw)
      return Array.isArray(j && j.providers) ? j.providers : []
    } catch (e) {
      // 损坏：先备份再当空，别静默覆盖用户的配置
      try {
        fs.writeFileSync(STORAGE_FILE + '.broken-' + Date.now(), raw, 'utf8')
      } catch (e2) {
        log({ at: 'providers.readAll.backup', error: String((e2 && e2.message) || e2) })
      }
      log({ at: 'providers.readAll', error: '配置损坏，已备份为 .broken-*' })
      return []
    }
  }

  function writeAll(list) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true })
    fs.writeFileSync(STORAGE_FILE, JSON.stringify({ version: 1, providers: list }, null, 2), 'utf8')
  }

  ipcMain.handle('aiProvider:list', () => ({ ok: true, providers: listForUi(readAll()) }))

  ipcMain.handle('aiProvider:save', (_e, input = {}) => {
    const p = createProvider(input)
    const v = validateProvider(p)
    if (!v.ok) return { ok: false, error: v.errors.join('；'), errors: v.errors }
    const list = readAll().filter((x) => createProvider(x).name !== p.name)
    list.push(p)
    try {
      writeAll(list)
    } catch (e) {
      return { ok: false, error: '保存失败：' + String((e && e.message) || e) }
    }
    return { ok: true, providers: listForUi(list) }
  })

  ipcMain.handle('aiProvider:remove', (_e, { name } = {}) => {
    const target = String(name == null ? '' : name).trim()
    if (!target) return { ok: false, error: '缺少 name' }
    const before = readAll()
    const after = before.filter((x) => createProvider(x).name !== target)
    if (after.length === before.length) return { ok: false, error: '没有找到：' + target }
    try {
      writeAll(after)
    } catch (e) {
      return { ok: false, error: '删除失败：' + String((e && e.message) || e) }
    }
    return { ok: true, providers: listForUi(after) }
  })

  ipcMain.handle('aiProvider:test', async (_e, input = {}) => {
    const r = await testConnection(createProvider(input), { request })
    // 只记"结果"，**不记请求头**（里面有 Key）
    log({ at: 'providers.test', ok: r.ok, status: r.status, latency: r.latency })
    return r
  })

  /**
   * 把一个 provider **激活**：翻译成 opencode 配置片段并**合并**写回。
   *
   * 格式以现有「配置模型」弹窗（`aiagent.js`）为准，两边必须一致：
   *   provider.<id> = { npm: '@ai-sdk/openai-compatible',
   *                     options: { baseURL, apiKey },
   *                     models: { <model>: {} } }
   *   model = '<id>/<model>'
   *
   * **合并**而非覆盖：保留其它 provider 与其它顶层字段，不动用户已有配置。
   * 注意：`writeConfig` 输出的是纯 JSON，`.jsonc` 里的 `//` 注释会被丢掉（已知，记在变更文档里）。
   */
  ipcMain.handle('aiProvider:activate', (_e, { name } = {}) => {
    const target = String(name == null ? '' : name).trim()
    if (!target) return { ok: false, error: '缺少 name' }
    const raw = readAll().find((x) => createProvider(x).name === target)
    if (!raw) return { ok: false, error: '没有找到：' + target }
    const p = createProvider(raw)
    const v = validateProvider(p)
    if (!v.ok) return { ok: false, error: v.errors.join('；'), errors: v.errors }

    const pid = pidOf(p.name)
    const cur = readConfig()
    const base = (cur && cur.config) || { $schema: 'https://opencode.ai/config.json' }
    const next = Object.assign({}, base, {
      provider: Object.assign({}, base.provider || {}, {
        [pid]: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: p.baseUrl, apiKey: p.apiKey },
          models: { [p.model]: {} },
        },
      }),
      model: pid + '/' + p.model,
    })
    const w = writeConfig(next)
    if (!w || w.ok !== true) return { ok: false, error: '写入失败：' + ((w && w.error) || '未知') }
    log({ at: 'providers.activate', id: pid, model: next.model })   // 不记 Key
    return { ok: true, id: pid, model: next.model, file: CFG_FILE }
  })

  /** 当前生效的是谁（读 opencode 配置，反查 provider 与 baseURL）*/
  ipcMain.handle('aiProvider:active', () => {
    const cur = readConfig()
    const cfg = (cur && cur.config) || {}
    const m = typeof cfg.model === 'string' ? cfg.model : ''
    const id = m.includes('/') ? m.slice(0, m.indexOf('/')) : m
    const pv = (cfg.provider && id) ? cfg.provider[id] : null
    return {
      ok: true,
      model: m || null,
      id: id || null,
      baseUrl: (pv && pv.options && pv.options.baseURL) || null,
      file: CFG_FILE,
    }
  })

  /** 供界面显示"配置存在哪"（也方便验证"不在项目目录"）*/
  ipcMain.handle('aiProvider:storage', () => ({ ok: true, dir: STORAGE_DIR, file: STORAGE_FILE }))

  return { readAll, storageFile: STORAGE_FILE }
}

module.exports = { registerAiProviderIpc, STORAGE_DIR, STORAGE_FILE }
