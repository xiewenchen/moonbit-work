// 跨文件搜索单测（自包含：在临时目录里造文件，不依赖工作区内容）
// 运行： node test-search.js
const fs = require('fs')
const os = require('os')
const path = require('path')
const { searchInDir, isTextFile } = require('./search')

let failed = 0
function check(name, cond, extra) {
  if (!cond) failed++
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name, cond ? '' : JSON.stringify(extra))
}

// 造一个临时工作区
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbp-search-'))
fs.mkdirSync(path.join(root, 'pkg'))
fs.mkdirSync(path.join(root, '_build')) // 应被跳过
fs.mkdirSync(path.join(root, 'node_modules')) // 应被跳过
fs.writeFileSync(path.join(root, 'a.mbt'), 'pub fn Needle_Alpha() -> Int {\n  1\n}\n')
fs.writeFileSync(path.join(root, 'pkg', 'b.mbt'), 'fn other() {\n  let x = Needle_Alpha\n}\n')
fs.writeFileSync(path.join(root, '_build', 'skip.mbt'), 'Needle_Alpha\n')
fs.writeFileSync(path.join(root, 'node_modules', 'skip.mbt'), 'Needle_Alpha\n')
fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(10)) // 非文本后缀
fs.writeFileSync(path.join(root, 'many.txt'), 'x\n'.repeat(50) + 'Needle_Alpha\n')

try {
  const r = searchInDir(root, 'Needle_Alpha')
  check('搜到 3 处（a/b/many）', r.results.length === 3, r.results.map((x) => path.basename(x.file)))
  check('跳过 _build', !r.results.some((x) => x.file.includes('_build')))
  check('跳过 node_modules', !r.results.some((x) => x.file.includes('node_modules')))
  check('跳过 .bin（非文本后缀）', !r.results.some((x) => x.file.endsWith('.bin')))
  check('行号正确（many.txt 在第 51 行）', r.results.some((x) => path.basename(x.file) === 'many.txt' && x.line === 51), r.results)

  // 大小写
  const ci = searchInDir(root, 'needle_alpha', { caseInsensitive: true })
  check('不区分大小写能搜到', ci.results.length === 3, ci.results.length)
  const cs = searchInDir(root, 'needle_alpha')
  check('区分大小写搜不到', cs.results.length === 0, cs.results.length)

  // 边界
  check('空查询 → 空结果', searchInDir(root, '').results.length === 0)
  const lim = searchInDir(root, 'Needle_Alpha', { maxResults: 1 })
  check('maxResults 生效且标记 truncated', lim.results.length === 1 && lim.truncated === true, lim)

  // 结果结构
  const one = searchInDir(root, 'Needle_Alpha').results[0]
  check('结果含 file/line/col/text', !!one.file && one.line > 0 && one.col > 0 && typeof one.text === 'string', one)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

// isTextFile
check('isTextFile(.mbt)', isTextFile('a.mbt') === true)
check('isTextFile(moon.mod)', isTextFile('moon.mod') === true)
check('isTextFile(.exe)', isTextFile('x.exe') === false)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
