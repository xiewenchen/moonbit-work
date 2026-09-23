// LSP 解析器单测（纯 Node，无需 Electron）： node test-lsp.js
const { parseDiagnostics, parseOutline } = require('./lsp-parse')

let failed = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('[PASS]', name)
  } else {
    failed++
    console.log('[FAIL]', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}

// --- 诊断解析：真实 moon check 输出样本 ---
const diagSample = [
  'Error: [4021]',
  '   \u256d\u2500[ C:\\proj\\kernel\\diagprobe.mbt:2:3 ]',
  '   \u2502',
  ' 2 \u2502   undefined_symbol_xyz',
  '   \u2502   \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  '   \u2502             \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 The value identifier undefined_symbol_xyz is unbound.',
  '\u2500\u2500\u2500\u256f',
  'Failed with 0 warnings, 1 errors.',
  'Error: failed to run check for target Native',
  '',
  'Warning: [0006]',
  '   \u256d\u2500[ C:\\proj\\kernel\\other.mbt:10:3 ]',
  '   \u2502',
  '   \u2502             \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 unused',
  '\u2500\u2500\u2500\u256f',
].join('\r\n')

const diags = parseDiagnostics(diagSample)
check('诊断条数 = 2', diags.length === 2, diags)
check(
  '第 1 条为 error 且位置正确',
  diags[0] &&
    diags[0].severity === 'error' &&
    diags[0].code === '4021' &&
    diags[0].line === 2 &&
    diags[0].col === 3 &&
    /unbound/.test(diags[0].message) &&
    diags[0].file.endsWith('diagprobe.mbt'),
  diags[0],
)
check(
  '第 2 条为 warning',
  diags[1] && diags[1].severity === 'warning' && diags[1].code === '0006',
  diags[1],
)
check(
  '过滤掉非 .mbt 的整体错误',
  diags.every((d) => d.file.endsWith('.mbt')),
  diags.map((d) => d.file),
)

// --- 诊断解析：空 / 无错输出 ---
check('无错误输出 → 空数组', parseDiagnostics('Finished. moon: no work to do').length === 0)
check('空字符串 → 空数组', parseDiagnostics('').length === 0)

// --- 大纲解析：真实 moon ide outline 样本 ---
const outlineSample = [
  '  9 |pub(all) struct CommandOutput {',
  '    |...',
  ' 17 |pub async fn run_capture(',
  ' 18 |  program : String,',
  '    |...',
  ' 45 |fn unquote(s : String) -> String {',
  '    |...',
].join('\n')
const syms = parseOutline(outlineSample)
check('大纲条数 = 4', syms.length === 4, syms)
check(
  '大纲首项正确',
  syms[0] && syms[0].line === 9 && /struct CommandOutput/.test(syms[0].text),
  syms[0],
)
check('大纲跳过省略行', !syms.some((s) => s.text === '...'))

// --- 大纲解析：空 ---
check('空大纲 → 空数组', parseOutline('').length === 0)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
