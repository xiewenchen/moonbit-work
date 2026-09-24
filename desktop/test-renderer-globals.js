'use strict'

/**
 * 渲染进程「同全局作用域」加载测试（Phase 2 / P4 接线时踩坑后补）
 *
 * 为什么需要它：
 *   这几个脚本在浏览器里是**同一个全局作用域**下依次执行的（普通 <script>，不是模块），
 *   而 Node 里每个文件都是**独立模块作用域** —— 于是「顶层 `const API` 重名」
 *   这类问题在普通单测里**完全看不见**。
 *
 * 实测踩过一次：lsp-parse.js 与 problem-model.js 都写了顶层 `const API`，
 * 浏览器里第二个直接抛 "Identifier 'API' has already been declared"，
 * 两个模块都没挂上全局 → 问题面板整块失效（而所有 Node 单测都是绿的）。
 *
 * 这个测试用 vm 在同一 context 里按 index.html 的真实顺序加载它们，
 * 把"只有浏览器才暴露"的问题拉回 CI 能看见的地方。
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

let pass = 0
let fail = 0
const failures = []
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
}

// 这几个是「纯逻辑 + 双环境导出」的脚本：能在没有 DOM 的环境里安全加载
const PURE_SCRIPTS = [
  { file: 'project-context.js', global: 'moonbitProjectContext' },
  { file: 'lsp-parse.js', global: 'MoonbitLspParse' },
  { file: 'problem-model.js', global: 'MoonbitProblems' },
]

/** 造一个「像浏览器那样」的 context：有 window，没有 module/exports/require */
function browserContext() {
  const ctx = { console }
  ctx.window = ctx
  ctx.self = ctx
  ctx.globalThis = ctx
  vm.createContext(ctx)
  return ctx
}

function loadAll(ctx, scripts) {
  const errors = []
  for (const s of scripts) {
    try {
      vm.runInContext(fs.readFileSync(path.join(__dirname, s.file), 'utf8'), ctx, { filename: s.file })
    } catch (e) {
      errors.push(s.file + ': ' + String((e && e.message) || e))
    }
  }
  return errors
}

console.log('\n=== 同一全局作用域下依次加载（模拟浏览器）===')
{
  const ctx = browserContext()
  const errors = loadAll(ctx, PURE_SCRIPTS)
  chk('三个脚本都能加载（没有 const 重名之类的冲突）', errors, [])
  for (const s of PURE_SCRIPTS) {
    chk(s.file + ' → 挂上 window.' + s.global, typeof ctx[s.global], 'object')
  }
  chk('project-context 的短名 create 存在', typeof (ctx.moonbitProjectContext || {}).create, 'function')
  chk('problem-model 的 Store 工厂存在', typeof (ctx.MoonbitProblems || {}).createProblemStore, 'function')
  chk('lsp-parse 的解析器存在', typeof (ctx.MoonbitLspParse || {}).parseDiagnostics, 'function')
}

console.log('\n=== 顺序无关（打乱也能全部加载）===')
{
  const shuffled = PURE_SCRIPTS.slice().reverse()
  const ctx = browserContext()
  const errors = loadAll(ctx, shuffled)
  chk('倒序加载同样成功', errors, [])
  chk('全局仍然齐备', shuffled.map((s) => typeof ctx[s.global]).join(','), 'object,object,object')
}

console.log('\n=== 浏览器里不该依赖 Node 的 module ===')
{
  const ctx = browserContext()
  loadAll(ctx, PURE_SCRIPTS)
  chk('加载后没有顺手把 module 泄漏成全局', typeof ctx.module, 'undefined')
}

console.log('\n=== index.html 真的引入了它们（防"忘了加进转译列表"）===')
{
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  for (const s of PURE_SCRIPTS) {
    chk('index.html 含 <script src="./' + s.file + '">', html.includes('src="./' + s.file + '"'), true)
  }
  // 顺带守住一个真实坑：renderer.js 在本页**先于**这些模块加载，
  // 所以它们只能被"延迟使用"，不能在 renderer 模块顶层读全局。
  const iRenderer = html.indexOf('src="./renderer.js"')
  const iProblems = html.indexOf('src="./problem-model.js"')
  chk('renderer.js 确实在这些模块之前加载（说明必须延迟使用）', iRenderer > 0 && iProblems > iRenderer, true)
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
