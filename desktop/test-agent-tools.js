'use strict'

/**
 * Agent 只读工具单测（Phase 2 / MBW-P6-01 ～ P6-10）
 *
 * 纯 Node：能力全靠注入，所以越界用例可以彻底跑（不会真去读 workspace 外的文件）。
 * 最重要的一组是 P6-10：**能理解项目，但不能修改、不能执行**。
 */

const os = require('node:os')
const path = require('node:path')
const { toolResult, READ_TOOL_SPECS, createReadOnlyToolRegistry } = require('./agent-tools')

let pass = 0
let fail = 0
const failures = []
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
}

const WS = path.join(os.tmpdir(), 'ws-tools-test')

function fakeDeps(over = {}) {
  return Object.assign({
    rootOf: () => WS,
    readFile: async (p) => '// ' + p + '\nfn main { }\n',
    listDir: async (p) => (String(p).includes('missing') ? null : [{ name: 'main.mbt', type: 'file' }]),
    search: async ({ query }) => [{ file: 'a.mbt', line: 1, text: 'fn ' + query }],
    symbols: async () => [{ name: 'safe_byte', kind: 'func', file: 'http.mbt', line: 28 }],
    problems: async () => [{ severity: 'error', file: 'a.mbt', line: 2, message: 'unbound' }],
    runLog: async () => ({ ok: true, url: 'http://127.0.0.1:8123', status: 'STOPPED' }),
    projectInfo: async () => ({ rootDir: WS, projectType: 'moonbit', label: 'MoonBit 模块' }),
  }, over)
}

