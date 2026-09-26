// PH3-SEC-04～09：**在真实路径上**复核 Agent 的安全边界。
//
// 为什么单独做这一批：这些约束"代码里写着"已经很久了，但"写着"不等于"成立" ——
// 例如 `providers.json` 在用户目录，它是不是**真的**被路径沙箱挡住？
// 所以每一条都**真调一次** API，并断言副作用（文件有没有被改）。
//
// ⚠️ 全程用临时 workspace（mkdtemp），结束时清理；**绝不碰真实项目与真实用户目录**。
const { createHarness } = require('./verify-harness')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { resolveInsideWorkspace, isDestructiveTarget } = require('./agent-sandbox')
const { createPatch, isDangerousPatch, applyPatch } = require('./agent-patch')
const { createReadOnlyToolRegistry } = require('./agent-tools')

const H = createHarness()
const { chk, eq } = H

// ⚠️ 包在 async 函数里：Node 24 不允许"顶层 await + require"共存
// （ERR_AMBIGUOUS_MODULE_SYNTAX）。这已是**第三次**踩同一个坑（记忆 js-toplevel-await-with-require）——
// 结论：**写了 await 的文件，从第一行就把它包起来**，别等报错再回头改。
async function main() {

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ph3sec-'))
const USERDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ph3sec-user-'))

// 铺一个像样的 workspace
fs.mkdirSync(path.join(WS, '.git'), { recursive: true })
fs.mkdirSync(path.join(WS, '.moonbit-work'), { recursive: true })
fs.mkdirSync(path.join(WS, 'src'), { recursive: true })
fs.writeFileSync(path.join(WS, 'src', 'main.mbt'), 'fn main { println("a") }\n', 'utf8')
fs.writeFileSync(path.join(WS, '.moonbit-work', 'agent-rules.md'), '# 规则\n- 只允许 SELECT\n', 'utf8')
fs.writeFileSync(path.join(WS, '.git', 'config'), '[core]\n', 'utf8')
fs.writeFileSync(path.join(WS, '.env'), 'SECRET=1\n', 'utf8')
fs.writeFileSync(path.join(WS, 'id_rsa'), 'PRIVATE\n', 'utf8')
fs.writeFileSync(path.join(WS, 'cert.pem'), 'CERT\n', 'utf8')
// 用户目录里的敏感文件（**都在 workspace 之外**）
fs.writeFileSync(path.join(USERDIR, 'providers.json'), JSON.stringify({ name: 'x', apiKey: 'sk-REAL-KEY-123456' }), 'utf8')

const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch (_) { return null } }

// ⚠️ applyPatch 要注入 readFile/writeFile（它自己不碰 fs）—— 与生产里同一套约定
const IO = {
  readFile: async (abs) => fs.readFileSync(abs, 'utf8'),
  writeFile: async (abs, text) => { fs.writeFileSync(abs, text, 'utf8') },
  // ⚠️ applyPatch 要的是**回调**（生产里就是「用户点 Apply」那个按钮）——
  //    传 confirm: true 无效，它只认函数（这次写了才发现）。
  confirm: async () => true,
}

// 「没有用户确认」的 IO —— 用来验"未确认时必须拒"（这才是规则文件真正的保护）
const IO_NO_CONFIRM = {
  readFile: async (abs) => fs.readFileSync(abs, 'utf8'),
  writeFile: async (abs, text) => { fs.writeFileSync(abs, text, 'utf8') },
}
const cleanup = () => {
  for (const d of [WS, USERDIR]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} }
}

console.log('=== ① SEC-09 路径沙箱：workspace 外一律拒绝 ===')
{
  const inside = resolveInsideWorkspace(WS, 'src/main.mbt')
  eq('★ workspace 内 → 允许', inside.ok, true)
  chk('  给出绝对路径', !!inside.path && inside.path.replace(/\\/g, '/').endsWith('/src/main.mbt'), String(inside.path))

  for (const bad of ['../outside.txt', '..\\outside.txt', '/etc/passwd', 'C:/Windows/System32/drivers/etc/hosts']) {
    const r = resolveInsideWorkspace(WS, bad)
    eq('★ 拒绝 workspace 外：' + bad, r.ok, false)
    chk('  说明原因', /outside|越界|不允许|workspace/i.test(String(r.error)), String(r.error))
  }
  // ★ 用户目录里的 Provider 文件（真实位置）也必须在外面
  const providerPath = path.join(USERDIR, 'providers.json')
  eq('★★ providers.json（用户目录）在 workspace 之外 → 拒绝', resolveInsideWorkspace(WS, providerPath).ok, false)
  // 前缀相近的兄弟目录不能蒙混
  eq('★ 前缀相近的兄弟目录也拒', resolveInsideWorkspace(WS, WS + '-evil/x.txt').ok, false)
  chk('★ workspace 根本身被认成"破坏性目标"（返回布尔）', isDestructiveTarget(WS, '.') === true, String(isDestructiveTarget(WS, '.')))
}

