// 桌面安全审计（Phase 2.1 / P17-05、P17-10、P17-11）
//
// 为什么要有这个脚本：靠"读代码时留意一下"是审计不出东西的 ——
// 132 个 IPC、几十个模块，人眼扫不过来，而且**下次改动时没人会再扫一遍**。
// 所以把它做成可重复执行的检查：结论能复现，新增的高危入口会被当场发现。
//
// 检查五件事：
//   ① preload 暴露的 IPC 清单 + 风险分类（P17-05）
//   ② 主进程里"接受任意路径 / 任意命令"的入口（收窄的重点）
//   ③ 渲染侧的危险 API（eval / new Function / innerHTML / 远程加载）
//   ④ Electron 安全开关与 CSP 现状（P17-10）
//   ⑤ 依赖版本是否锁定（P17-11）
//
// 用法：
//   node tools/audit-desktop-security.js          报告
//   node tools/audit-desktop-security.js --ci     高危项与基线比较（多了就失败）
//   node tools/audit-desktop-security.js --freeze 把当前高危清单写进基线
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DESKTOP = path.join(ROOT, 'desktop')
const BASELINE = path.join(__dirname, 'security-audit-baseline.json')
const MODE = process.argv.includes('--freeze') ? 'freeze'
  : process.argv.includes('--ci') ? 'ci' : 'plain'

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8') } catch (e) { return null }
}

function listJs(dir, out = []) {
  let es = []
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return out }
  for (const e of es) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name === 'testdata' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) listJs(full, out)
    else if (e.name.endsWith('.js')) out.push(full)
  }
  return out
}

// ── ① preload IPC 清单（P17-05）───────────────────────────────────────────────
/** 按"这个入口能不能改到东西"分类 —— 决定要不要重点看它 */
function classifyIpc(name) {
  const n = String(name)
  if (/^fs:(write|unlink|mkdir|rename|copy|rm)/.test(n)) return 'WRITE'
  if (/^agent(Patch|Tools|Verify)|^agent:/.test(n)) return 'AGENT'
  if (/^session:|^memory:|^quality:|^aiProvider:/.test(n)) return 'STORAGE'
  if (/^db:|^backend:|^apiDebug:|^apidbg:/.test(n)) return 'EXTERNAL'
  if (/^fs:(read|list)|^lsp:|^project:|^symbols/.test(n)) return 'READ'
  if (/^app:|^window:|^term:|^relay:|^command/.test(n)) return 'LOCAL'
  return 'OTHER'
}

function auditPreload() {
  const file = path.join(DESKTOP, 'preload.js')
  const src = readIfExists(file)
  if (src === null) return { ok: false, error: '读不到 desktop/preload.js', entries: [] }
  const entries = []
  const reInvoke = /(\w+)\s*:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g
  const reOn = /(\w+)\s*:\s*\([^)]*\)\s*=>\s*\{?[^\n]*ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g
  let m
  while ((m = reInvoke.exec(src))) entries.push({ api: m[1], channel: m[2], kind: 'invoke', risk: classifyIpc(m[2]) })
  while ((m = reOn.exec(src))) entries.push({ api: m[1], channel: m[2], kind: 'on', risk: 'EVENT' })
  return { ok: true, entries }
}

