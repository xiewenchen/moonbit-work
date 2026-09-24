'use strict'

/**
 * ProjectContext 单测（Phase 2 / MBW-P2-02、P2-03、P2-05）
 *
 * 纯 Node：不依赖 Electron、不依赖 MoonBit native 构建 → 与本机工具链故障（R12）无关。
 * 最后一组会与**真实的** project-detect.detectProject 对接，验证 Factory 的接入点成立。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  PROJECT_TYPE,
  ALL_TYPES,
  TYPE_SPEC,
  normalizeType,
  normalizeRoot,
  createProjectContext,
  emptyContext,
  hasProject,
  isSameProject,
  withActiveFile,
  describeContext,
} = require('./project-context')
const { detectProject } = require('./project-detect')

let pass = 0
let fail = 0
const failures = []

function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
    console.log('  [PASS] ' + name)
  } else {
    fail++
    failures.push(name)
    console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want))
  }
}

console.log('\n=== P2-03 项目类型 ===')
chk('8 种类型齐备', ALL_TYPES, ['moonbit', 'node', 'python', 'rust', 'go', 'java', 'static', 'unknown'])
chk('大写键可用（PROJECT_TYPE.MOONBIT）', PROJECT_TYPE.MOONBIT, 'moonbit')
chk('归一化：大小写不敏感', [normalizeType('MoonBit'), normalizeType('MOONBIT'), normalizeType('node')], ['moonbit', 'moonbit', 'node'])
chk('归一化：奇怪输入 → unknown', [normalizeType('moonbit '), normalizeType(''), normalizeType(null), normalizeType('cpp')], ['moonbit', 'unknown', 'unknown', 'unknown'])
chk('每种类型都有 spec（label/language/命令）', ALL_TYPES.every((t) => TYPE_SPEC[t] && typeof TYPE_SPEC[t].label === 'string' && 'buildCommand' in TYPE_SPEC[t]), true)

console.log('\n=== P2-02 ProjectContext 字段 ===')
{
  const ctx = createProjectContext({ root: '/proj', kind: 'node', label: 'Node / JavaScript 项目' }, { createdAt: 1 })
  const keys = ['rootDir', 'projectType', 'label', 'entry', 'language', 'packageManager', 'buildCommand', 'runCommand', 'testCommand', 'activeFile']
  chk('清单要求的 9 个字段齐全（+label/features/createdAt）', keys.every((k) => k in ctx), true)
  chk('字段值正确', [ctx.rootDir, ctx.projectType, ctx.language, ctx.packageManager, ctx.testCommand], ['/proj', 'node', 'javascript', 'npm', 'npm test'])
  chk('未给的字段是 null 而不是 undefined', [ctx.entry, ctx.activeFile], [null, null])
}

console.log('\n=== P2-05 Factory：由识别结果推导 ===')
{
  const info = { root: '/p', kind: 'moonbit', label: 'MoonBit 模块', features: { terminal: { ok: true } } }
  const ctx = createProjectContext(info, { createdAt: 1 })
  chk('projectType 来自 kind', ctx.projectType, 'moonbit')
  chk('label 沿用识别结果', ctx.label, 'MoonBit 模块')
  chk('features 带过来', ctx.features.terminal.ok, true)
  chk('命令按类型推导', [ctx.buildCommand, ctx.testCommand], ['moon build --target native', 'moon test --target native'])
}
{
  const ctx = createProjectContext({ root: '/p', kind: 'node' }, { buildCommand: 'pnpm build', runCommand: 'pnpm dev', entry: 'src/index.js', createdAt: 1 })
  chk('overrides 覆盖推导值', [ctx.buildCommand, ctx.runCommand, ctx.entry], ['pnpm build', 'pnpm dev', 'src/index.js'])
}
{
  const ctx = createProjectContext({ root: '/p', kind: 'python' }, { createdAt: 1 })
  chk('python：无 build 命令（空串，不是 undefined）', ctx.buildCommand, '')
  chk('python：run/test 有缺省', [ctx.runCommand, ctx.testCommand], ['python main.py', 'pytest'])
}

console.log('\n=== 根目录归一化 ===')
chk('去尾部斜杠（两种）', [normalizeRoot('/a/b/'), normalizeRoot('C:\\a\\b\\')], ['/a/b', 'C:\\a\\b'])
chk('驱动器根不被截断', /^[A-Za-z]:[\\/]$/.test(normalizeRoot('C:\\')), true)
chk('空/undefined → 空串', [normalizeRoot(''), normalizeRoot(undefined)], ['', ''])
chk('去空白', normalizeRoot('  /a/b  '), '/a/b')

console.log('\n=== 不可变（防止各处乱改单一来源）===')
{
  const ctx = createProjectContext({ root: '/p', kind: 'node' }, { createdAt: 1 })
  let mutated = false
  try { ctx.rootDir = '/hacked'; mutated = ctx.rootDir !== '/p' } catch (e) { mutated = false }
  chk('根目录改不动', [ctx.rootDir, mutated], ['/p', false])
  let featMutated = false
  try { ctx.features.x = 1; featMutated = ctx.features.x === 1 } catch (e) { featMutated = false }
  chk('features 也冻结', featMutated, false)
}

console.log('\n=== 无项目态 / 多项目切换 / 摘要 ===')
{
  chk('emptyContext.hasProject = false', hasProject(emptyContext({ createdAt: 1 })), false)
  chk('正常 context.hasProject = true', hasProject(createProjectContext({ root: '/p', kind: 'node' }, { createdAt: 1 })), true)
  chk('null 也算无项目（不抛）', hasProject(null), false)
  chk('describeContext（无项目）', describeContext(emptyContext({ createdAt: 1 })), '（无项目）')
  chk('describeContext（有项目）', describeContext(createProjectContext({ root: '/p', kind: 'go', label: 'Go 项目' }, { createdAt: 1 })), 'Go 项目（go）@ /p')
}
{
  const a = createProjectContext({ root: '/a', kind: 'node' }, { createdAt: 1 })
  const a2 = createProjectContext({ root: '/a/', kind: 'node' }, { createdAt: 9 })
  const b = createProjectContext({ root: '/b', kind: 'node' }, { createdAt: 1 })
  const aRust = createProjectContext({ root: '/a', kind: 'rust' }, { createdAt: 1 })
  chk('同一项目（尾斜杠不同也算同一）', isSameProject(a, a2), true)
  chk('不同目录 → 不同项目', isSameProject(a, b), false)
  chk('同目录不同类型 → 视为不同（要重新初始化）', isSameProject(a, aRust), false)
}
{
  const a = createProjectContext({ root: '/a', kind: 'node' }, { createdAt: 1 })
  const withFile = withActiveFile(a, '/a/src/x.js')
  chk('withActiveFile 换出新的（原对象不变）', [a.activeFile, withFile.activeFile], [null, '/a/src/x.js'])
  chk('withActiveFile 保留其余字段', [withFile.rootDir, withFile.projectType, withFile.testCommand], ['/a', 'node', 'npm test'])
}

console.log('\n=== 与真实 project-detect 的接入点（集成）===')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbctx-'))
  try {
    // ① 空目录 → unknown
    fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true })
    const ctxEmpty = createProjectContext(detectProject(path.join(tmp, 'empty')), { createdAt: 1 })
    chk('空目录 → projectType=unknown', ctxEmpty.projectType, 'unknown')

    // ② Node 项目
    fs.mkdirSync(path.join(tmp, 'nodeapp'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'nodeapp', 'package.json'), '{"name":"x"}')
    const ctxNode = createProjectContext(detectProject(path.join(tmp, 'nodeapp')), { createdAt: 1 })
    chk('package.json → projectType=node', ctxNode.projectType, 'node')
    chk('rootDir 就是识别用的根', path.normalize(ctxNode.rootDir), path.normalize(path.join(tmp, 'nodeapp')))

    // ③ MoonBit 项目（detectProject 认 moon.mod）
    fs.mkdirSync(path.join(tmp, 'mb'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'mb', 'moon.mod'), '')
    const ctxMb = createProjectContext(detectProject(path.join(tmp, 'mb')), { createdAt: 1 })
    chk('moon.mod → projectType=moonbit', ctxMb.projectType, 'moonbit')
    chk('MoonBit 的 run 命令带 target native', /--target native/.test(ctxMb.runCommand), true)
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch (e) {
      console.log('   （临时目录清理失败，忽略：' + String((e && e.message) || e) + '）')
    }
  }
}

console.log('\n=== rootOfInput：统一取根（P2-08 起各模块共用）===')
{
  const { rootOfInput } = require('./project-context')
  const ctx = createProjectContext({ root: '/proj/a', kind: 'node' }, { createdAt: 1 })
  chk('字符串原样（旧调用）', rootOfInput('/proj/a'), '/proj/a')
  chk('字符串去空白', rootOfInput('  /proj/a  '), '/proj/a')
  chk('ProjectContext → 取 rootDir（新调用）', rootOfInput(ctx), '/proj/a')
  chk('{ ctx } 包装形式', rootOfInput({ ctx }), '/proj/a')
  chk('空/ null / undefined → 空串', [rootOfInput(''), rootOfInput(null), rootOfInput(undefined)], ['', '', ''])
  chk('怪输入不抛且给空串', [rootOfInput(123), rootOfInput([]), rootOfInput({})], ['', '', ''])
  chk('runners.js 仍 re-export（旧引用不破）', require('./runners').rootOfInput, rootOfInput)
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