console.log('\n=== ② SEC-04/05 Patch：只能改 workspace 内、且不能碰敏感文件 ===')
{
  // ④ 只能 workspace 内
  const outPatch = createPatch({ file: '../outside.mbt', old: 'a', new: 'b' })
  const r1 = await applyPatch(outPatch, Object.assign({ root: WS, confirm: true }, IO))
  eq('★ workspace 外的 Patch → 拒', r1.ok, false)
  chk('  原因指向 workspace', /outside-workspace|workspace/i.test(String(r1.reason || r1.error)), String(r1.reason || r1.error))
  chk('  ★ 且文件根本没被创建', read(path.resolve(WS, '..', 'outside.mbt')) === null)

  // ⑤ 敏感文件：逐个真跑。
  // ⚠️ 这里只列**危险路径表**里的（.git / .env / id_rsa / *.pem）——
  //    规则文件（.moonbit-work/agent-rules.md）**不在**这张表里，它靠的是③节的“无确认即拒”，
  //    两套机制不同，混在一起测会得出错误结论（我第一版就混了）。
  const sensitive = ['.env', 'id_rsa', 'cert.pem', '.git/config']
  for (const f of sensitive) {
    const p = createPatch({ file: f, old: read(path.join(WS, f)) || '', new: 'HACKED\n' })
    const before = read(path.join(WS, f))
    const r = await applyPatch(p, Object.assign({ root: WS, confirm: true }, IO))
    eq('★ 危险目标被拒：' + f, r.ok, false)
    const after = read(path.join(WS, f))
    eq('  ★ 内容一个字节都没变：' + f, after, before)
    chk('  给出了原因', !!r.reason || !!r.error, JSON.stringify(r.reason || r.error))
  }
  chk('真正危险判定表认得 .pem/.key', isDangerousPatch({ file: 'a/b.pem' }, { root: WS }).danger === true)
  chk('  也认得 .git/', isDangerousPatch({ file: '.git/config' }, { root: WS }).danger === true)

  // 正常文件**应当**能改（否则边界就变成了"什么都不让做"）
  const okPatch = createPatch({ file: 'src/main.mbt', old: 'println("a")', new: 'println("b")' })
  const r2 = await applyPatch(okPatch, Object.assign({ root: WS, confirm: true, backup: false }, IO))
  eq('★ workspace 内的普通源码 → 允许', r2.ok, true)
  chk('  且真的写进去了', /println\("b"\)/.test(String(read(path.join(WS, 'src', 'main.mbt')))), String(read(path.join(WS, 'src', 'main.mbt'))).slice(0, 40))
}

console.log('\n=== ③ SEC-06 规则文件：**没有用户确认就必须拒** ===')
{
  const rulesPath = path.join(WS, '.moonbit-work', 'agent-rules.md')
  const before = read(rulesPath)
  const mk = () => createPatch({ file: '.moonbit-work/agent-rules.md', old: '- 只允许 SELECT', new: '- 什么都允许' })

  // ★★ 关键：规则文件**不在**危险路径表里（表里只有 .git/.env/id_rsa/*.pem 这类）——
  //     它靠的是“**没有 confirm 就拒绝**”这一道。所以这里必须用**没有确认**的调用来验。
  const noConfirm = await applyPatch(mk(), Object.assign({ root: WS, backup: false }, IO_NO_CONFIRM))
  eq('★★ 无用户确认 → 拒（not-confirmed）', noConfirm.ok, false)
  eq('  原因就是未确认', noConfirm.reason, 'not-confirmed')
  eq('★★ 内容未变', read(rulesPath), before)
  chk('  ★ 并给出了预览（让用户知道要改什么）', /只允许 SELECT/.test(String(noConfirm.preview || '')), String(noConfirm.preview || '').slice(0, 80))
  // 与普通源码对比：同样“未确认”下也应当拒 —— 这是**统一**的闸，不是只护规则文件
  const srcNo = await applyPatch(createPatch({ file: 'src/main.mbt', old: 'println("b")', new: 'println("c")' }),
    Object.assign({ root: WS, backup: false }, IO_NO_CONFIRM))
  eq('★ 普通源码在未确认下也拒（同一道闸，不搞特殊）', srcNo.ok, false)
  eq('  原因一致', srcNo.reason, 'not-confirmed')
}

