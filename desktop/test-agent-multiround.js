// PH3-E2E-07～14：真实多轮 Agent 任务的**非成功路径**（纯逻辑、Mock LLM、可进 CI）。
//
// 01～06（解释/诊断/只读/单文件改/双文件改/改后测试）需要**真实模型**，记 NOT_RUN。
// 这一批做的是清单里那 8 条**不依赖真实模型**、但同样属于"真实多轮"的：
//   07 Task Failure   08 Task Retry     09 Task Budget    10 Task Resume
//   11 Task Cancel    12 Session Resume 13 Memory Reuse   14 Cross-project isolation
//
// ⚠️ 它把前面几层**串起来**用：agent-task（任务状态机）+ agent-verify（失败即停）
//    + session-view（会话恢复）+ memory-schema（记忆复用与隔离）+ workspace（身份）。
//    单层测试都过 ≠ 串起来能用 —— 这一批测的就是"串起来"。
const { createHarness } = require('./verify-harness')
const {
  TASK_STATUS, createTask, transition, checkBudget, consume, recoverInterrupted, canTransition,
} = require('./agent-task')
const { runToolLoop } = require('./agent-adapter')
const { createMockLlm } = require('./mock-llm')
const { createBudget } = require('./agent-sandbox')
const {
  titleOf, listItemOf, replaySession, exportSession, resumeTarget,
} = require('./session-view')
const {
  MEMORY_TYPE, createMemory, canStore, proposeMemory, acceptProposal,
  retrieve, belongsTo,
} = require('./memory-schema')
const { workspaceIdOf, isSameWorkspace, checkBinding } = require('./workspace')

const H = createHarness()
const { chk, eq } = H