async function main() {
  console.log('\n=== P6-08 统一的工具结果 ===')
  {
    chk('默认形状', toolResult(), { ok: false, data: null, error: null, truncated: false })
    chk('data 未给 → null（不是 undefined）', toolResult({ ok: true }).data, null)
    chk('truncated 只认 true', [toolResult({ truncated: 1 }).truncated, toolResult({ truncated: true }).truncated], [false, true])
  }

  console.log('\n=== P6-09 工具清单（审计：每个都有超时与输出限额）===')
  {
    const reg = createReadOnlyToolRegistry(fakeDeps())
    const list = reg.list()
    chk('八个只读工具齐备', list.map((t) => t.name).sort(),
      ['backendStatus', 'getDiagnostics', 'getProjectInfo', 'getRunLog', 'listDir', 'readFile', 'search', 'symbols'])
    chk('**全部是 read 权限**', Array.from(new Set(list.map((t) => t.permission))), ['read'])
    chk('每个都有正的 timeoutMs', list.every((t) => Number(t.timeoutMs) > 0), true)
    chk('每个都有正的 maxOutputBytes', list.every((t) => Number(t.maxOutputBytes) > 0), true)
    chk('文件类工具声明 workspaceOnly', list.filter((t) => ['readFile', 'listDir', 'search', 'symbols'].includes(t.name)).every((t) => t.workspaceOnly === true), true)
    chk('SPEC 表与注册表一致', READ_TOOL_SPECS.map((s) => s.name).sort(), list.map((t) => t.name).sort())
  }

  console.log('\n=== P6-10 结构性保证：只读注册表拒绝非 read 工具 ===')
  {
    const reg = createReadOnlyToolRegistry(fakeDeps())
    let threw = ''
    try {
      reg.register({ name: 'writeFile', permission: 'write', timeoutMs: 5000, maxOutputBytes: 1024 }, async () => ({}))
    } catch (e) { threw = String(e && e.message) }
    chk('注册 write 工具 → 抛错', /不允许 write/.test(threw), true)

    threw = ''
    try {
      reg.register({ name: 'runCmd', permission: 'execute', timeoutMs: 5000, maxOutputBytes: 1024 }, async () => ({}))
    } catch (e) { threw = String(e && e.message) }
    chk('注册 execute 工具 → 抛错', /不允许 execute/.test(threw), true)

    chk('注册表里不存在写工具', reg.has('writeFile'), false)
    chk('注册表里不存在执行工具', reg.has('project.run'), false)
    chk('调用表外工具 → 明确拒绝', (await reg.call('project.run', {})).ok, false)
  }

  console.log('\n=== P6-01 readFile（含越界用例）===')
  {
    const reg = createReadOnlyToolRegistry(fakeDeps())
    const ok = await reg.call('readFile', { path: 'a.mbt' })
    chk('workspace 内 → 成功且返回内容', [ok.ok, /fn main/.test(ok.data.content)], [true, true])

    const esc1 = await reg.call('readFile', { path: '../secret' })
    chk('`../secret` → 拒', [esc1.ok, /越出 workspace/.test(String(esc1.error))], [false, true])

    const esc2 = await reg.call('readFile', { path: path.join(os.tmpdir(), 'other', 'x') })
    chk('绝对路径在 workspace 外 → 拒', esc2.ok, false)

    const esc3 = await reg.call('readFile', { path: '' })
    chk('空路径 → 拒', esc3.ok, false)

    const big = createReadOnlyToolRegistry(fakeDeps({ readFile: async () => 'X'.repeat(200000) }))
    const r = await big.call('readFile', { path: 'big.mbt' })
    chk('超长内容 → 截断并标记 truncated', [r.ok, r.data.content.length, r.truncated], [true, 65536, true])
  }

  console.log('\n=== P6-02 listDir / P6-03 search ===')
  {
    const reg = createReadOnlyToolRegistry(fakeDeps())
    const d = await reg.call('listDir', { path: '.' })
    chk('listDir 正常', [d.ok, d.data.entries.length], [true, 1])
    const d2 = await reg.call('listDir', { path: 'missing-dir' })
    chk('目录不存在 → 明确失败', [d2.ok, /不存在/.test(String(d2.error))], [false, true])
    const out = await reg.call('listDir', { path: '../..' })
    chk('listDir 也受沙箱约束', out.ok, false)

    const s = await reg.call('search', { query: 'main' })
    chk('search 正常', [s.ok, s.data.hits.length], [true, 1])
    const s2 = await reg.call('search', {})
    chk('search 缺 query → 失败', [s2.ok, /缺少 query/.test(String(s2.error))], [false, true])
  }

  console.log('\n=== P6-04 ～ P6-07 其余工具 ===')
  {
    const reg = createReadOnlyToolRegistry(fakeDeps())
    const sym = await reg.call('symbols', { query: 'safe_byte' })
    chk('symbols 复用符号索引', [sym.ok, sym.data[0].name], [true, 'safe_byte'])
    const diag = await reg.call('getDiagnostics')
    chk('getDiagnostics 读统一问题模型', [diag.ok, diag.data[0].severity], [true, 'error'])
    const run = await reg.call('getRunLog')
    chk('getRunLog 读最近运行', [run.ok, run.data.status], [true, 'STOPPED'])
    const info = await reg.call('getProjectInfo')
    chk('getProjectInfo 读工程上下文', [info.ok, info.data.projectType], [true, 'moonbit'])
  }

  console.log('\n=== 错误处理（P6-09 审计的一部分）===')
  {
    const reg = createReadOnlyToolRegistry({ rootOf: () => WS })
    chk('能力未注入 → 明确报错（不是静默成功）', /未注入/.test(String((await reg.call('readFile', { path: 'a.mbt' })).error)), true)

    const boom = createReadOnlyToolRegistry(fakeDeps({ readFile: async () => { throw new Error('磁盘炸了') } }))
    const r = await boom.call('readFile', { path: 'a.mbt' })
    chk('实现抛错 → 转成 ok:false（不冒泡）', [r.ok, /磁盘炸了/.test(String(r.error))], [false, true])

    const noRoot = createReadOnlyToolRegistry(fakeDeps({ rootOf: () => '' }))
    chk('未打开项目 → 文件类工具全拒', (await noRoot.call('readFile', { path: 'a.mbt' })).ok, false)
    chk('未打开项目时内存类工具仍可用', (await noRoot.call('getProjectInfo')).ok, true)
  }

  console.log('\n=== P6-10 场景：能理解项目，但不能修改/执行 ===')
  {
    const reg = createReadOnlyToolRegistry(fakeDeps())
    // ① 找入口：读项目信息
    const info = await reg.call('getProjectInfo')
    chk('① 能定位项目与类型', [info.ok, info.data.projectType], [true, 'moonbit'])
    // ② 找函数：查符号
    const sym = await reg.call('symbols', { query: 'safe_byte' })
    chk('② 能找到函数（带文件与行号）', [sym.data[0].file, sym.data[0].line], ['http.mbt', 28])
    // ③ 读错误：从统一问题模型
    const diag = await reg.call('getDiagnostics')
    chk('③ 能读到错误及其位置', [diag.data[0].file, diag.data[0].line], ['a.mbt', 2])
    // ④ 解释错误：读对应源码
    const code = await reg.call('readFile', { path: 'a.mbt' })
    chk('④ 能读到源码去解释', code.ok, true)
    // ⑤ 但不能越界、不能改、不能跑
    chk('⑤ 越界读被拒', (await reg.call('readFile', { path: '../../etc/passwd' })).ok, false)
    chk('⑤ 无写入能力', reg.list().every((t) => t.permission === 'read'), true)
    chk('⑤ 无执行能力', reg.list().filter((t) => ['build', 'test', 'run', 'stop'].includes(t.name)).length, 0)
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('单测异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
