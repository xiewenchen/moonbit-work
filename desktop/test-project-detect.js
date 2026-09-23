// 项目类型识别验证：用真实项目跑，确认能说清「哪些能力可用」
const path = require('path')
const os = require('os')
const fs = require('fs')
const { detectProject } = require('./project-detect')

let pass = 0, fail = 0
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  [PASS] ${n}`) } else { fail++; console.log(`  [FAIL] ${n}  ${d}`) } }

// 用脚本位置推导仓库根，跨平台
const MOONBIT = path.resolve(__dirname, '..')

// 用临时目录造一个最小 node 项目 fixture，不依赖本机桌面路径
function makeStrapiFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strapi-fixture-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'strapi-backend-fixture',
      version: '0.0.0',
      scripts: { start: 'strapi start', develop: 'strapi develop' },
    }, null, 2)
  )
  return dir
}
const STRAPI = makeStrapiFixture()

console.log('=== ① MoonBit 项目（本仓库）===')
{
  const i = detectProject(MOONBIT)
  console.log('    类型:', i.kind, '/', i.label)
  check('识别为 moonbit', i.kind === 'moonbit', i.kind)
  check('文件树/编辑器/终端/搜索 可用',
    i.features.fileTree.ok && i.features.editor.ok && i.features.terminal.ok && i.features.search.ok)
  check('MoonBit 智能功能可用', i.features.moonbitIntel.ok === true, i.features.moonbitIntel.why)
  check('接口面板可用（有 conduit/openapi.yml）', i.features.apiDebug.ok === true, i.features.apiDebug.why)
}

console.log('\n=== ② Strapi 项目（Node）===')
{
  const i = detectProject(STRAPI)
  console.log('    类型:', i.kind, '/', i.label)
  check('识别为 node', i.kind === 'node', i.kind)
  check('文件树/编辑器 仍可用', i.features.fileTree.ok && i.features.editor.ok)
  check('终端/搜索 仍可用', i.features.terminal.ok && i.features.search.ok)
  check('MoonBit 智能功能标记为不可用', i.features.moonbitIntel.ok === false)
  check('并给出原因（不是静默失败）', typeof i.features.moonbitIntel.why === 'string' && i.features.moonbitIntel.why.length > 10,
        i.features.moonbitIntel.why)
  check('后端一键启停标记为不可用', i.features.backendControl.ok === false)
  check('接口面板标记为不可用', i.features.apiDebug.ok === false, i.features.apiDebug.why)
  console.log('    原因文案示例:');
  console.log('      moonbitIntel:', i.features.moonbitIntel.why);
  console.log('      apiDebug     :', i.features.apiDebug.why);
}

console.log('\n=== ③ 不存在的目录 ===')
{
  const i = detectProject(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()))
  check('未知类型不崩溃', i.kind === 'unknown', i.kind)
}

console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
process.exit(fail ? 1 : 0)