// ⚠️ 必须包在 async 函数里：Node 24 不允许"顶层 await + require"共存
//（ERR_AMBIGUOUS_MODULE_SYNTAX）。这与 test-agent-security.js 是同一个坑。
async function main() {

const PA = 'C:/proj-a'
const PB = 'C:/proj-b'

/** 一个"永远想调工具"的模型（用来触发上限/预算）。 */
const greedyLlm = () => ({
  async generate() { return { ok: true, text: '', toolCalls: [{ name: 'readFile', args: {} }] } },
})
const toolsOk = { call: async () => ({ ok: true, data: 'x' }) }

console.log('=== ① E2E-07 Task Failure：失败要**停**，而且状态要如实 ===')
{
  let t = createTask({ id: 't1', goal: '改一个文件', now: 0 })
  t = transition(t, TASK_STATUS.UNDERSTANDING, { now: 1 }).task
  t = transition(t, TASK_STATUS.PLANNING, { now: 2 }).task
  t = transition(t, TASK_STATUS.EXECUTING, { now: 3 }).task
  t = transition(t, TASK_STATUS.VERIFYING, { now: 4 }).task
  eq('走到验证中', t.status, 'VERIFYING')

  // 验证失败 → FAILED（不是 COMPLETED）
  const failed = transition(t, TASK_STATUS.FAILED, { now: 5, reason: 'test 未通过' })
  eq('★ 失败 → FAILED', failed.ok, true)
  eq('  状态如实', failed.task.status, 'FAILED')
  chk('  带原因', /test/.test(String(failed.task.statusReason)), String(failed.task.statusReason))
  chk('  终态', failed.task.finishedAt === 5)
  chk('★ 终态没有出边（失败就是失败，不能又变回执行中）', canTransition('FAILED', 'EXECUTING') === false)

  // 「失败即停」：verify 的步骤里 test 挂了，就不该有 run/health
  // ⚠️ createVerifyLoop(opts) 只收 maxRounds/fix；各步骤要放进 **run({patch, deps})** 的 deps 里
  //（我第一版直接当 opts 传了，于是 apply 步骤先挂了 —— 没先看签名，RULE-03）
  const { createVerifyLoop } = require('./agent-verify')
  const seen = []
  const stop = createVerifyLoop({ maxRounds: 1 })
  const r = await stop.run({
    patch: { file: 'a.mbt' },
    deps: {
      applyPatch: async () => { seen.push('apply'); return { ok: true, file: 'a.mbt' } },
      check: async () => { seen.push('check'); return { ok: true } },
      test: async () => { seen.push('test'); return { ok: false, error: '断言失败' } },
      run: async () => { seen.push('run'); return { ok: true } },
      health: async () => { seen.push('health'); return { ok: true } },
    },
  })
  chk('★ test 失败后**不再跑 run/health**', seen.indexOf('run') < 0 && seen.indexOf('health') < 0, JSON.stringify(seen))
  chk('  闭环结论是失败', r.ok === false, JSON.stringify({ ok: r.ok }))
  chk('  且说明停在哪儿', /失败|未通过/.test(String(r.stoppedReason || (r.last && r.last.error) || '')), JSON.stringify(r.stoppedReason || (r.last && r.last.error)))
}

console.log('\n=== ② E2E-09 Task Budget：超预算必须 STOP（不是慢慢转）===')
{
  eq('初始预算够', checkBudget(createTask({ now: 0, budget: { maxToolCalls: 2, maxPatchCount: 1, maxDuration: 5000 } }), 'tool', { now: 0 }).ok, true)

  let t = createTask({ now: 0, budget: { maxToolCalls: 2, maxPatchCount: 1, maxDuration: 5000 } })
  t = consume(t, 'tool'); t = consume(t, 'tool')
  const over = checkBudget(t, 'tool', { now: 10 })
  eq('★ 超工具预算 → 拦', over.ok, false)
  eq('  码是 TASK_BUDGET_EXCEEDED', over.code, 'TASK_BUDGET_EXCEEDED')

  // 串到 runToolLoop：预算用尽要 stopped=budget
  const r = await runToolLoop({
    llm: greedyLlm(), tools: toolsOk, messages: [{ role: 'user', content: 'go' }],
    maxSteps: 50, budget: createBudget({ maxCalls: 2 }),
  })
  eq('★ 闭环被预算叫停', r.stopped, 'budget')
  chk('  且 ok:false', r.ok === false)
  chk('  步数很小（真的停了，没转 50 步）', (r.steps || []).length <= 3, String((r.steps || []).length))
}

console.log('\n=== ③ E2E-08 Task Retry：**有限**重试 ===')
{
  let attempts = 0
  const { createVerifyLoop } = require('./agent-verify')
  const loop = createVerifyLoop({ maxRounds: 2 })
  const r = await loop.run({
    patch: { file: 'a.mbt' },
    deps: {
      applyPatch: async () => ({ ok: true, file: 'a.mbt' }),
      check: async () => { attempts++; return { ok: true } },
      test: async () => ({ ok: false, error: '还是不过' }),
      run: async () => ({ ok: true }), health: async () => ({ ok: true }),
    },
  })
  chk('★ 重试次数有限（最多 maxRounds 轮）', attempts <= 2, String(attempts))
  chk('  最终仍是失败（不伪装成功）', r.ok === false, JSON.stringify({ ok: r.ok }))
  // ★ 没给 fix 时不硬重试（"没有提供 fix（不再尝试）"）—— 这比盲目重跑更对：
  //   没有修复手段还重试，只是把同一个失败再验一遍，白耗预算。
  chk('★ 没有 fix 就**不硬重试**，并如实说明', /没有提供 fix|最大轮次|用满/.test(String(r.stoppedReason || '')), String(r.stoppedReason))
  eq('  于是只验了一轮', attempts, 1)

  // 给了 fix 才真的会重试到上限
  let tries = 0
  const loop2 = createVerifyLoop({ maxRounds: 2, fix: async () => { tries++; return { file: 'a.mbt' } } })
  const r2 = await loop2.run({
    patch: { file: 'a.mbt' },
    deps: {
      applyPatch: async () => ({ ok: true, file: 'a.mbt' }),
      check: async () => ({ ok: true }),
      test: async () => ({ ok: false, error: '还是不过' }),
      run: async () => ({ ok: true }), health: async () => ({ ok: true }),
    },
  })
  eq('★ 给了 fix 才会重试，且最多 maxRounds-1 次', tries, 1)
  chk('  说明了用满轮次', /用满|最大轮次/.test(String(r2.stoppedReason || '')), String(r2.stoppedReason))
  chk('  仍然如实失败', r2.ok === false)
}

console.log('\n=== ④ E2E-11 Task Cancel：任何非终态都能取消 ===')
{
  for (const s of ['CREATED', 'UNDERSTANDING', 'PLANNING', 'EXECUTING', 'WAITING_USER', 'VERIFYING', 'INTERRUPTED']) {
    chk(s + ' 可取消', canTransition(s, TASK_STATUS.CANCELLED) === true)
  }
  chk('★ 已完成的任务不能再"取消"（它是完成的）', canTransition('COMPLETED', 'CANCELLED') === false)

  // Cancel 之后不该再执行工具：用预算把它钉死（预算用尽 = 一种停止）
  let ran = 0
  const r = await runToolLoop({
    llm: greedyLlm(),
    tools: { call: async () => { ran++; return { ok: true } } },
    messages: [{ role: 'user', content: 'go' }],
    maxSteps: 50, budget: createBudget({ maxCalls: 0 }),   // 相当于"立刻取消"
  })
  eq('★ 立刻停止', r.stopped, 'budget')
  eq('★★ 一个工具都没跑', ran, 0)
}

console.log('\n=== ⑤ E2E-10 / 12 Task & Session Resume ===')
{
  // Task Resume：WAITING_USER → EXECUTING（用户确认后继续）
  let t = createTask({ id: 'r1', now: 0 })
  t = transition(t, TASK_STATUS.UNDERSTANDING, { now: 1 }).task
  t = transition(t, TASK_STATUS.PLANNING, { now: 2 }).task
  t = transition(t, TASK_STATUS.EXECUTING, { now: 3 }).task
  t = transition(t, TASK_STATUS.WAITING_USER, { now: 4 }).task
  eq('等用户确认（改了文件要先问）', t.status, 'WAITING_USER')
  const resumed = transition(t, TASK_STATUS.EXECUTING, { now: 5, reason: '用户确认' })
  eq('★ 用户确认 → 继续执行', resumed.ok, true)
  chk('  记下是因为用户确认', /确认/.test(String(resumed.task.statusReason)))

  // Session Resume：关掉再开，接最近一次（且**不跨项目**）
  const sessions = [
    { id: 'sa1', projectRoot: PA, updatedAt: 100, messages: [{ role: 'user', text: '改登录接口' }] },
    { id: 'sa2', projectRoot: PA, updatedAt: 900, messages: [{ role: 'user', text: '再改一处' }] },
    { id: 'sb1', projectRoot: PB, updatedAt: 999, messages: [{ role: 'user', text: 'B 项目的活' }] },
  ]
  const ra = resumeTarget(sessions, PA)
  eq('★ 接的是本项目最近那条', ra.session.id, 'sa2')
  chk('  ★ 不是别的项目那条（哪怕它更新）', ra.session.id !== 'sb1', ra.session.id)
  eq('B 项目接自己的', resumeTarget(sessions, PB).session.id, 'sb1')
  eq('★ 没这个项目的会话 → 如实说没有', resumeTarget(sessions, 'C:/nope').ok, false)

  // 会话本身：标题来自任务、回放只给做了什么
  eq('标题来自第一条任务', titleOf(ra.session), '再改一处')
  const rp = replaySession({ messages: [{ role: 'user', text: '改登录接口', at: 1 }, { role: 'assistant', text: 'x', at: 2, reasoning: '内部推理' }] })
  chk('★ 回放不含思维链', JSON.stringify(rp.steps).indexOf('内部推理') < 0, JSON.stringify(rp.steps))
  chk('导出同样不含', exportSession({ messages: [{ role: 'assistant', text: 'x', thinking: '草稿' }] }, 'md').text.indexOf('草稿') < 0)
}

console.log('\n=== ⑥ ★ E2E-13 Memory Reuse：上任务沉淀的**已验证**事实，下任务能检索到 ===')
{
  const scope = { project: PA }
  // 第一个任务：Agent 提议一条事实（用户确认才入库）
  const fact = createMemory({ type: MEMORY_TYPE.FACT, content: '入口是 cmd/main/main.mbt', project: PA, verified: true }, 1000).memory
  const prop = proposeMemory(fact, { origin: 'agent', reason: '从目录结构看出来' }, 1100)
  eq('提议阶段**还没入库**', prop.proposal.state, 'PENDING')
  const accepted = acceptProposal(prop.proposal, { by: 'user' }, 1200)
  eq('用户确认后才拿到 memory', accepted.ok, true)
  const store = [accepted.memory]

  // 第二个任务：检索时应当能用上
  const hit = retrieve(store, '入口文件在哪？', scope)
  eq('★ 下一个任务检索到了这条事实', hit.items.length, 1)
  chk('  内容对得上', /入口/.test(hit.items[0].content), hit.items[0].content)

  // 未验证的"猜测"不该被复用
  const guess = { id: 'g', type: MEMORY_TYPE.FACT, content: '入口也许是别的文件', project: workspaceIdOf(PA), verified: false }
  chk('★ 未验证的事实不算已验证经验（但 FACT 允许未验证）', canStore(guess).ok === true)  // FACT 不强制 verified
  const errGuess = { id: 'e', type: MEMORY_TYPE.ERROR, content: '可能是空指针', project: workspaceIdOf(PA), verified: false }
  eq('★★ ERROR 未验证 → 不入库（经验必须是验过的）', canStore(errGuess).ok, false)

  // 不相关任务不该硬塞
  eq('★ 不相关的任务一条都不给', retrieve(store, '画个日历', scope).items.length, 0)
}

console.log('\n=== ⑦ ★ E2E-14 Cross-project isolation：A 的记忆/会话不出现在 B ===')
{
  // 记忆：A 的规则在 B 的检索里**看不到**
  const ruleA = createMemory({ id: 'ra', type: MEMORY_TYPE.RULE, content: 'Rule A：只允许 SELECT', project: PA }, 1).memory
  const ruleB = createMemory({ id: 'rb', type: MEMORY_TYPE.RULE, content: 'Rule B：必须用 ORM', project: PB }, 1).memory
  const inB = retrieve([ruleA, ruleB], 'SELECT 查询怎么写', { project: PB })
  chk('★ B 里看不到 A 的规则', !inB.items.some((m) => /Rule A/.test(m.content)), JSON.stringify(inB.items.map((m) => m.content)))
  const inA = retrieve([ruleA, ruleB], 'SELECT 查询怎么写', { project: PA })
  chk('  A 里看不到 B 的', !inA.items.some((m) => /Rule B/.test(m.content)))

  // 归属判断用**工作空间身份**，不是字符串前缀
  chk('belongsTo(A 的规则, A) → true', belongsTo(ruleA, PA) === true)
  chk('★ 大小写/斜杠不同仍算同一个项目', belongsTo(ruleA, 'c:\\proj-a\\') === true)
  chk('★ 前缀相同但不是同一目录 → false', belongsTo(ruleA, 'C:/proj-a-2') === false)
  chk('工作空间身份一致', workspaceIdOf(PA) === workspaceIdOf('C:\\proj-a\\'))
  chk('不同项目身份不同', isSameWorkspace(PA, PB) === false)

  // 一致性检查：把两边的键混在一起，能报出"谁绑错了"
  const mix = checkBinding(PA, { 'workbench(todo/notes)': PA, 'agent-session': PB, 'project-memory': PA })
  eq('★ 报出绑错的那个', mix.consistent, false)
  chk('  点出是 agent-session', /agent-session/.test(mix.summary), mix.summary)
}

console.log('\n=== ⑧ E2E-09 收尾：崩溃恢复不自动继续（与 REC 一致）===')
{
  let t = createTask({ id: 'c1', now: 0 })
  t = transition(t, TASK_STATUS.UNDERSTANDING, { now: 1 }).task
  const r = recoverInterrupted([t], { now: 9 })
  eq('★ 未完成的被标 INTERRUPTED', r.interrupted.length, 1)
  chk('★★ 不是 EXECUTING（不自动继续）', r.interrupted[0].status !== 'EXECUTING', r.interrupted[0].status)
  chk('  但用户明确要求时可以继续', canTransition('INTERRUPTED', 'EXECUTING') === true)
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
