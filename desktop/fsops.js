// 文件系统能力（纯 Node，便于用 `node` 直接单测；主进程负责加 IPC 外壳）。
const fs = require('node:fs')
const path = require('node:path')

// 浏览时跳过的大目录/缓存
const SKIP = new Set(['node_modules', '.git', '_build', 'symbols.jsonl', '.mooncakes', '.moon', '.cache'])

// 按扩展名猜 Monaco 语言
const LANG_BY_EXT = {
  '.mbt': 'moonbit',
  '.mbti': 'moonbit',
  '.mbtx': 'moonbit',
  '.json': 'json',
  '.js': 'javascript',
  '.ts': 'typescript',
  '.md': 'markdown',
  '.toml': 'ini',
  '.css': 'css',
  '.html': 'html',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'shell',
}

function languageOf(file) {
  return LANG_BY_EXT[path.extname(file).toLowerCase()] || 'plaintext'
}

/** 列出目录内容（目录在前，按名排序）。 */
function listDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const out = []
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    out.push({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() })
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return out
}

function readTextFile(file) {
  const content = fs.readFileSync(file, 'utf8')
  return { path: file, content, language: languageOf(file) }
}

function writeTextFile(file, content) {
  fs.writeFileSync(file, content, 'utf8')
  return { path: file, bytes: Buffer.byteLength(content, 'utf8') }
}

/** 从 dir 起向上查找 moon.mod。 */
function findModule(dir) {
  let d = path.resolve(dir)
  while (true) {
    const file = path.join(d, 'moon.mod')
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8')
      const name = (content.match(/^\s*name\s*=\s*"([^"]*)"/m) || [])[1] || ''
      const version = (content.match(/^\s*version\s*=\s*"([^"]*)"/m) || [])[1] || ''
      return { dir: d, file, name, version }
    }
    const parent = path.dirname(d)
    if (parent === d) return null
    d = parent
  }
}

module.exports = { listDir, readTextFile, writeTextFile, findModule, languageOf, SKIP }
