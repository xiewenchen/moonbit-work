// 工作区文本搜索（VS Code Ctrl+Shift+F 的核心）。
// 纯 Node、无 Electron 依赖，便于单测。
const fs = require('fs')
const path = require('path')

// 不进入的目录
const SKIP_DIRS = new Set([
  '_build',
  '.git',
  'node_modules',
  '.mooncakes',
  'dist',
  'out',
  '.vscode',
])

// 视为文本的文件后缀（+ 无后缀的常见配置文件）
const TEXT_EXT = new Set([
  '.mbt',
  '.json',
  '.jsonl',
  '.md',
  '.toml',
  '.yml',
  '.yaml',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.txt',
  '.sql',
  '.css',
  '.html',
  '.sh',
  '.ps1',
  '.pkg',
  '.mod',
])
const TEXT_NAMES = new Set(['moon.mod', 'moon.pkg', '.gitignore', 'Dockerfile', 'LICENSE'])

function isTextFile(name) {
  return TEXT_EXT.has(path.extname(name).toLowerCase()) || TEXT_NAMES.has(name)
}

// 在 root 下递归搜索 query，返回 { results, scanned, truncated }
// 结果项：{ file, line, col, text }
function searchInDir(root, query, opts = {}) {
  const maxFiles = opts.maxFiles || 4000
  const maxResults = opts.maxResults || 500
  const maxFileSize = opts.maxFileSize || 1024 * 1024
  const maxDepth = opts.maxDepth || 12
  const caseInsensitive = !!opts.caseInsensitive

  if (typeof query !== 'string' || query.length === 0) {
    return { results: [], scanned: 0, truncated: false }
  }
  const needle = caseInsensitive ? query.toLowerCase() : query
  const results = []
  let scanned = 0
  let truncated = false

  const walk = (dir, depth) => {
    if (truncated || depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const e of entries) {
      if (truncated) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(full, depth + 1)
      } else if (e.isFile() && isTextFile(e.name)) {
        if (scanned >= maxFiles) {
          truncated = true
          return
        }
        let st
        try {
          st = fs.statSync(full)
        } catch (_) {
          continue
        }
        if (st.size > maxFileSize) continue
        scanned++
        let content
        try {
          content = fs.readFileSync(full, 'utf8')
        } catch (_) {
          continue
        }
        const lines = content.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const hay = caseInsensitive ? lines[i].toLowerCase() : lines[i]
          const col = hay.indexOf(needle)
          if (col >= 0) {
            results.push({
              file: full,
              line: i + 1,
              col: col + 1,
              text: lines[i].slice(0, 300),
            })
            if (results.length >= maxResults) {
              truncated = true
              return
            }
          }
        }
      }
    }
  }

  walk(root, 0)
  return { results, scanned, truncated }
}

module.exports = { searchInDir, isTextFile, SKIP_DIRS }