// ── ② 危险入口：接受任意路径 / 任意命令（收窄的重点）─────────────────────────
const RISKY_PATTERNS = [
  { re: /ipcMain\.handle\(\s*['"]fs:unlink['"]/, why: 'fs:unlink 可删任意文件', level: 'HIGH' },
  { re: /execSync\(|exec\([^)]*shell\s*:\s*true|shell\s*:\s*true/, why: 'shell 执行：参数拼接时容易变成命令注入', level: 'MEDIUM' },
  { re: /spawn\([^)]*shell\s*:\s*true/, why: 'spawn(shell:true)：Windows 上还会留孤儿进程', level: 'MEDIUM' },
  { re: /eval\s*\(/, why: 'eval：桌面端不该出现', level: 'HIGH' },
  { re: /new\s+Function\s*\(/, why: 'new Function：等价于 eval', level: 'HIGH' },
]

/**
 * `fs:write` 单独查：关键在于**它有没有限定目录**，而不是“有没有这个 handler”。
 * （P17-02 之后它已经走 `guardWritePath` 限定在工作区 —— 只匹配 handler 名会永远报高危，
 *   而一条永远红的规则等于没有规则。）
 */
function auditWriteGuard() {
  const src = readIfExists(path.join(DESKTOP, 'main.js')) || ''
  const at = src.indexOf("ipcMain.handle('fs:write'")
  if (at < 0) return { level: null, note: '没有 fs:write' }
  const body = src.slice(at, at + 1600)
  const guarded = /guardWritePath|path\.relative\(ws/.test(body)
  return guarded
    ? { level: null, note: 'fs:write 已限定在工作区内（guardWritePath）' }
    : { level: 'HIGH', file: 'desktop/main.js', line: src.slice(0, at).split('\n').length, why: 'fs:write 接受任意绝对路径（渲染侧可写任意文件）', code: "ipcMain.handle('fs:write', …)" }
}

function auditRisky() {
  const hits = []
  for (const f of listJs(DESKTOP)) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    const src = readIfExists(f) || ''
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      for (const p of RISKY_PATTERNS) {
        if (p.re.test(line)) {
          // 测试脚本里的 eval 之类不算（它们本来就在造场景）
          const isTest = /\/(test|verify)-/.test(rel)
          hits.push({ file: rel, line: i + 1, level: isTest ? 'LOW' : p.level, why: p.why, code: line.trim().slice(0, 100) })
        }
      }
    })
  }
  return hits
}

// ── ③ 渲染侧危险 API ─────────────────────────────────────────────────────────
function auditRenderer() {
  // 注意：这里扫的是**几个主要的渲染侧脚本**，不是全部 —— 范围写在名字里，免得高估覆盖面。
  const targets = ['renderer.js', 'aiagent.js', 'dash.js', 'relay.js', 'theme.js', 'icons.js']
  const hits = []
  for (const name of targets) {
    const src = readIfExists(path.join(DESKTOP, name))
    if (src === null) continue
    src.split('\n').forEach((line, i) => {
      // 只报**非空赋值**：`innerHTML = ''` 是清空操作。
      // 判定要允许它出现在 `() => (el.innerHTML = '')` 这种括号里 ——
      // 第一版因此多报了一处，第二版把 20 处清空操作全报成“XSS 面”（都是误报）。
      const m = /\.innerHTML\s*=\s*(.*)$/.exec(line)
      if (m && !/^\s*''\s*[),;}\s]*$/.test(m[1])) {
        hits.push({ file: 'desktop/' + name, line: i + 1, what: 'innerHTML 非空赋值（需看内容来源是否含用户输入）', code: line.trim().slice(0, 90) })
      }
      // 只认真正的**外链**（<script src=“https://…”> / <link href=“https://…”>）。
      // 不能拿“行里有 http 链接”当判据 —— `$schema: ‘https://…’` 这种 JSON 字段会被误报。
      if (/(<script[^>]*\bsrc|<link[^>]*\bhref)\s*=\s*['"]https?:\/\//i.test(line)) {
        hits.push({ file: 'desktop/' + name, line: i + 1, what: '远程加载脚本/样式（供应链面）', code: line.trim().slice(0, 90) })
      }
    })
  }
  return hits
}

// ── ④ Electron 开关 + CSP（P17-10）──────────────────────────────────────────
function auditElectronConfig() {
  const src = readIfExists(path.join(DESKTOP, 'main.js')) || ''
  const get = (k) => {
    const m = new RegExp(k + '\\s*:\\s*(\\w+)').exec(src)
    return m ? m[1] : null
  }
  return {
    contextIsolation: get('contextIsolation'),
    nodeIntegration: get('nodeIntegration'),
    sandbox: get('sandbox'),
    webSecurity: get('webSecurity'),
    cspInMain: /Content-Security-Policy/.test(src),
    cspInHtml: /Content-Security-Policy/.test(readIfExists(path.join(DESKTOP, 'index.html')) || ''),
  }
}

// ── ⑤ 依赖版本锁定（P17-11）─────────────────────────────────────────────────
function auditDeps() {
  const pkgRaw = readIfExists(path.join(DESKTOP, 'package.json'))
  if (pkgRaw === null) return { ok: false, deps: [], floating: [] }
  let pkg = {}
  try { pkg = JSON.parse(pkgRaw) } catch (e) { return { ok: false, deps: [], floating: [] } }
  const all = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {})
  const floating = Object.entries(all)
    .filter(([, v]) => /^[\^~]|^\*$|^latest$|^>/.test(String(v)))
    .map(([k, v]) => k + '@' + v)
  return { ok: true, deps: Object.entries(all).map(([k, v]) => k + '@' + v), floating }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
const preload = auditPreload()
const risky = auditRisky()
const writeGuard = auditWriteGuard()
if (writeGuard.level === 'HIGH') risky.push(writeGuard)
const renderer = auditRenderer()
const electron = auditElectronConfig()
const deps = auditDeps()

const byRisk = {}
for (const e of preload.entries) byRisk[e.risk] = (byRisk[e.risk] || 0) + 1

const highRisky = risky.filter((h) => h.level === 'HIGH')
const medRisky = risky.filter((h) => h.level === 'MEDIUM')

// 高危清单的指纹（供基线比较：新增了就失败）
const fingerprints = highRisky.map((h) => h.file + ':' + h.line + ' ' + h.why)

if (MODE === 'freeze') {
  fs.writeFileSync(BASELINE, JSON.stringify({
    note: '桌面安全审计的高危项基线。新增高危项时，请修掉或在代码里说明为何可接受。',
    high: fingerprints,
    electron,
    floatingDeps: deps.floating,
  }, null, 2) + '\n', 'utf8')
  console.log('== 已冻结安全基线 ==')
  console.log('  高危 ' + fingerprints.length + ' 项；浮动依赖 ' + deps.floating.length + ' 个')
  process.exit(0)
}

if (MODE === 'ci') {
  let base = null
  try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) } catch (e) { base = null }
  console.log('== 桌面安全审计（高危项只减不增）==')
  if (!base) {
    console.log('  ✗ 读不到基线，先跑 --freeze')
    process.exit(1)
  }
  const baseSet = new Set(base.high || [])
  const added = fingerprints.filter((f) => !baseSet.has(f))
  console.log('  高危项：' + fingerprints.length + '（基线 ' + baseSet.size + '）')
  console.log('  IPC 入口：' + preload.entries.length + ' 个 ｜ 分类 ' + JSON.stringify(byRisk))
  console.log('  浮动依赖：' + deps.floating.length + ' 个（基线 ' + (base.floatingDeps || []).length + '）')
  if (added.length) {
    console.log('  ✗ 新增高危项：')
    for (const a of added) console.log('     ' + a)
    process.exit(1)
  }
  console.log('  ✓ 没有新增高危项')
  process.exit(0)
}

// plain：完整报告
console.log('== 桌面安全审计 ==')
console.log('\n[① P17-05] preload 暴露的 IPC：' + preload.entries.length + ' 个')
console.log('   分类：' + JSON.stringify(byRisk, null, 0))
for (const risk of ['WRITE', 'AGENT', 'EXTERNAL', 'STORAGE']) {
  const list = preload.entries.filter((e) => e.risk === risk)
  if (!list.length) continue
  console.log('   [' + risk + '] ' + list.map((e) => e.api + ' → ' + e.channel).join('、'))
}
console.log('\n[② 危险入口] 高危 ' + highRisky.length + ' 项，中危 ' + medRisky.length + ' 项')
console.log('   fs:write 守卫：' + writeGuard.note)
for (const h of highRisky) console.log('   [HIGH] ' + h.file + ':' + h.line + '  ' + h.why + '\n          ' + h.code)
for (const h of medRisky.slice(0, 8)) console.log('   [MED ] ' + h.file + ':' + h.line + '  ' + h.why)
console.log('\n[③ 渲染侧] ' + renderer.length + ' 处需要留意')
for (const r of renderer.slice(0, 10)) console.log('   ' + r.file + ':' + r.line + '  ' + r.what)
console.log('\n[④ P17-10 Electron 开关]')
console.log('   contextIsolation=' + electron.contextIsolation + '  nodeIntegration=' + electron.nodeIntegration +
  '  sandbox=' + electron.sandbox + '  webSecurity=' + electron.webSecurity)
console.log('   CSP：main.js ' + (electron.cspInMain ? '有' : '无') + ' ／ index.html ' + (electron.cspInHtml ? '有' : '无'))
console.log('\n[⑤ P17-11 依赖] 共 ' + deps.deps.length + ' 个，其中浮动（^/~/latest）' + deps.floating.length + ' 个')
if (deps.floating.length) console.log('   ' + deps.floating.join('、'))
