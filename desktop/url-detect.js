'use strict'

/**
 * URL 检测 —— 纯逻辑，不依赖 Electron（Phase 2 / MBW-P1-07 从 runners.js 抽离）
 *
 * 抽离动机：
 *   1. 原实现内联在 `ipcMain.handle('runner:run')` 的 onChunk 闭包里（runners.js:255-267），
 *      无法脱离 Electron 单测；
 *   2. 同一套正则被复制到 verify-url-regex.js，两处维护容易漂移；
 *   3. 「多 URL 选哪个」「重复 URL 只开一次」「非法形态」此前既没有契约也没有测试。
 *
 * 与生产行为保持一致（P1-19 迁移前 runners.js 仍是唯一调用方）：
 *   - 只认 `http(s)://` 且 host ∈ { localhost, 127.0.0.1, [::1] }
 *   - 先剥离 ANSI 色码（URL 后面常紧跟 \u001b[39m）
 *   - 跨 chunk 累积（默认保留末 2048 字节）
 *   - 去掉尾部标点 `.` `,` `;` `:`
 *   - 一旦命中就只触发一次（opened 语义）
 */

// 与 runners.js:262 逐字符相同 —— test-url-detect.js 有「防漂移」断言锁住这一点
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s'"<>)]*/i

const ANSI_RE = /\u001b\[[0-9;]*m/g

const DEFAULT_MAX_BUFFER = 2048

/** 剥离 ANSI 色码 */
function stripAnsi(input) {
  return String(input == null ? '' : input).replace(ANSI_RE, '')
}

/** 去掉 URL 尾部的标点（日志里常见 `…:8123.` 这种句末标点） */
function trimTrailingPunctuation(url) {
  return String(url).replace(/[.,;:]+$/, '')
}

/** 取 URL 的端口号；无端口返回 null。IPv6（[::1]:port）不解析，返回 null */
function portOf(url) {
  const m = String(url == null ? '' : url).match(/^https?:\/\/[^/]*?(?::(\d+))?(?:\/|$)/)
  return m && m[1] ? Number(m[1]) : null
}

function normalizePorts(v) {
  if (v == null) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr.map(Number).filter((n) => Number.isFinite(n))
}

/** 从一段文本里找出所有本地 URL（去重前，保持出现顺序） */
function findAll(text) {
  const clean = stripAnsi(text)
  const re = new RegExp(LOCAL_URL_RE.source, LOCAL_URL_RE.flags + 'g')
  const out = []
  let m
  while ((m = re.exec(clean)) !== null) {
    const url = trimTrailingPunctuation(m[0])
    if (url) out.push(url)
    if (m.index === re.lastIndex) re.lastIndex += 1 // 防零宽匹配死循环
  }
  return out
}

/**
 * 按「项目运行规则」挑选 URL（P1-11）。
 * 规则：给了 preferPorts 就优先选端口匹配的那个；没有匹配（或没给）则退回第一个。
 * 具体偏好由调用方（Runner）按项目类型注入，本模块不猜项目类型。
 */
function pickUrl(urls, opts = {}) {
  if (!urls || !urls.length) return null
  const prefer = normalizePorts(opts.preferPorts != null ? opts.preferPorts : opts.preferPort)
  if (prefer.length) {
    const hit = urls.find((u) => prefer.includes(portOf(u)))
    if (hit) return hit
  }
  return urls[0]
}

/**
 * 从一段文本里检测本地 URL。
 * @param {string} text
 * @param {{preferPorts?: number[]|number, preferPort?: number}} [opts]
 * @returns {string|null}
 */
function detectUrl(text, opts = {}) {
  return pickUrl(findAll(text), opts)
}

/**
 * 跨 chunk 扫描器：把 stdout/stderr 的分块喂进来，命中时返回 { url, isNew }，否则 null。
 * 同一个 URL 只会命中一次（对应 runner 侧「只打开一次浏览器」的语义）。
 */
function createUrlScanner(opts = {}) {
  const n = Number(opts.maxBuffer)
  const maxBuffer = Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BUFFER
  let buf = ''
  let opened = false
  return {
    push(chunk) {
      if (opened) return null
      buf = (buf + stripAnsi(chunk)).slice(-maxBuffer)
      const url = pickUrl(findAll(buf), opts)
      if (!url) return null
      opened = true
      return { url, isNew: true }
    },
    reset() {
      buf = ''
      opened = false
    },
    get opened() {
      return opened
    },
    get buffer() {
      return buf
    },
  }
}

module.exports = {
  LOCAL_URL_RE,
  DEFAULT_MAX_BUFFER,
  stripAnsi,
  trimTrailingPunctuation,
  portOf,
  pickUrl,
  findAll,
  detectUrl,
  createUrlScanner,
}
