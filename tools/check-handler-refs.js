#!/usr/bin/env node
// 静态检查：事件处理器（onclick/onchange/…）里是否调用了「本文件没定义的函数」。
//
// 为什么需要它：如果一个按钮的 onclick 调了个不存在的函数，表现是
// **点了完全没反应**（抛在 UI 事件里，用户看不见，也不进任何日志）。
// 这与 P13-04 补 修的那个"面板打开永远空白"是同一类"静默没反应"。
//
// 判据（尽量少误报 —— 误报会让人不信这个工具）：
//   · 定义端：扫**整个文件**的 `function X`、`const/let/var X =`、
//     以及解构 `const [a, X] of/=`、`const { a, X } =`、函数参数与 for-of 的绑定名；
//   · 调用端：只看事件处理器那一行，且排除 `obj.fn(`（方法调用）；
//   · 关键字与内置全局（console/setTimeout/…）不报。
//
// 用法：
//   node tools/check-handler-refs.js            列出可疑项
//   node tools/check-handler-refs.js --ci       只判"有没有"（有则 exit 1）
import fs from 'fs'
import path from 'path'

// ⚠️ 先分一遍参数：`--ci` 不是路径。之前写成 argv[2]，于是 `--ci` 被当成目录
//（ENOENT: scandir '.../moonbit-platform/--ci'）—— 而它已经挂在 CI 上，会直接让 CI 红。
const ARGV = process.argv.slice(2)
const CI_MODE = ARGV.includes('--ci')
const POSITIONAL = ARGV.filter((a) => !a.startsWith('--'))
const ROOT = path.resolve(POSITIONAL[0] || path.join(import.meta.dirname, '..', 'desktop'))
const FILES = process.env.CHR_FILES
  ? process.env.CHR_FILES.split(',').map((s) => s.trim())
  : fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && !f.startsWith('test-') && !f.startsWith('verify-'))

// ⚠️ 必须 split(/\s+/) —— JS 的 String.prototype.split() **无参时不分割**（返回 [原串]），
//    与 Python 的 str.split() 不同。写成 .split() 会让这个 Set 里只有一个长字符串，
//    于是 has('if') 恒为 false、所有关键字都被当"未定义函数"报出来（曾一次误报 43 处）。
const KEYWORDS = new Set('if for while switch catch return typeof function await async new else do try throw delete void in of instanceof yield'.split(/\s+/))
const BUILTINS = new Set((
  'setTimeout setInterval clearTimeout clearInterval alert confirm prompt fetch JSON Object Array String Number Boolean ' +
  'Math Date Promise parseInt parseFloat isNaN isFinite decodeURIComponent encodeURIComponent encodeURI decodeURI ' +
  'requestAnimationFrame cancelAnimationFrame structuredClone queueMicrotask btoa atob TextEncoder TextDecoder URL ' +
  'URLSearchParams Intl RegExp Error TypeError RangeError Map Set WeakMap WeakSet Symbol BigInt Uint8Array Uint16Array ' +
  'Uint32Array Int8Array Int16Array Int32Array Float32Array Float64Array ArrayBuffer DataView Function eval undefined ' +
  'NaN Infinity console document window globalThis localStorage sessionStorage navigator location history performance ' +
  'crypto Event CustomEvent MutationObserver ResizeObserver IntersectionObserver Blob File FileReader FormData ' +
  'AbortController AbortSignal Image Audio WebSocket Worker postMessage require module exports process Buffer ' +
  'getComputedStyle matchMedia scrollTo open close print focus blur'
).split(/\s+/))

/** 收集一个文件里出现的所有「绑定名」 */
function collectBindings(src) {
  const names = new Set()
  const add = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n) }

  // function foo(...) / class Foo
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  // const/let/var 简单赋值
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) add(m[1])
  // 解构：const [a, b, c] / const { a, b: c }
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of m[1].split(',')) add(part.trim().split(/\s*=\s*/)[0])
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) add(part.trim().split(':').pop().trim().split(/\s*=\s*/)[0])
  }
  // 箭头/普通函数参数：(...) => / function (...)  —— 粗略但够用
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim().split(/\s*=\s*/)[0].replace(/^\.\.\./, '')
      if (/^[A-Za-z_$][\w$]*$/.test(p)) add(p)
    }
  }
  for (const m of src.matchAll(/\b(?:async\s+)?function\s*[A-Za-z_$]*\s*\(([^()]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim().split(/\s*=\s*/)[0].replace(/^\.\.\./, '')
      if (/^[A-Za-z_$][\w$]*$/.test(p)) add(p)
    }
  }
  // 单个参数的箭头：x => ...
  for (const m of src.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1])
  // for (const X of Y) / for (const [a, X] of Y) 里的绑定（上面解构已覆盖大部分）
  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\b/g)) add(m[1])
  return names
}

const HANDLER_RE = /\.(onclick|onchange|oninput|onsubmit|onkeydown|onkeyup|onblur|onfocus|onerror|onload|ondblclick)\s*=\s*(.+)$/gm
const CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g

const findings = []
let scannedHandlers = 0
for (const f of FILES) {
  const abs = path.join(ROOT, f)
  if (!fs.existsSync(abs)) continue
  const src = fs.readFileSync(abs, 'utf8')
  const names = collectBindings(src)
  const lines = src.split('\n')
  for (const m of src.matchAll(HANDLER_RE)) {
    scannedHandlers++
    const line = src.slice(0, m.index).split('\n').length
    const expr = m[2]
    for (const cm of expr.matchAll(CALL_RE)) {
      const fn = cm[1]
      if (KEYWORDS.has(fn) || BUILTINS.has(fn) || names.has(fn)) continue
      findings.push({ file: f, line, fn, code: (lines[line - 1] || '').trim().slice(0, 120) })
    }
  }
}

const ci = CI_MODE
if (findings.length === 0) {
  console.log('✓ 事件处理器里没有「调用未定义函数」的情况（扫了 ' + scannedHandlers + ' 个处理器，' + FILES.length + ' 个文件）')
  process.exit(0)
}
console.log('可疑：事件处理器里调用了本文件未出现的名字（点了可能静默没反应）')
for (const x of findings) {
  console.log('  ' + x.file + ':' + x.line + '  ' + x.fn + '()')
  console.log('      ' + x.code)
}
console.log('\n共 ' + findings.length + ' 处。逐个确认：真未定义 → 修；误报 → 把该名字的绑定方式补进 collectBindings。')
process.exit(ci ? 1 : 0)