console.log('\n=== ③bis 但“确认了就能改”：规则文件不是永远锁死 ===')
{
  // 这一点很重要：清单说的是“**无确认**不能改”，不是“永远不能改”。
  // 所以确认之后应当能改（否则用户自己就改不了了）。
  const rulesPath = path.join(WS, '.moonbit-work', 'agent-rules.md')
  const r = await applyPatch(createPatch({ file: '.moonbit-work/agent-rules.md', old: '- 只允许 SELECT', new: '- 只允许 SELECT（用户已确认）' }),
    Object.assign({ root: WS, confirm: async () => true, backup: false }, IO))
  eq('★ 用户确认后 → 允许（否则用户自己也改不了）', r.ok, true)
  chk('  内容真的改了', /用户已确认/.test(String(read(rulesPath))), String(read(rulesPath)).slice(0, 60))
}

console.log('\n=== ④ SEC-07/08 Provider Key：不可改、不可读（用真实路径试）===')
{
  const providerFile = path.join(USERDIR, 'providers.json')
  const before = read(providerFile)
  chk('  前置：Key 确实在那个文件里', /sk-REAL-KEY-123456/.test(String(before)))

  // ⑦ 不可改：直接用绝对路径 Patch 它 → 路径沙箱先拦
  const p = createPatch({ file: providerFile, old: before, new: '{"apiKey":"sk-STOLEN"}' })
  const r = await applyPatch(p, Object.assign({ root: WS, confirm: true }, IO))
  eq('★★ 改 Provider 文件 → 拒', r.ok, false)
  eq('★★ Key 文件内容未变', read(providerFile), before)

  // ⑧ 不可读：只读工具用绝对路径读它 → 也必须拒
  const tools = createReadOnlyToolRegistry({
    rootOf: () => WS,
    readFile: async (abs) => fs.readFileSync(abs, 'utf8'),
    listDir: async () => [],
    search: async () => [],
    symbols: async () => [],
    getDiagnostics: async () => [],
    getRunLog: async () => null,
    getProjectInfo: async () => ({}),
  })
  const readTry = await tools.call('readFile', { path: providerFile })
  eq('★★ Agent 读 Provider 文件 → 拒', readTry.ok, false)
  chk('  ★ 返回值里**不含** Key', readTry.data == null || String(JSON.stringify(readTry.data)).indexOf('sk-REAL-KEY') < 0, JSON.stringify(readTry).slice(0, 160))
  chk('  错误里也不含 Key', String(readTry.error || '').indexOf('sk-REAL-KEY') < 0, String(readTry.error).slice(0, 160))

  // 相对路径穿越也不行
  const readTry2 = await tools.call('readFile', { path: path.relative(WS, providerFile) })
  eq('★ 用相对路径穿越也拒', readTry2.ok, false)
  chk('  且同样不泄漏', String(JSON.stringify(readTry2)).indexOf('sk-REAL-KEY') < 0)
}

console.log('\n=== ⑤ 边界复核：正常读**可以**（否则沙箱就成了"什么都不让读"）===')
{
  const tools = createReadOnlyToolRegistry({
    rootOf: () => WS,
    readFile: async (abs) => fs.readFileSync(abs, 'utf8'),
    listDir: async () => [],
    search: async () => [],
    symbols: async () => [],
    getDiagnostics: async () => [],
    getRunLog: async () => null,
    getProjectInfo: async () => ({}),
  })
  const ok = await tools.call('readFile', { path: 'src/main.mbt' })
  eq('★ workspace 内的文件能读', ok.ok, true)
  chk('  内容拿得到', /println/.test(JSON.stringify(ok.data)), JSON.stringify(ok.data).slice(0, 80))
  // 没打开项目（root 为空）时应当**拒绝**，而不是回退到 cwd
  const noRoot = createReadOnlyToolRegistry({
    rootOf: () => '',
    readFile: async (abs) => fs.readFileSync(abs, 'utf8'),
    listDir: async () => [], search: async () => [], symbols: async () => [],
    getDiagnostics: async () => [], getRunLog: async () => null, getProjectInfo: async () => ({}),
  })
  const nr = await noRoot.call('readFile', { path: path.join(WS, 'src', 'main.mbt') })
  eq('★★ 没打开项目 → 拒（不默默回退到某个目录）', nr.ok, false)
  chk('  说明原因', /未打开项目|no-project|workspace/i.test(String(nr.error)), String(nr.error))
}

console.log('\n=== ⑥ 清理（绝不留临时目录）===')
{
  cleanup()
  chk('临时 workspace 已清理', !fs.existsSync(WS))
  chk('临时用户目录已清理', !fs.existsSync(USERDIR))
  // 顺便确认真实用户目录没被这个测试碰过
  const real = path.join(os.homedir(), '.moonbit-work', 'providers.json')
  chk('★ 真实 providers.json 未被本测试改动（存在则内容仍可读）', !fs.existsSync(real) || typeof fs.readFileSync(real, 'utf8') === 'string')
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  try { cleanup() } catch (_) { /* 清理失败也不掩盖原错误 */ }
  process.exit(1)
})
