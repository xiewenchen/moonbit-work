// 解析 `moon ide gen-symbols` 产出的 symbols.jsonl，提供符号搜索与定义查找。
// 纯函数、无 Electron 依赖（可单测）。
//
// 说明：`moon ide peek-def` / `hover` 在当前工具链版本下对本地 loc 一律报
//       "could not get package of loc"，但 `gen-symbols` 可用 —— 因此我们
//       自己解析符号索引来实现「跳转定义」与「符号补全」。
const fs = require('fs')

// 每行形如：
// {"kind":["Sym","find_header"],"path":"\\http\\http.mbt","pkg":"mbp/platform/http",
//  "tag":"0x1000","range":[119,1,128,2],"name_range":[119,4,119,15],"doc_range":[...]}
function parseSymbolsJsonl(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    let o
    try {
      o = JSON.parse(s)
    } catch (_) {
      continue
    }
    if (!o || !o.path || !Array.isArray(o.name_range) || o.name_range.length < 2) continue
    const kindArr = Array.isArray(o.kind) ? o.kind : []
    const name = kindArr.length >= 2 ? String(kindArr[1]) : ''
    if (!name) continue
    const rng = Array.isArray(o.range) ? o.range : []
    const doc = Array.isArray(o.doc_range) ? o.doc_range : []
    out.push({
      name,
      kind: kindArr.length >= 2 ? String(kindArr[0]) : '',
      package: o.pkg ? String(o.pkg) : '',
      path: String(o.path),
      line: Number(o.name_range[0]) || 1,
      col: Number(o.name_range[1]) || 1,
      // 声明整体范围（1-based 行列），用于提取签名
      startLine: Number(rng[0]) || Number(o.name_range[0]) || 1,
      endLine: Number(rng[2]) || Number(o.name_range[0]) || 1,
      // 文档注释范围（若有）
      docStartLine: doc.length >= 4 ? Number(doc[0]) || 0 : 0,
      docEndLine: doc.length >= 4 ? Number(doc[2]) || 0 : 0,
    })
  }
  return out
}

// 符号索引文件路径（在给定工作区根下）
function symbolsPath(root) {
  return require('path').join(root, 'symbols.jsonl')
}

// 读并解析；文件不存在返回 []
function loadSymbols(root) {
  try {
    return parseSymbolsJsonl(fs.readFileSync(symbolsPath(root), 'utf8'))
  } catch (_) {
    return []
  }
}

// 关键词搜索符号（名称包含即命中），去重后返回
function searchSymbols(symbols, query, limit = 100) {
  if (typeof query !== 'string' || query.length === 0) return []
  const q = query.toLowerCase()
  const out = []
  const seen = new Set()
  for (const s of symbols) {
    if (!s.name.toLowerCase().includes(q)) continue
    const key = s.name + '@' + s.path + ':' + s.line
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

// 按名字找定义：优先精确匹配，其次匹配最后一段（Type::member / pkg.foo）
function findDefinition(symbols, name) {
  if (!name) return null
  const exact = symbols.find((s) => s.name === name)
  if (exact) return exact
  const last = String(name).split(/::|\./).pop()
  return symbols.find((s) => s.name === last) || null
}

// 路径归一化：symbols.jsonl 里是 `\http\http.mbt`（相对 workspace）
function symbolFsPath(root, s) {
  const path = require('path')
  const rel = String(s.path).replace(/^[\\/]+/, '').replace(/[\\/]/g, path.sep)
  return path.join(root, rel)
}

// 从「符号 + 该文件的行数组」提取 hover 内容：文档注释 + 签名片段。
// 纯函数，便于单测。
function extractHover(sym, lines, maxSigLines = 12) {
  if (!Array.isArray(lines) || lines.length === 0) return ''
  const parts = []
  // 1) 文档注释
  if (sym.docStartLine > 0 && sym.docEndLine >= sym.docStartLine) {
    const ds = Math.max(0, sym.docStartLine - 1)
    const de = Math.min(lines.length - 1, sym.docEndLine - 1)
    const docLines = lines.slice(ds, de + 1)
    if (docLines.length) parts.push(docLines.join('\n'))
  }
  // 2) 签名：从声明起始行起，遇 { / = / 空行 或超过 maxSigLines 截断
  const ss = Math.max(0, (sym.startLine || sym.line || 1) - 1)
  const hardEnd = Math.min(lines.length - 1, ss + maxSigLines - 1)
  const sig = []
  for (let i = ss; i <= hardEnd; i++) {
    const ln = lines[i]
    sig.push(ln)
    if (/[{=]\s*$/.test(ln)) break
    if (sig.length >= maxSigLines) break
  }
  if (sig.length) parts.push(sig.join('\n'))
  return parts.join('\n\n')
}

module.exports = {
  extractHover,
  parseSymbolsJsonl,
  loadSymbols,
  symbolsPath,
  searchSymbols,
  findDefinition,
  symbolFsPath,
}
