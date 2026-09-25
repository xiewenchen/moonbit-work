// 扫「局部 chk 定义」——禁止新增，只允许减少。
//
// 背景（这是本项目真实踩过的坑）：
//   verify-*.js 曾各自实现一份 `chk`，一共 **16 份定义、三种写法**。其中一批是"裸布尔"：
//   只要传进去的是数组，`if (ok)` **恒为真 → 永远打印 [PASS]**。
//   历史上真有 25 处这么白白通过了 —— 等于那些断言从来没验过任何东西。
//
//   现在公共断言在 `desktop/verify-harness.js`：
//     chk(name, ok, detail)  布尔；传非布尔**当场失败**并提示用 eq
//     eq(name, got, want)    深比较，键序无关
//
//   但仍有 14 个脚本带着旧定义（正在逐个迁移）。一刀切改 16 个文件风险大，
//   所以用**基线 + 只减不增**：把「当前还带局部定义的文件」记进基线 JSON，
//   CI 检查「不增加」；每迁完一个就把它从基线里删掉。
//
// 用法：
//   node tools/check-local-chk.js            报告
//   node tools/check-local-chk.js --freeze   把当前文件列表写进基线
//   node tools/check-local-chk.js --ci       与基线比较；多了就退出码 1（CI 用）
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DESKTOP = path.join(ROOT, 'desktop')
const BASELINE_FILE = path.join(__dirname, 'local-chk-baseline.json')
const HARNESS = 'verify-harness.js'      // 公共模块，它**就应该**定义 chk
const MODE = process.argv.includes('--freeze') ? 'freeze'
  : process.argv.includes('--ci') ? 'ci' : 'plain'

/** 判定一个文件是否"自带局部 chk 定义" */
/**
 * 相等语义的 chk 也是合规的。
 *
 * `test-*.js` 里那种 `const chk = (n, got, want) => { … JSON.stringify(got) === JSON.stringify(want) … }`
 * 在**结构上不会假通过**（只有两个参数还传错时才会失败，而那是显式写错不是静默通过）。
 * 所以它不该被当成"局部 chk 定义"来报 —— 报了就是误报，而误报会让人忽略报告。
 */
function isEqualityChk(src) {
  // 两种写法都认：`const chk = (n, got, want) => …` 与 `function chk(name, got, want) { … }`
  if (/JSON\.stringify\(\s*got\s*\)\s*===\s*JSON\.stringify\(\s*want\s*\)/.test(src)) return true
  return /function\s+chk\s*\(\s*\w+\s*,\s*got\s*,\s*want\s*\)/.test(src)
}

function hasLocalChk(src) {
  if (isEqualityChk(src)) return false      // 相等语义 → 合规，不算"自带局部 chk"

  // 覆盖几种写法：const chk = (...)、let chk、function chk(...)
  // ⚠️ 但要排除迁移后的别名写法 `const chk = H.chk` —— 那不是局部定义，
  //    它就是公共 harness 的引用（第一版扫描器没排除，把已迁移的文件也计进去了）。
  const re = /(?:const|let|var)\s+chk\s*=\s*([^\n;]*)/g
  let m
  while ((m = re.exec(src))) {
    const rhs = m[1]
    // 只认「确实来自公共 harness」的两种确切形态。
    // ⚠️ 不能用 /harness/ 扫整行 RHS —— 那样行尾注释（`const chk=(n,ok)=>{} // 不用 harness`）
    //    就能把扫描绕过去（review 指出）。
    if (/^\s*H\.chk\s*$/.test(rhs)) continue
    if (/require\(\s*['"]\.\/verify-harness['"]\s*\)/.test(rhs)) continue
    return true
  }
  return /function\s+chk\s*\(/.test(src)
}

function listJs(dir, out = []) {
  let es = []
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return out }
  for (const e of es) {
    // 排除第三方与夹具目录（fixture 里的 js 不算我们的脚本）
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name === 'testdata' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) listJs(full, out)
    else if (e.name.endsWith('.js')) out.push(full)
  }
  return out
}

function scan() {
  // 扫 desktop/ 下**所有** js（含子目录）—— 只扫 verify-*.js 的话，
  // 把断言挪到别的文件名/子目录就绕过去了（review 指出）。
  const files = listJs(DESKTOP)
  const withLocal = []
  const usingHarness = []
  for (const full of files) {
    const rel = path.relative(DESKTOP, full).replace(/\\/g, '/')
    if (rel === HARNESS) continue
    const src = fs.readFileSync(full, 'utf8')
    if (hasLocalChk(src)) withLocal.push(rel)
    if (/require\(['"]\.\/verify-harness['"]\)/.test(src)) usingHarness.push(rel)
  }
  return { all: files.map((f) => path.relative(DESKTOP, f).replace(/\\/g, '/')), withLocal, usingHarness }
}

const { all, withLocal, usingHarness } = scan()

if (MODE === 'freeze') {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({
    note: '还自带局部 chk 定义的 verify 脚本（渐进迁移中，只允许减少）。迁移完一个就删掉一个。',
    files: withLocal,
  }, null, 2) + '\n', 'utf8')
  console.log('== 已冻结基线 ==')
  console.log('  写入 ' + path.relative(ROOT, BASELINE_FILE) + '：' + withLocal.length + ' 个文件')
  process.exit(0)
}

if (MODE === 'ci') {
  let base = null
  try {
    base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  } catch (e) {
    console.log('== 局部 chk 检查 ==')
    console.log('  ✗ 读不到基线文件：' + path.relative(ROOT, BASELINE_FILE))
    console.log('  → 先跑 `node tools/check-local-chk.js --freeze` 建立基线。')
    process.exit(1)
  }
  const baseFiles = new Set(Array.isArray(base.files) ? base.files : [])
  const added = withLocal.filter((f) => !baseFiles.has(f))
  console.log('== 局部 chk 检查（统一到 verify-harness / 只减不增）==')
  console.log('  当前带局部 chk：' + withLocal.length + ' 个；基线 ' + baseFiles.size + ' 个')
  console.log('  已改用公共 harness：' + usingHarness.length + ' 个')
  if (added.length) {
    console.log('  ✗ 这些文件**新增**了局部 chk 定义：')
    for (const f of added) console.log('     desktop/' + f)
    console.log('  → 新脚本请不要自己写 chk，改用：')
    console.log("       const { createHarness } = require('./verify-harness')")
    console.log('       const H = createHarness({ log });  const chk = H.chk')
    console.log('  → 若确实需要（例如公共模块本身），把它加进基线并说明理由。')
    process.exit(1)
  }
  console.log('  ✓ 没有新增')
  if (usingHarness.length) console.log('    （已迁移：' + usingHarness.join(', ') + '）')
  process.exit(0)
}

// plain：报告
console.log('== 局部 chk 定义报告 ==')
console.log('  desktop/ 下 js 共 ' + all.length + ' 个（含公共模块 ' + HARNESS + '）')
console.log('  带局部 chk 定义：' + withLocal.length + ' 个')
for (const f of withLocal) console.log('     - ' + f)
console.log('  已改用公共 harness：' + usingHarness.length + ' 个')
for (const f of usingHarness) console.log('     + ' + f)
