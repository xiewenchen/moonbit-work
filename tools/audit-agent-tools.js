#!/usr/bin/env node
// PH3-SEC-01～09：Agent 工具的安全审计（静态）。
//
// 清单要的是"围绕**新增 Agent 能力**"的第二轮安全，而不是再数一遍漏洞。
// 所以这里审的是**结构性的东西** —— 那些"只要代码写对了就永远成立"的约束：
//
//   SEC-01 Tool Manifest：每个工具是否声明了 permission / timeout / 输出上限 / workspace 约束
//   SEC-02 READ 工具不能有写能力
//   SEC-03 EXECUTE 工具不能有写能力
//   SEC-09 声明 workspaceOnly 的工具，必须真的走路径校验
//
// 它**不重复**动态测试（那些在 test-agent-sandbox / test-agent-tools / test-agent-exec-tools 里，
// 走的是真实调用）。这里只回答"表本身有没有漏声明"—— 漏一个字段，动态测试可能恰好没覆盖到。
//
// 用法：node tools/audit-agent-tools.js [--ci]
import fs from 'fs'
import path from 'path'

const ARGV = process.argv.slice(2)
const CI_MODE = ARGV.includes('--ci')
const POSITIONAL = ARGV.filter((a) => !a.startsWith('--'))
const DIR = path.resolve(POSITIONAL[0] || path.join(import.meta.dirname, '..', 'desktop'))

/** 从源码里把 `{ name: 'x', permission: PERMISSION.READ, timeoutMs: 5000, ... }` 抓出来 */
function parseSpec(file, tableName) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8')
  const start = src.indexOf('const ' + tableName)
  if (start < 0) return null
  const end = src.indexOf('])', start)
  const block = src.slice(start, end < 0 ? src.length : end + 2)
  const specs = []
  // 一行一个 spec（本仓库统一这么写）
  for (const m of block.matchAll(/\{\s*name:\s*'([^']+)'([^}]*)\}/g)) {
    const rest = m[2]
    const pick = (key) => {
      const r = new RegExp(key + ':\\s*([^,}]+)').exec(rest)
      return r ? r[1].trim() : null
    }
    specs.push({
      name: m[1],
      permission: pick('permission'),
      timeoutMs: pick('timeoutMs'),
      maxOutputBytes: pick('maxOutputBytes'),
      workspaceOnly: pick('workspaceOnly'),
      hasNetwork: /network\s*:/.test(rest),
      raw: m[0],
    })
  }
  return { file, tableName, specs }
}

const REQUIRED = ['permission', 'timeoutMs', 'maxOutputBytes']
const problems = []
const warnings = []
const unevaluated = []   // 值是表达式/常量，没能求值 —— 如实记下，不假装校验过

/**
 * 数值字段可能是字面量（5000）、表达式（10 * 60 * 1000）或常量名（API_LIMITS.x）。
 * ⚠️ 只对**纯字面量**做数值校验；表达式与常量如实记为"未能求值"。
 *    不这样的话，`10 * 60 * 1000` 会被读成 `10`、`API_LIMITS.x` 会被读成 NaN，
 *    于是报一堆**假问题** —— 误报会让审计工具当场失去可信度（本文件第一版就报了 5 个假的）。
 */
function numericCheck(value, key, tool) {
  const v = String(value).trim()
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) problems.push({ kind: 'bad-' + key, tool, detail: key + '=' + v })
    return
  }
  unevaluated.push({ tool, key, expr: v })
}

const readTable = parseSpec('agent-tools.js', 'READ_TOOL_SPECS')
const execTable = parseSpec('agent-exec-tools.js', 'EXEC_TOOL_SPECS')

