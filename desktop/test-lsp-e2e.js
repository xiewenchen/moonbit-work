// LSP 端到端实证：用**真实的 moon 命令输出**验证解析链路。
// 运行： node test-lsp-e2e.js   （需要 PATH 里有 moon）
const { spawn } = require('child_process')
const { parseDiagnostics, parseOutline } = require('./lsp-parse')

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('moon', args, { cwd })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
    child.on('error', (e) => resolve({ code: -1, out: String(e) }))
  })
}

const ROOT = '..'
let failed = 0
function check(name, cond, extra) {
  if (!cond) failed++
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name, cond ? '' : JSON.stringify(extra))
}

;(async () => {
  // 1) 大纲：真实 `moon ide outline`
  const o = await run(['ide', 'outline', 'kernel/kernel.mbt'], ROOT)
  const syms = parseOutline(o.out)
  console.log('  outline 原始输出前 3 行:', o.out.split(/\r?\n/).slice(0, 3).join(' / '))
  check('outline 解析出符号', syms.length > 5, syms.length)
  check(
    'outline 含 run_capture',
    syms.some((s) => s.text.includes('run_capture')),
    syms.map((s) => s.text),
  )
  check('outline 行号合理(>0)', syms.every((s) => s.line > 0))

  // 2) 诊断：真实 `moon check --target native`（当前仓库应无错误）
  const c = await run(['check', '--target', 'native'], ROOT)
  const diags = parseDiagnostics(c.out)
  console.log('  check exit =', c.code, ' 诊断数 =', diags.length)
  // 注意：判断"干净"要看 **error**，不是"零诊断" ——
  // conduit 的测试文件里有一批 `test_unqualified_package` 的 **warning**（MoonBit 的提示），
  // 它们不影响正确性。原来这里要求 `diags.length === 0`，于是这条断言长期是红的。
  const errs = (diags || []).filter((d) => d.severity === 'error')
  check('干净仓库 check 无 error（warning 允许）', errs.length === 0, errs)

  console.log(failed === 0 ? '\n端到端：全部通过' : `\n端到端：${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
})()
