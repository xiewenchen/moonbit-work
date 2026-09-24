'use strict'

/**
 * Problem Model 单测（Phase 2 / MBW-P4-01 ～ P4-09、P4-11、P4-12）
 *
 * 纯 Node：不依赖 Electron / DOM / 真实编译器输出（编译输出用真实格式的**样本**）。
 * 最后一组专门验 Gate P4 的核心：**五类问题能统一看到**。
 */

const {
  PROBLEM_SOURCE,
  SEVERITY,
  PROBLEM_LIFECYCLE,
  fingerprint,
  createProblem,
  fromLspDiagnostics,
  fromCompilerOutput,
  fromRuntimeLocs,
  fromTestResult,
  fromApiResult,
  fromAgentFinding,
  createProblemStore,
} = require('./problem-model')

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

console.log('\n=== P4-01 定义 Problem ===')
{
  const p = createProblem({ source: 'compiler', severity: 'error', message: ' unbound ', file: 'a.mbt', line: 12, col: 5, code: '4021', timestamp: 1 })
  chk('字段齐备且归一（col → column、message trim）', [p.source, p.severity, p.message, p.file, p.line, p.column, p.code, p.timestamp, p.lifecycle],
    ['compiler', 'error', 'unbound', 'a.mbt', 12, 5, '4021', 1, 'open'])
  chk('id 缺省 = 指纹', p.id, fingerprint(p))
  const weird = createProblem({ severity: 'wat', source: 'nope', line: -3, column: 0, file: '' })
  chk('怪输入归一', [weird.severity, weird.source, weird.line, weird.column, weird.file], ['error', 'lsp', 1, 1, null])
  chk('缺失字段也有默认', [createProblem().message, createProblem().line], ['', 1])
}

console.log('\n=== P4-11 去重（指纹）===')
{
  const a = createProblem({ source: 'lsp', file: 'a.mbt', line: 1, column: 1, message: 'boom' })
  const b = createProblem({ source: 'lsp', file: 'a.mbt', line: 1, column: 1, message: 'boom' })
  const c = createProblem({ source: 'lsp', file: 'a.mbt', line: 2, column: 1, message: 'boom' })
  chk('同一问题 → 同一 id', a.id === b.id, true)
  chk('不同位置 → 不同 id', a.id === c.id, false)

  const store = createProblemStore()
  for (let i = 0; i < 100; i++) store.add({ source: 'lsp', file: 'a.mbt', line: 1, column: 1, message: 'boom' })
  chk('相同错误加 100 次 → 只剩 1 条', store.size(), 1)
  chk('list() 也只有 1 条', store.list().length, 1)
}

console.log('\n=== P4-09 Store：查询 / 排序 / 过滤 ===')
{
  const store = createProblemStore()
  store.add([
    { source: 'runtime', severity: 'error', file: 'z.mbt', line: 9, message: 'boom' },
    { source: 'lsp', severity: 'warning', file: 'a.mbt', line: 5, message: 'unused' },
    { source: 'lsp', severity: 'error', file: 'a.mbt', line: 2, message: 'unbound' },
    { source: 'lsp', severity: 'info', file: 'a.mbt', line: 7, message: 'note' },
  ])
  chk('默认只列 OPEN（4 条）', store.list().length, 4)
  chk('排序：error 优先，再按 file/line', store.list().map((p) => p.severity + ':' + p.file + ':' + p.line),
    ['error:a.mbt:2', 'error:z.mbt:9', 'warning:a.mbt:5', 'info:a.mbt:7'])
  chk('按来源过滤', store.list({ source: 'lsp' }).length, 3)
  chk('按严重度过滤', store.list({ severity: 'error' }).length, 2)
  chk('按文件过滤', store.list({ file: 'z.mbt' }).length, 1)
  const st = store.stats()
  chk('stats', [st.total, st.bySeverity, Object.entries(st.bySource).sort(), st.history],
    [4, { error: 2, warning: 1, info: 1 }, [['lsp', 3], ['runtime', 1]], 0])
}

console.log('\n=== P4-09 replaceSource：重跑后旧问题自动消失 ===')
{
  const store = createProblemStore()
  store.replaceSource('lsp', [
    { source: 'lsp', file: 'a.mbt', line: 1, message: 'old' },
    { source: 'lsp', file: 'a.mbt', line: 2, message: 'keep' },
  ])
  chk('第一次：2 条', store.list().length, 2)

  store.replaceSource('lsp', [{ source: 'lsp', file: 'a.mbt', line: 2, message: 'keep' }])
  chk('第二次只剩仍存在的 1 条', store.list().length, 1)
  chk('消失的那条进了 history 且标记 FIXED', store.history().map((p) => p.message + '/' + p.lifecycle), ['old/fixed'])
  chk('replaceSource 不会动别的来源', (store.add({ source: 'test', file: 't.mbt', line: 1, message: 'x' }), store.replaceSource('lsp', []), store.list().length), 1)
}

console.log('\n=== P4-12 生命周期 ===')
{
  const store = createProblemStore()
  const p = createProblem({ source: 'lsp', file: 'a.mbt', line: 1, message: 'boom' })
  store.add(p)
  chk('fix() 返回新状态', (store.fix(p.id) || {}).lifecycle, 'fixed')
  chk('fix 后从 current 消失', store.size(), 0)
  chk('fix 后进 history', store.history().map((x) => x.lifecycle), ['fixed'])

  const q = createProblem({ source: 'lsp', file: 'b.mbt', line: 1, message: 'noise' })
  store.add(q)
  chk('ignore() 生效', (store.ignore(q.id) || {}).lifecycle, 'ignored')
  chk('ignore 后 current 为空', store.size(), 0)

  chk('对不存在的 id 操作 → null', store.fix('nope'), null)
  chk('clear(来源) 清掉该来源', (store.add([{ source: 'api', message: 'a' }, { source: 'agent', message: 'b' }]), store.clear('api'), store.list().length), 1)
  chk('clear() 全清', (store.clear(), store.size()), 0)
}

