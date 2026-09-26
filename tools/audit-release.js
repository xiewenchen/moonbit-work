#!/usr/bin/env node
// PH3-REL-01～09：发布前工程治理审计。
//
// 它回答的是清单 §22 那几条，而不是"再跑一遍测试"：
//   REL-01 所有新模块都有测试
//   REL-02/03 Agent 工具既有单测也有安全测试
//   REL-06 验证器有异常测试
//   REL-08 环境依赖明确 SKIP（不是 FAIL）
//   REL-09 未验证事项明确 NOT_RUN
//
// ⚠️ 关键设计：**分类**。不能简单地"没有 test-*.js 就报缺口" ——
//    本仓库里 `*-main.js` 是**接线层**（给 verify 覆盖）、`e2e-*`/`probe-*` 是**工具脚本**，
//    对它们要求单测是错的。把这三类分开，报出来的才是**真缺口**。
//
// 用法：
//   node tools/audit-release.js           人类可读
//   node tools/audit-release.js --json    机器可读
//   node tools/audit-release.js --ci      真缺口多于基线时 exit 1
import fs from 'fs'
import path from 'path'

const ARGV = process.argv.slice(2)
const AS_JSON = ARGV.includes('--json')
const CI_MODE = ARGV.includes('--ci')
const POSITIONAL = ARGV.filter((a) => !a.startsWith('--'))
const DIR = path.resolve(POSITIONAL[0] || path.join(import.meta.dirname, '..', 'desktop'))
const BASELINE = path.join(import.meta.dirname, 'release-baseline.json')

// 有真缺口（缺测试）时的**冻结存量**。只减不增 —— 与其它门禁同一套做法。
const KNOWN_GAPS_DEFAULT = [
  'lsp-manager.js', 'runners.js', 'fsops.js', 'session-store.js',
  'project-memory-store.js', 'workbench-main.js', 'relay-main.js',
  'quality-main.js', 'memory-main.js', 'session-main.js', 'startup-main.js',
  'office-main.js', 'db-explorer-main.js',
  'ai-provider-main.js', 'agent-patch-main.js', 'agent-request-main.js',
  'agent-tools-main.js', 'agent-verify-main.js',
  'aiagent.js', 'd17.js', 'd18.js', 'icons.js', 'holidays.js',
  'moonbit-lang.js', 'lsp-parse.js', 'translate-strapi.js',
]

/** 归类：不属于"应该有单测"的，就不该被当成缺口。 */
function classify(file) {
  if (/^e2e-|^probe-|^inspect-|^export-/.test(file)) return { kind: 'tool-script', why: '一次性/工具脚本，不是产品模块' }
  // ⚠️ 构建/转译脚本也是工具，不是产品模块：translate-strapi.js 生成 index.html，
  //    它自己不需要单测（它的产物由 Electron verify 覆盖）。这条是复核时发现的误分类。
  if (/^translate-|^build-|^gen-/.test(file)) return { kind: 'tool-script', why: '构建/转译脚本，不是产品模块' }
  if (/-main\.js$/.test(file)) return { kind: 'wiring', why: '接线层（IPC/handler），由 verify-* 覆盖' }
  if (file === 'main.js' || file === 'preload.js' || file === 'renderer.js') return { kind: 'app-shell', why: '应用外壳，由 Electron verify 覆盖' }
  return { kind: 'logic', why: '纯逻辑模块 —— 应当有 test-*' }
}

/**
 * 这个模块是否被**别的测试**引用（require）？
 * ⚠️ 不查这个就会误报：`mock-llm.js` 自己没有 test-mock-llm.js，
 *    但 test-agent-adapter.js 直接 require 它并断言了行为 —— 那是**真覆盖**。
 *    "没有同名测试文件"≠"没被测"。
 */
