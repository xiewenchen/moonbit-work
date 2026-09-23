// 扫「空 catch」——**分类统计 + 基线**，因为一刀切会误伤。
//
// 为什么不能直接 `grep "catch (_) {}"`：
//   ① 多行的 catch 抓不到（grep 是按行）
//   ② 更重要：不是所有空 catch 都是 bug。探测/清理型的空 catch 是合理的：
//        try { if (fs.statSync(p).isFile()) return p } catch (_) {}   // 探测存在性
//        try { current.kill() } catch (_) {}                          // 尽力而为地清理
//      有害的是另一种：**吞掉错误后继续走原路径**，让后续逻辑把「读取失败」当成「没有数据」
//      —— 本轮就踩到一次（runNpmTask 把「读不到 package.json」当成「没有 scripts」）。
//
// catch 块分三类：
//   A 完全空：块内去掉空白后为空                 → 明确违规（连说明都没有）
//   B 只有注释：块内只有注释（说明了为何可忽略） → 可接受
//   C 有代码：含 throw / console / return / 赋值等 → 合规
//
// 存量有 90+ 处 A 类，但绝大多数是合理的（探测/清理）。逐个改一遍的收益（风格统一）
// 远小于风险（大 diff、可能引入回归），所以用**冻结存量 + 禁止新增**：
//   把「每个文件现有几处」记进基线，CI 检查「不增加」；改好了就下调基线。
//
// 用法：
//   node tools/check-empty-catch.js            报告分类
//   node tools/check-empty-catch.js --freeze   把当前数字写进基线
//   node tools/check-empty-catch.js --ci       与基线比较，超了就退出码 1（CI 用）
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const BASELINE_FILE = path.join(__dirname, 'empty-catch-baseline.json')
const MODE = process.argv.includes('--freeze') ? 'freeze'
  : process.argv.includes('--ci') ? 'ci' : 'plain'
const TARGETS = ['desktop', 'tools'].map((d) => path.join(ROOT, d))

function listJsFiles(dir, out = []) {
  let es = []
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return out }
  for (const e of es) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) listJsFiles(full, out)
    else if (e.name.endsWith('.js')) out.push(full)
  }
  return out
}

// 从 catch (…) { 的位置出发，花括号配平找块体（跳过字符串与注释里的花括号）
function blockBody(src, braceStart) {
  let depth = 0, i = braceStart
  let inS = null, inLine = false, inBlock = false
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (inLine) { if (c === '\n') inLine = false; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++ } continue }
    if (inS) {
      if (c === '\\') { i++; continue }
      if (c === inS) inS = null
      continue
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue }
    if (c === '/' && n === '*') { inBlock = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return { body: src.slice(braceStart + 1, i), end: i } }
  }
  return null
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// ── 扫描 ────────────────────────────────────────────────────────────────
const A = [], B = []
let total = 0, okCount = 0
for (const dir of TARGETS) {
  for (const file of listJsFiles(dir)) {
    let src = ''
    try { src = fs.readFileSync(file, 'utf8') } catch (_) { continue }
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const re = /catch\s*(\([^)]*\))?\s*\{/g
    let m
    while ((m = re.exec(src))) {
      const blk = blockBody(src, m.index + m[0].length - 1)
      if (!blk) continue
      total++
      const line = src.slice(0, m.index).split('\n').length
      const code = stripComments(blk.body).trim()
      if (code !== '') { okCount++; continue }                  // C：有代码
      if (blk.body.trim() === '') A.push({ rel, line })          // A：连注释都没有
      else B.push({ rel, line, note: blk.body.trim().split('\n')[0].slice(0, 46) })  // B：只有注释
    }
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────
if (MODE === 'plain') {
  console.log('=== catch 块分类（扫 desktop/ 与 tools/）===')
  console.log('  总计 ' + total + ' 个 catch：C 有代码 ' + okCount +
    ' / B 只有注释 ' + B.length + ' / A 完全空 ' + A.length)
  const show = (title, list, limit) => {
    console.log(`\n${title}：${list.length} 处`)
    for (const x of list.slice(0, limit)) {
      console.log('   ' + x.rel + ':' + x.line + (x.note ? '   // ' + x.note : '   ← 完全空'))
    }
    if (list.length > limit) console.log('   …（还有 ' + (list.length - limit) + ' 处）')
  }
  show('❌ A 类：完全空（连说明都没有）', A, 10)
  show('⚠️  B 类：只有注释（说明了为何可忽略）', B, 4)
  console.log('\n判据：A 类一律算违规；B 类可接受（有说明）')
  console.log('（存量 A 类已用基线冻结：--ci 只检查「不新增」）')
  process.exit(0)
}

// ── 基线 ────────────────────────────────────────────────────────────────
const counts = {}
for (const x of A) counts[x.rel] = (counts[x.rel] || 0) + 1

if (MODE === 'freeze') {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(counts, null, 2) + '\n', 'utf8')
  console.log('✓ 基线已写入 ' + path.relative(ROOT, BASELINE_FILE) +
    '（' + Object.keys(counts).length + ' 个文件、合计 ' + A.length + ' 处）')
  process.exit(0)
}

// MODE === 'ci'
let base = {}
try { base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) } catch (_) {}
const baseTotal = Object.values(base).reduce((a, b) => a + b, 0)
const over = []
for (const [f, n] of Object.entries(counts)) {
  const b = base[f] || 0
  if (n > b) over.push(f + '：现在 ' + n + ' 处，基线 ' + b + ' 处')
}
console.log('== 空 catch 基线检查（冻结存量 / 禁止新增）==')
console.log('  当前 A 类 ' + A.length + ' 处；基线 ' + baseTotal + ' 处')
if (over.length) {
  console.log('  ✗ 这些文件的「完全空 catch」比基线多了：')
  for (const o of over) console.log('     ' + o)
  console.log('  → 新增空 catch 时请补 throw / console.error / 明确的降级返回；')
  console.log('     若确实该忽略，写一行注释说明理由（归入 B 类，不算违规）。')
  process.exit(1)
}
console.log('  ✓ 没有新增')
process.exit(0)
