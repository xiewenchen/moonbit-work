#!/usr/bin/env node
// PH3-IPC-01/02/03：IPC 清单 —— 按领域分类、按风险分级、找重复与"未配对"。
//
// 为什么需要它：桌面已经 130+ 个 IPC 入口，只靠记忆没法回答
//   · 哪些是文件写、哪些会起进程（危险面）
//   · 有没有两个名字在说同一件事（getProject / projectInfo / currentProject）
//   · **有没有"调了但没人实现"的 channel**（那种点了完全没反应，且不报错）
//
// 输出（清单 §15 PH3-IPC-01 要的形状）：channel / owner / risk / 领域
//
// 用法：
//   node tools/audit-ipc.js            人类可读清单
//   node tools/audit-ipc.js --json     机器可读（给别的工具用）
//   node tools/audit-ipc.js --ci       只在"未配对"非空时 exit 1
import fs from 'fs'
import path from 'path'

const ARGV = process.argv.slice(2)
const AS_JSON = ARGV.includes('--json')
const CI_MODE = ARGV.includes('--ci')
const POSITIONAL = ARGV.filter((a) => !a.startsWith('--'))
const DIR = path.resolve(POSITIONAL[0] || path.join(import.meta.dirname, '..', 'desktop'))

// 领域：按 channel 前缀/关键词归类（清单 §15 PH3-IPC-02 的九类）
const DOMAINS = [
  ['project', /^(project|project:|newProject|pickProjectPath|openProject|closeProject|fs:|file:|dir:)/i],
  ['file', /^(fs|file|dir|relay|office)/i],
  ['runner', /^(runner|run:|project\.run|project\.stop|be)/i],
  ['lsp', /^(lsp|outline|symbols|hover|completion|definition)/i],
  ['agent', /^(agent|aiAgent|memory|session|workbench|wb)/i],
  ['provider', /^(aiProvider|provider)/i],
  ['database', /^(db|database|sql)/i],
  ['quality', /^(quality|problems|env|startup|app:)/i],
]

// 风险：会写盘 / 会起进程 / 会碰密钥的，都要标出来（PH3-IPC-05）
const RISK = [
  ['write', /\b(write|save|set|put|update|remove|delete|rm|clear|apply|restore|create|mkdir|unlink)\b/i],
  ['exec', /\b(run|spawn|exec|start|stop|kill|build|test|install|open)\b/i],
  ['secret', /\b(key|token|secret|provider|config)\b/i],
  ['read', /^(read|get|list|load|snapshot|status|info|check|detect|parse|audit)/i],
]

function domainOf(ch) {
  for (const [name, re] of DOMAINS) if (re.test(ch)) return name
  return 'other'
}
function riskOf(ch) {
  const hits = []
  for (const [name, re] of RISK) if (re.test(ch)) hits.push(name)
  return hits.length ? hits.join('+') : 'read'
}

/** 收集所有 handler（定义）与 invoke（调用） */
function scan(dir) {
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.startsWith('test-') && !n.startsWith('verify-'))
  const handlers = []   // { channel, file, line }
  const invokes = []    // { channel, file, line }
  const H_RE = /ipcMain\.handle\(\s*'([^']+)'/g
  const I_RE = /ipcRenderer\.invoke\(\s*'([^']+)'/g
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const m of src.matchAll(H_RE)) handlers.push({ channel: m[1], file: f, line: src.slice(0, m.index).split('\n').length })
    for (const m of src.matchAll(I_RE)) invokes.push({ channel: m[1], file: f, line: src.slice(0, m.index).split('\n').length })
  }
  return { handlers, invokes }
}

/** 找出"说同一件事"的名字：去掉分隔符与常见后缀后相同/相近 */
function nearDuplicates(channels) {
  const norm = (s) => s.toLowerCase()
    .replace(/^(get|fetch|load|read)/, '')
    .replace(/(info|status|state|current|now)$/g, '')
    .replace(/[:_\-.]/g, '')
  const byNorm = new Map()
  for (const ch of channels) {
    const k = norm(ch)
    if (!k) continue
    if (!byNorm.has(k)) byNorm.set(k, [])
    byNorm.get(k).push(ch)
  }
  return Array.from(byNorm.entries()).filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: k, channels: v.slice().sort() }))
}

const { handlers, invokes } = scan(DIR)
const hChannels = Array.from(new Set(handlers.map((h) => h.channel))).sort()
const iChannels = Array.from(new Set(invokes.map((i) => i.channel))).sort()
const unpairedInvokes = iChannels.filter((c) => !hChannels.includes(c))   // 调了没人实现
const unpairedHandlers = hChannels.filter((c) => !iChannels.includes(c))  // 实现了没人调（可能是给 Agent 用的）
const dups = nearDuplicates(hChannels)

const byDomain = {}
for (const ch of hChannels) {
  const d = domainOf(ch)
  byDomain[d] = byDomain[d] || []
  byDomain[d].push(ch)
}
const risky = hChannels.map((ch) => ({ channel: ch, risk: riskOf(ch), domain: domainOf(ch), owner: (handlers.find((h) => h.channel === ch) || {}).file || null }))
  .filter((x) => /write|exec|secret/.test(x.risk))

if (AS_JSON) {
  console.log(JSON.stringify({
    dir: DIR, handlers: hChannels.length, invokes: iChannels.length,
    byDomain: Object.fromEntries(Object.entries(byDomain).map(([k, v]) => [k, v.length])),
    risky, duplicates: dups, unpairedInvokes, unpairedHandlers,
  }, null, 2))
  process.exit(0)
}

console.log('IPC 清单　（' + DIR + '）')
console.log('  handler ' + hChannels.length + ' 个　invoke ' + iChannels.length + ' 个\n')

console.log('按领域（PH3-IPC-02）：')
for (const [d, list] of Object.entries(byDomain).sort((a, b) => b[1].length - a[1].length)) {
  console.log('  ' + d.padEnd(10) + list.length + ' 个')
}

console.log('\n风险（PH3-IPC-05：会写盘 / 起进程 / 碰密钥的）：')
for (const x of risky) console.log('  [' + x.risk.padEnd(12) + '] ' + x.channel.padEnd(28) + ' ' + (x.owner || ''))

console.log('\n★ 未配对 —— 调用方存在但**没有 handler**（点了会静默没反应）：')
if (!unpairedInvokes.length) console.log('  （无）')
for (const c of unpairedInvokes) {
  const where = invokes.filter((i) => i.channel === c).map((i) => i.file + ':' + i.line).join(', ')
  console.log('  ' + c + '   ← ' + where)
}

console.log('\n有 handler 但没人 invoke（可能是给 Agent / 事件用的，属正常）：')
console.log('  ' + (unpairedHandlers.length ? unpairedHandlers.join(', ') : '（无）'))

console.log('\n疑似重复（PH3-IPC-03：多个名字在说同一件事）：')
if (!dups.length) console.log('  （无）')
for (const d of dups) console.log('  ' + d.channels.join('  /  '))

console.log('\n结论：' + hChannels.length + ' 个入口，其中高危 ' + risky.filter((x) => /write|exec/.test(x.risk)).length +
  ' 个、疑似重复 ' + dups.length + ' 组、未配对 ' + unpairedInvokes.length + ' 个。')
if (CI_MODE && unpairedInvokes.length) {
  console.log('\n✗ 有未配对的 invoke —— 这些调用点会静默失败，必须修。')
  process.exit(1)
}
process.exit(0)
