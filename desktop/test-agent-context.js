'use strict'

/**
 * AgentContext 单测（Phase 2 / MBW-P5-01 ～ P5-09）
 *
 * 纯 Node：数据全靠注入，不碰 Electron / DOM / 文件系统。
 * 重点在 P5-08（预算）与 P5-09（优先级）—— 它们直接决定"会不会把整个项目塞给模型"。
 */

const {
  AGENT_CONTEXT_LIMITS,
  CONTEXT_PRIORITY,
  createAgentContext,
  renderAgentContext,
  buildAgentContext,
} = require('./agent-context')

let pass = 0
let fail = 0
const failures = []
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
}

async function main() {
console.log('\n=== P5-01 定义 AgentContext ===')
{
  const ctx = createAgentContext()
  chk('全空也合法（字段不编造）', [ctx.task, ctx.project, ctx.activeFile, ctx.selection, ctx.lastRun, ctx.lastTest],
    [null, null, null, null, null, null])
  chk('problems / recentFiles / history 默认空数组', [ctx.problems, ctx.recentFiles, ctx.history], [[], [], []])
  chk('recentFiles 自动截到上限', createAgentContext({ recentFiles: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).recentFiles.length, AGENT_CONTEXT_LIMITS.maxRecentFiles)

  let froze = false
  try { ctx.task = 'x'; froze = ctx.task !== 'x' } catch (e) { froze = true }
  chk('上下文是冻结的（防各处乱改）', froze, true)
}

console.log('\n=== P5-02 ～ P5-07 组装（从注入的数据源取）===')
{
  const sources = {
    task: '把 run-url 修好',
    project: { rootDir: '/p', projectType: 'moonbit', label: 'MoonBit 模块', files: ['cmd/main/main.mbt', 'http/http.mbt'] },
    activeFile: { path: 'cmd/main/main.mbt', language: 'moonbit', content: 'fn main { }' },
    selection: { text: 'fn main', startLine: 1, endLine: 1 },
    problems: [{ severity: 'error', file: 'a.mbt', line: 2, column: 3, message: 'unbound', source: 'compiler' }],
    lastRun: { ok: true, url: 'http://127.0.0.1:8123', status: 'STOPPED' },
    lastTest: { ok: false, name: 't1', output: 'boom' },
    recentFiles: ['x.mbt'],
    history: [{ summary: '上一轮改过 runner' }],
  }
  const r = await buildAgentContext(sources)
  chk('六类都能渲染出来', ['task', 'problems', 'activeFile', 'selection', 'project', 'history'].every((k) => r.text.includes('## ') && r.included.includes(k)), true)
  chk('任务文本在', /把 run-url 修好/.test(r.text), true)
  chk('问题带位置与来源', /a\.mbt:2:3.*unbound.*compiler/.test(r.text), true)
  chk('活动文件带语言与内容', /cmd\/main\/main\.mbt · moonbit/.test(r.text) && /fn main \{ \}/.test(r.text), true)
  chk('选区的行范围被标出', /第 1–1 行/.test(r.text), true)
  chk('returns ctx 与 text', typeof r.ctx === 'object' && typeof r.text === 'string', true)

  // 数据源可以是异步函数
  const r2 = await buildAgentContext({ task: async () => '来自异步源' })
  chk('异步数据源被 await', /来自异步源/.test(r2.text), true)

  const r3 = await buildAgentContext(sources, { render: false })
  chk('render:false 只回上下文对象', [typeof r3.text, r3.task], ['undefined', '把 run-url 修好'])
}

console.log('\n=== P5-08 预算：项目只给骨架，绝不塞全文 ===')
{
  const secret = 'FILE_CONTENT_SHOULD_NEVER_BE_SENT'
  const ctx = createAgentContext({
    project: { rootDir: '/p', projectType: 'node', files: ['src/a.js', 'src/b.js'], content: secret },
  })
  const r = renderAgentContext(ctx)
  chk('项目段列出路径', /src\/a\.js/.test(r.text), true)
  chk('**即使 project 上挂了 content 也不渲染**', r.text.includes(secret), false)

  const many = { rootDir: '/p', files: Array.from({ length: 100 }, (_, i) => 'f' + i + '.mbt') }
  const r2 = renderAgentContext(createAgentContext({ project: many }))
  chk('文件清单只列前 N 条', r2.text.includes('f39.mbt') && !r2.text.includes('f40.mbt'), true)
  chk('并说明共多少个', /共 100 个文件/.test(r2.text), true)
}

console.log('\n=== P5-08 单文件超长 → 截断并注明 ===')
{
  const ctx = createAgentContext({ activeFile: { path: 'big.mbt', content: 'X'.repeat(20000) } })
  const r = renderAgentContext(ctx)
  chk('文件被截到上限', r.text.length < 20000, true)
  chk('注明省略了多少字', /已截断，省略 \d+ 字/.test(r.text), true)
}

console.log('\n=== P5-09 优先级：预算不够时先丢低优先级 ===')
{
  chk('优先级顺序（清单：任务 > **用户指着的问题** > 问题列表 > 文件 > 项目结构 > 历史）',
    CONTEXT_PRIORITY.slice(0, 4), ['task', 'focusProblem', 'problems', 'activeFile'])
  const ctx = createAgentContext({
    task: 'T'.repeat(800),
    problems: Array.from({ length: 30 }, (_, i) => ({ severity: 'error', file: 'a.mbt', line: i + 1, message: '问题' + i })),
    activeFile: { path: 'a.mbt', content: 'Y'.repeat(5000) },
    project: { rootDir: '/p', files: ['a.mbt'] },
    history: [{ summary: '很久以前的事' }],
  })
  const r = renderAgentContext(ctx, { maxChars: 2000 })
  chk('task 一定在（最高优先级）', r.included[0].startsWith('task'), true)
  chk('有内容被丢弃', r.omitted.length > 0, true)
  chk('丢的是低优先级（历史/项目）', r.omitted.includes('history'), true)
  chk('**如实说明未提供什么**', /未提供/.test(r.text) && /history/.test(r.text), true)
  chk('裁剪后的总长不超过预算（允许少量说明开销）', r.used <= 2000 + 200, true)
}

console.log('\n=== 边界 ===')
{
  const r = renderAgentContext(createAgentContext())
  chk('全空上下文不抛且无可渲染片段', [typeof r.text, r.text.trim(), r.included], ['string', '', []])

  const r2 = renderAgentContext(createAgentContext({ task: '只有任务' }))
  chk('只有任务时只渲染任务', r2.included, ['task'])

  const r3 = renderAgentContext(createAgentContext({ problems: [] }))
  chk('没有问题时不渲染问题段', /当前问题/.test(r3.text), false)

  const r4 = renderAgentContext(createAgentContext({ project: { files: ['a'] } }))
  chk('项目没有 rootDir 时不渲染（视为未打开项目）', /项目结构/.test(r4.text), false)
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('单测异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