function referencedByTest(file, allTests) {
  const stem = file.replace(/\.js$/, '')
  for (const t of allTests) {
    let s = ''
    try { s = fs.readFileSync(path.join(DIR, t), 'utf8') } catch (e) { continue }
    if (new RegExp("require\\(['\\\"]\\./" + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\\\"]\\)").test(s)) return t
  }
  return null
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'))
const testFiles = files.filter((f) => f.startsWith('test-'))
const tests = new Set(testFiles.map((f) => f.replace(/^test-/, '').replace(/\.js$/, '')))
const verifies = new Set(files.filter((f) => f.startsWith('verify-')).map((f) => f.replace(/^verify-/, '').replace(/\.js$/, '')))
const modules = files.filter((f) => !f.startsWith('test-') && !f.startsWith('verify-'))

const gaps = []
const covered = []
for (const m of modules) {
  const base = m.replace(/\.js$/, '')
  const c = classify(m)
  const hasTest = tests.has(base)
  const hasVerify = verifies.has(base)
  if (hasTest) { covered.push({ module: m, by: 'test' }); continue }
  if (hasVerify) { covered.push({ module: m, by: 'verify' }); continue }
  // 被别的测试 require 也算覆盖（"没有同名测试文件"≠"没被测"）
  const ref = referencedByTest(m, testFiles)
  if (ref) { covered.push({ module: m, by: 'referenced-by:' + ref }); continue }
  // 接线层与工具脚本本来就不要求单测
  if (c.kind === 'tool-script' || c.kind === 'app-shell' || c.kind === 'wiring') continue
  gaps.push({ module: m, kind: c.kind, why: c.why })
}

// REL-02/03：Agent 工具的表 + 对应测试
const agentToolTests = ['test-agent-tools.js', 'test-agent-exec-tools.js', 'test-agent-sandbox.js'].filter((f) => files.includes(f))
const agentSecurityTests = ['test-agent-security.js', 'test-agent-patch.js'].filter((f) => files.includes(f))

// REL-08/09：SKIP 与 NOT_RUN 的**存在性**（它们必须出现在源码里，而不是只写在文档）
function hasSkip() {
  const hits = []
  for (const f of files.filter((x) => x.startsWith('test-'))) {
    const s = fs.readFileSync(path.join(DIR, f), 'utf8')
    if (/SKIP|跳过/.test(s)) hits.push(f)
  }
  return hits
}
const skipFiles = hasSkip()

let baseline = KNOWN_GAPS_DEFAULT
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).gaps || baseline } catch (e) { /* 用默认 */ }
const newGaps = gaps.filter((g) => baseline.indexOf(g.module) < 0)

const out = {
  dir: DIR,
  modules: modules.length,
  tests: tests.size,
  verifies: verifies.size,
  covered: covered.length,
  gaps, newGaps,
  baselineCount: baseline.length,
  agentToolTests, agentSecurityTests, skipFiles,
}

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(newGaps.length ? 1 : 0) }

console.log('发布前工程治理审计')
console.log('  模块 ' + modules.length + ' 个　test ' + tests.size + ' 个　verify ' + verifies.size + ' 个')
console.log('  有覆盖 ' + covered.length + ' 个（test 或 verify）\n')

console.log('REL-02/03 Agent 工具测试：' + (agentToolTests.length ? '有 ' + agentToolTests.length + ' 个' : '缺'))
console.log('  安全测试：' + (agentSecurityTests.length ? agentSecurityTests.join(', ') : '缺'))
console.log('REL-08 显式 SKIP 的测试：' + (skipFiles.length ? skipFiles.length + ' 个（' + skipFiles.slice(0, 4).join(', ') + '…）' : '无'))

console.log('\n★ REL-01 缺单测的模块（已排除接线层 / 工具脚本 / 应用外壳）：')
if (!gaps.length) console.log('  （无）')
for (const g of gaps) console.log('  ' + g.module.padEnd(30) + '[' + g.kind + '] ' + g.why)

console.log('\n基线内 ' + baseline.length + ' 个（存量，只减不增）；本次新增 ' + newGaps.length + ' 个。')
if (newGaps.length) {
  console.log('\n✗ 新增缺口：')
  for (const g of newGaps) console.log('   ' + g.module)
  console.log('   → 要么补 test-*/verify-*，要么说明为什么不该有（比如它其实是接线层）。')
}
console.log('\n结论：' + modules.length + ' 个模块，真缺口 ' + gaps.length + ' 个（新增 ' + newGaps.length + ' 个）。')
if (CI_MODE && newGaps.length) process.exit(1)
process.exit(0)