console.log('\n=== 上限保护 ===')
{
  const store = createProblemStore({ limit: 3 })
  for (let i = 1; i <= 5; i++) store.add({ source: 'lsp', file: 'a.mbt', line: i, message: 'm' + i, timestamp: i })
  chk('超过 limit 只留 3 条', store.size(), 3)
  chk('丢的是**最旧**的（按 timestamp）', store.list().map((p) => p.line), [3, 4, 5])
  chk('被挤掉的进 history 并标记 evicted', store.history().filter((p) => p.evicted).length, 2)
}

console.log('\n=== P4-03 ～ P4-08 适配器 ===')
{
  const lsp = fromLspDiagnostics([{ file: 'a.mbt', line: 3, col: 2, severity: 'warning', code: '0025', message: 'unused' }])
  chk('LSP → Problem（col → column）', [lsp[0].source, lsp[0].column, lsp[0].code], ['lsp', 2, '0025'])

  // 真实格式的 `moon check` 样本（与 lsp-parse 的解析器对接）
  const sample = [
    'Error: [4021]',
    '   \u256d\u2500[ /proj/src/main.mbt:12:5 ]',
    '   \u2502   \u2570\u2500\u2500\u2500\u2500\u2500 The value identifier foo is unbound.',
    'Warning: [0025]',
    '   \u256d\u2500[ /proj/src/lib.mbt:3:1 ]',
    '   \u2502   \u2570\u2500\u2500\u2500\u2500\u2500 unused variable',
  ].join('\n')
  const comp = fromCompilerOutput(sample)
  chk('编译器输出 → 2 条', comp.length, 2)
  chk('编译器：字段正确', [comp[0].source, comp[0].severity, comp[0].file, comp[0].line, comp[0].column, comp[0].code],
    ['compiler', 'error', '/proj/src/main.mbt', 12, 5, '4021'])
  chk('编译器：第二条是 warning', [comp[1].severity, comp[1].file], ['warning', '/proj/src/lib.mbt'])

  const rt = fromRuntimeLocs([{ file: 'a.mbt', line: 7, col: 3 }], { timestamp: 1 })
  chk('运行时位置 → Problem', [rt[0].source, rt[0].severity, rt[0].line, rt[0].column], ['runtime', 'error', 7, 3])

  chk('测试：通过的用例不产生问题', fromTestResult([{ name: 'a', ok: true }, { name: 'b', ok: false, file: 't.mbt', line: 4 }]).length, 1)
  chk('测试：失败用例带文件名与 message', (() => { const r = fromTestResult({ name: 'b', ok: false, file: 't.mbt', line: 4 })[0]; return [r.source, r.code, r.file, /测试失败/.test(r.message)] })(),
    ['test', 'b', 't.mbt', true])

  chk('API：ok:true → 无问题', fromApiResult({ ok: true }).length, 0)
  chk('API：5xx → error', fromApiResult({ ok: false, method: 'GET', url: 'http://x/api', status: 500 })[0].severity, 'error')
  chk('API：4xx → warning 且 message 带方法/URL', (() => { const r = fromApiResult({ ok: false, method: 'GET', url: 'http://x/api', status: 404 })[0]; return [r.severity, /GET http:\/\/x\/api/.test(r.message), r.code] })(),
    ['warning', true, '404'])

  chk('Agent：无 message 的被过滤', fromAgentFinding([{ message: 'f1' }, { file: 'x' }]).length, 1)
  chk('Agent：默认 warning', fromAgentFinding({ message: 'f1' })[0].severity, 'warning')
}

console.log('\n=== Gate P4：五类问题统一看到 ===')
{
  const store = createProblemStore()
  store.replaceSource(PROBLEM_SOURCE.LSP, fromLspDiagnostics([{ file: 'a.mbt', line: 1, severity: 'warning', message: 'lsp 问题' }]))
  store.replaceSource(PROBLEM_SOURCE.COMPILER, fromCompilerOutput([
    'Error: [4021]',
    '   \u256d\u2500[ /p/x.mbt:2:1 ]',
    '   \u2502   \u2570\u2500\u2500\u2500 compile error',
  ].join('\n')))
  store.replaceSource(PROBLEM_SOURCE.RUNTIME, fromRuntimeLocs([{ file: 'a.mbt', line: 9 }]))
  store.replaceSource(PROBLEM_SOURCE.TEST, fromTestResult({ name: 't1', ok: false, file: 't.mbt', line: 3 }))
  store.replaceSource(PROBLEM_SOURCE.AGENT, fromAgentFinding({ message: 'agent 发现：这里可能有问题', file: 'a.mbt', line: 5 }))

  const srcs = Array.from(new Set(store.list().map((p) => p.source))).sort()
  chk('五类来源都能看到', srcs, ['agent', 'compiler', 'lsp', 'runtime', 'test'])
  chk('总数 = 5', store.size(), 5)
  chk('按严重度排序（error 在前）', store.list()[0].severity, 'error')
  chk('stats 覆盖五类', Object.keys(store.stats().bySource).sort(), ['agent', 'compiler', 'lsp', 'runtime', 'test'])
  chk('替换某一类不影响其它类', (store.replaceSource(PROBLEM_SOURCE.TEST, []), store.list().length), 4)
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
