// 演示彩排：按 docs/DEMO.md 的顺序，把**能自动验的步骤**跑一遍，并**掐表**。
//
// 存在理由：稳定性不是"修完已知 bug"，而是"演示当天不翻车"。
// 判据是「操作清单上每一步都在最近点过一遍」——所以把清单变成一条可重复执行的命令。
//
//   node verify-demo.js            跑全部（含 Electron 的，约 3~5 分钟）
//   node verify-demo.js --fast     只跑纯逻辑的（秒级）
//
// 覆盖不到的步骤（LSP 跳转/悬停、AI 回复、后端就绪）会在结尾**明确列出来提醒手点** ——
// 那几处正是"脚本给不了绿灯"的地方，别把它们当已验过。
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { resolveSpawn } = require('./spawn-util')

const FAST = process.argv.includes('--fast')
const DIR = __dirname
const OUT = path.join(DIR, 'demo-rehearsal-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }

// 每步：DEMO.md 的哪一节、命令、期望、耗时基准（秒）
const STEPS = [
  { demo: '1.2 / 1.3', name: '启动：5 个标签 + 无项目态落地', file: 'verify-welcome.js', electron: true, budget: 30 },
  { demo: '4.1~4.3', name: '运行项目 → 抓到 URL → 页面能打开', file: 'verify-run-url.js', electron: true, budget: 90 },
  { demo: '4.5', name: '项目类型识别（含 RuoYi→java）', file: 'test-runner-detect.js', electron: false, budget: 15 },
  { demo: '4.5', name: '顶栏按钮按类型分派', file: 'verify-run-dispatch.js', electron: true, budget: 90 },
  { demo: '5.1~5.5', name: '文件中转站全流程', file: 'verify-relay.js', electron: true, budget: 180 },
  { demo: '6.2~6.3', name: 'AI Agent 配置弹窗（真点击）', file: 'verify-agent-config.js', electron: true, budget: 90 },
  { demo: '2 / 3.5 / 3.6 / 7 / 8', name: '功能体检（23 项）', file: 'e2e-features.js', electron: true, budget: 180, arg: path.join(DIR, '..') },
]

// 脚本覆盖不到的（必须在演示前手点）—— 这是本命令**最该被看见**的部分
const MANUAL = [
  ['3.3', 'Ctrl+点一个函数 → 能跳到定义（依赖 moon-lsp，会降级到符号索引）'],
  ['3.4', '悬停函数 → 出现签名提示'],
  ['6.4', 'AI Agent 发「你好」→ 有流式回复（**免费额度易 429，务必先自测**）'],
  ['6.5', '追问一句 → 它记得上文（多轮 --session）'],
  ['7.2', '后端面板启动后端 → 就绪探针变绿（需 PG + Redis）'],
]

// 用**真实二进制** electron.exe，而不是 `.bin/electron.cmd`：
// 后者是 cmd 包装，配 shell:true 时 cmd.exe 会一直等 Electron 的
// renderer/GPU 子进程 —— 实测把一步 12 秒的验证拖成了 300 秒超时。
const electronBin = process.platform === 'win32'
  ? path.join(DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(DIR, 'node_modules', 'electron', 'dist', 'electron')

// 统一走 resolveSpawn —— 自己拼 `shell:true` + 含空格的绝对路径会把路径拆开
// （`C:\Program Files\nodejs\node.exe` 被切成 `C:\Program`，0.1 秒就失败）。
// 这个坑项目里已有解药，别再踩。
function runStep(file, args) {
  const spec = resolveSpawn(file, args)
  return spawnSync(spec.bin, spec.args, { cwd: DIR, encoding: 'utf8', timeout: 300000, shell: spec.shell })
}

log('=== 演示彩排（自动部分）===' + (FAST ? '  [--fast：只跑纯逻辑]' : ''))
log('按 docs/DEMO.md 的顺序执行；括号里是耗时基准，超太多说明那步不稳。\n')

let pass = 0, fail = 0, slow = []
for (const st of STEPS) {
  if (FAST && st.electron) { log(`  [跳过] ${st.name}（需 Electron）`); continue }
  const t0 = Date.now()
  const r = runStep(st.electron ? electronBin : process.execPath, [st.file].concat(st.arg ? [st.arg] : []))
  const sec = (Date.now() - t0) / 1000
  const ok = r.status === 0
  if (ok) pass++; else fail++
  const over = sec > st.budget ? '  ⚠ 超基准 ' + st.budget + 's' : ''
  if (sec > st.budget) slow.push(st.name + `（${sec.toFixed(0)}s > ${st.budget}s）`)
  log(`  ${ok ? '[通过]' : '[失败]'} ${st.name}  —— ${sec.toFixed(1)}s${over}`)
  if (!ok) {
    // 失败时把脚本自己的结果行摘出来（脚本都把结论写进 xx-result.txt 或 stdout）
    const tail = String(r.stdout || '').split('\n').filter((l) => /FAIL|失败|结果：/.test(l)).slice(-4)
    for (const t of tail) log('        ' + t.trim().slice(0, 140))
  }
}

log('\n=== 汇总 ===')
log(`  自动部分：${pass} 步通过 / ${fail} 步失败`)
if (slow.length) { log('  ⚠ 超过耗时基准的步骤：'); for (const s of slow) log('     ' + s) }
else log('  ✓ 全部在耗时基准内')

log('\n=== 这些**必须手点**（脚本验不了，别当成已验过）===')
for (const [no, what] of MANUAL) log(`  ${no}  ${what}`)
log('\n  手点时只要有一次「怎么没反应」，就先修它，再谈新功能。')

try {
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  console.log('\n结果已写入 ' + path.relative(process.cwd(), OUT))
} catch (e) {
  console.error('\n结果写入失败:', e.message)
  console.error('（本次彩排结果未保存到文件）')
}
process.exit(fail === 0 ? 0 : 1)