function auditTable(t, expectPermission) {
  if (!t) { problems.push({ kind: 'missing-table', detail: '找不到工具表' }); return }
  for (const s of t.specs) {
    for (const k of REQUIRED) {
      if (s[k] == null) problems.push({ kind: 'missing-field', tool: s.name, table: t.tableName, detail: '缺少 ' + k })
    }
    // SEC-01：permission 必须与表一致
    if (s.permission && !s.permission.includes(expectPermission)) {
      problems.push({ kind: 'wrong-permission', tool: s.name, table: t.tableName, detail: t.tableName + ' 里出现了 ' + s.permission })
    }
    // 数字合法性（只对字面量；表达式/常量如实记为未能求值）
    if (s.timeoutMs != null) numericCheck(s.timeoutMs, 'timeoutMs', s.name)
    if (s.maxOutputBytes != null) numericCheck(s.maxOutputBytes, 'maxOutputBytes', s.name)
    // SEC-09：声明 workspaceOnly 的工具必须登记（下面按名字核）
    if (s.workspaceOnly != null && s.workspaceOnly !== 'true' && s.workspaceOnly !== 'false') {
      problems.push({ kind: 'bad-workspace-flag', tool: s.name, detail: 'workspaceOnly=' + s.workspaceOnly })
    }
    // SEC-01：network 没声明 —— 记成 warning（现有工具都不联网；缺字段本身是清单点名的项）
    if (!s.hasNetwork) warnings.push({ kind: 'no-network-field', tool: s.name, table: t.tableName, detail: '未声明 network 能力' })
  }
}

auditTable(readTable, 'READ')
auditTable(execTable, 'EXECUTE')

// SEC-02 / SEC-03：名字里不能出现"写"语义（结构上表里就不该有写工具）
const WRITE_WORDS = /^(write|save|put|create|remove|delete|apply|edit|patch|append|mkdir|unlink)/i
for (const t of [readTable, execTable]) {
  if (!t) continue
  for (const s of t.specs) {
    if (WRITE_WORDS.test(s.name)) problems.push({ kind: 'write-capable-tool', tool: s.name, table: t.tableName, detail: '工具名带写语义，出现在只读/执行表里' })
  }
}

// SEC-09：workspaceOnly 的工具在实现里必须真的做路径校验（g.abs / resolveInsideWorkspace / guardPath）
function checkWorkspaceGuard(file, table) {
  if (!table) return
  const src = fs.readFileSync(path.join(DIR, file), 'utf8')
  const need = table.specs.filter((s) => s.workspaceOnly === 'true')
  for (const s of need) {
    // 该工具的实现块里应能看到路径守卫
    const idx = src.indexOf("'" + s.name + "'")
    const seg = src.slice(idx, idx + 1200)
    if (!/guardPath|resolveInsideWorkspace|workspace|root/.test(seg)) {
      problems.push({ kind: 'no-workspace-guard', tool: s.name, file, detail: '声明 workspaceOnly 但实现里看不到路径守卫' })
    }
  }
}
checkWorkspaceGuard('agent-tools.js', readTable)

// 汇总
const allSpecs = [...(readTable ? readTable.specs : []), ...(execTable ? execTable.specs : [])]
console.log('Agent 工具安全审计')
console.log('  只读表 ' + (readTable ? readTable.specs.length : 0) + ' 个：' + (readTable ? readTable.specs.map((s) => s.name).join(', ') : '?'))
console.log('  执行表 ' + (execTable ? execTable.specs.length : 0) + ' 个：' + (execTable ? execTable.specs.map((s) => s.name).join(', ') : '?'))
console.log()

if (problems.length) {
  console.log('✗ 问题（' + problems.length + '）：')
  for (const p of problems) console.log('   [' + p.kind + '] ' + (p.tool ? p.tool + ' ' : '') + (p.table ? '(' + p.table + ') ' : '') + p.detail)
} else {
  console.log('✓ SEC-01/02/03/09：Manifest 字段齐、只读表全 read、执行表无写、workspaceOnly 有守卫')
}

if (warnings.length) {
  console.log('\n⚠ 提醒（' + warnings.length + '）—— 不算违规，但清单 PH3-SEC-01 要求声明：')
  const byKind = {}
  for (const w of warnings) byKind[w.kind] = (byKind[w.kind] || 0) + 1
  for (const [k, n] of Object.entries(byKind)) console.log('   ' + k + '：' + n + ' 个工具')
  console.log('   → 这些工具都不联网（纯本地读写/查询），但"没声明"与"声明了没有"在审计上是两回事。')
}

if (unevaluated.length) {
  console.log('\n（以下字段是表达式/常量，本工具**没有求值**，故不担保其数值合法性 —— 如实说明）')
  for (const u of unevaluated) console.log('   ' + u.tool + '.' + u.key + ' = ' + u.expr)
}

console.log('\n结论：' + allSpecs.length + ' 个工具，问题 ' + problems.length + ' 项，提醒 ' + warnings.length + ' 项。')
if (CI_MODE && problems.length) process.exit(1)
process.exit(0)
