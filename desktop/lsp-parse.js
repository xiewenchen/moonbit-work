// `moon` 命令输出的解析器（从 main.js 抽出，便于单测）。
// 纯函数、无 Electron 依赖。

// 解析 `moon check` 的诊断输出：
//   Error: [4021]
//      ╭─[ /path/file.mbt:2:3 ]
//      │   ╰─────────── The value identifier ... is unbound.
// 返回 [{ file, line, col, severity, code, message }]
function parseDiagnostics(text) {
  const out = []
  let cur = null
  for (const ln of String(text).split(/\r?\n/)) {
    const mLevel = ln.match(/^(Error|Warning):\s*\[(\d+)\]/)
    if (mLevel) {
      cur = {
        severity: mLevel[1] === 'Error' ? 'error' : 'warning',
        code: mLevel[2],
        file: null,
        line: 1,
        col: 1,
        message: '',
      }
      out.push(cur)
      continue
    }
    // 位置行：╭─[ path:line:col ]（也容忍 └─[ ... ]）
    const mLoc = ln.match(/[\u256d\u2570]\u2500\[?\s*(.+?):(\d+):(\d+)\s*\]?/)
    if (mLoc && cur && cur.file === null) {
      cur.file = mLoc[1].trim()
      cur.line = parseInt(mLoc[2], 10)
      cur.col = parseInt(mLoc[3], 10)
      continue
    }
    // 消息行：╰─────────── message
    const mMsg = ln.match(/[\u2570]\u2500+\s*(.+)$/)
    if (mMsg && cur && !cur.message) {
      cur.message = mMsg[1].trim()
    }
  }
  // 只保留指向 .mbt 文件的诊断（过滤掉「failed to run check」这类整体错误）
  return out.filter((d) => d.file && d.file.endsWith('.mbt'))
}

// 解析 `moon ide outline` 的输出：形如 ` 17 |pub async fn run_capture(`
function parseOutline(text) {
  const out = []
  for (const ln of String(text).split(/\r?\n/)) {
    const m = ln.match(/^\s*(\d+)\s*\|\s*(.*)$/)
    if (!m) continue
    const body = m[2].trim()
    if (body && body !== '...') out.push({ line: parseInt(m[1], 10), text: body })
  }
  return out
}

// 导出用 IIFE 包起来 —— 这三个文件在**同一个浏览器全局作用域**里执行，
// 顶层裸写 `const API` 会让后来者抛 "Identifier 'API' has already been declared"
// （Node 里各自是独立模块作用域，所以单测发现不了 —— 实测踩到）。
;(function () {
  const API = { parseDiagnostics, parseOutline }

  // 双环境导出：Node（单测 / CI / 主进程）走 CommonJS；
  // 渲染进程通过 index.html 的 <script> 取全局 —— preload 是 sandbox:true，不能 require 本地文件。
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.MoonbitLspParse = API
})()
