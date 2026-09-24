'use strict'

/**
 * AgentRequest / AgentResponse 契约 + 真实取数 + 快照（Phase 2.1 / P5A-01 ～ P5A-05）
 *
 * 纯 Node，不依赖 Electron / MoonBit native → 与 R12 无关，可进 CI。
 * 断言用公共 verify-harness（P19-18 已禁止各脚本自带局部 chk）。
 */

const { createHarness } = require('./verify-harness')
const {
  AGENT_STATUS,
  createAgentRequest,
  createAgentResponse,
  collectAgentInputs,
  buildContextSnapshot,
  describeSnapshot,
} = require('./agent-request')

// 真实来源：ProjectContext 与 Problem 都来自项目自己的模块（不是手搓假对象）
const { createProjectContext } = require('./project-context')
const { createProblem } = require('./problem-model')

const H = createHarness()
const { chk, eq } = H

async function main() {
  console.log('\n=== ① P5A-01 AgentRequest：形状与校验 ===')
  {
    const r = createAgentRequest({ message: '修复 /users 返回 500' })
    chk('合法请求 ok', r.ok === true)
    chk('自动生成 requestId', typeof r.requestId === 'string' && r.requestId.length > 0, r.requestId)
    eq('无项目时 projectContext 为 null（合法）', r.projectContext, null)
    eq('sessionId 允许为空', r.sessionId, null)
    chk('对象被冻结（不可被下游改坏）', Object.isFrozen(r))

    chk('缺 message → 拒绝', createAgentRequest({}).ok === false)
    chk('message 全空白 → 拒绝', createAgentRequest({ message: '   ' }).ok === false)

    const bad = createAgentRequest({ message: 'x', projectContext: { projectType: 'moonbit' } })
    chk('projectContext 缺 rootDir → 拒绝', bad.ok === false)
    chk('  并且错误信息说明了原因', /rootDir/.test(bad.errors.join(' ')), JSON.stringify(bad.errors))

    const arr = createAgentRequest({ message: 'x', projectContext: ['not', 'an', 'object'] })
    chk('projectContext 是数组 → 拒绝', arr.ok === false)
  }

  console.log('\n=== ② P5A-02 AgentResponse：状态枚举与摘要裁剪 ===')
  {
    const res = createAgentResponse({ requestId: 'req-1', status: AGENT_STATUS.OK, message: 'done' })
    chk('合法响应 ok', res.ok === true)
    eq('状态为 ok', res.status, 'ok')
    eq('缺省 toolCalls 为空数组', res.toolCalls.length, 0)

    chk('非法 status → 拒绝', createAgentResponse({ requestId: 'r', status: 'whatever' }).ok === false)
    chk('缺 requestId → 拒绝', createAgentResponse({ status: 'ok' }).ok === false)

    const long = 'x'.repeat(500)
    const withCalls = createAgentResponse({
      requestId: 'req-2',
      toolCalls: [{ name: 'readFile', ok: true, ms: 12, summary: long }],
      patches: [{ file: 'a.mbt', summary: long, token: 't1', applied: true }],
      verification: { ok: false, status: 'verify_failed', rounds: 1, steps: [{ name: 'test', ok: false, ms: 5 }] },
    })
    chk('toolCall 摘要被裁到 200 字符', withCalls.toolCalls[0].summary.length === 200, String(withCalls.toolCalls[0].summary.length))
    chk('patch 摘要同样被裁', withCalls.patches[0].summary.length === 200)
    eq('verification 的 steps 带名字', withCalls.verification.steps[0].name, 'test')
    chk('need_confirm 是合法状态（Patch 必须先确认）', AGENT_STATUS.NEED_CONFIRM === 'need_confirm')
  }

  console.log('\n=== ③ P5A-03 真实接入 ProjectContext（用项目自己的 createProjectContext）===')
  {
    const realCtx = createProjectContext({ root: 'C:/tmp/proj', kind: 'moonbit' })
    const req = createAgentRequest({
      message: '看看这个项目',
      projectContext: realCtx,
      activeFile: { path: 'conduit/users.mbt', content: 'fn main {}', language: 'moonbit' },
    })
    chk('带真实 ProjectContext 的请求通过校验', req.ok === true, JSON.stringify(req.errors))
    eq('projectContext 原样带上（不是复制/改写）', req.projectContext.rootDir, realCtx.rootDir)
    eq('activeFile 归一化后保留 path', req.activeFile.path, 'conduit/users.mbt')
  }

  console.log('\n=== ④ P5A-04 真实接入 Problems（用项目自己的 createProblem）===')
  {
    const p1 = createProblem({ severity: 'error', file: 'a.mbt', line: 3, message: '类型不匹配', source: 'compiler' })
    const p2 = createProblem({ severity: 'warning', file: 'b.mbt', line: 9, message: '未使用变量', source: 'lsp' })
    const { inputs, sources } = await collectAgentInputs({
      getContext: () => createProjectContext({ root: 'C:/tmp/proj', kind: 'moonbit' }),
      listProblems: () => [p1, p2],
      getActiveFile: () => ({ path: 'a.mbt', content: 'x' }),
    })
    eq('problems 来自真实来源（数量）', inputs.problems.length, 2)
    eq('problems 内容保真（message）', inputs.problems[0].message, '类型不匹配')
    eq('sources 如实记录已取到的来源', [sources.project, sources.problems, sources.activeFile], ['ok', 'ok', 'ok'])
    eq('没注入的来源标为 absent（不是 error）', sources.lastRun, 'absent')

    const snap = buildContextSnapshot(createAgentRequest({ message: '看问题' }), inputs, sources)
    eq('快照里 problems 总数正确', snap.problems.total, 2)
    eq('快照按 severity 统计', snap.problems.bySeverity, { error: 1, warning: 1 })
    eq('快照标出有项目', snap.hasProject, true)
    eq('快照记录当前文件 path', snap.activeFile.path, 'a.mbt')
    chk('快照带上下文长度（不是 0）', snap.contextChars > 0, String(snap.contextChars))
    chk('快照不含正文（默认只给摘要）', snap.rendered === undefined)

    const full = buildContextSnapshot(createAgentRequest({ message: '看问题' }), inputs, sources, { includeRendered: true })
    chk('includeRendered 时才带全文', typeof full.rendered === 'string' && full.rendered.length > 0)

    const line = describeSnapshot(snap)
    chk('一行摘要可读', /req=/.test(line) && /问题=2/.test(line), line)
  }

  console.log('\n=== ⑤ 取数失败不能静默变成"没有数据"（空 catch 门禁要防的就是这个）===')
  {
    let threw = null
    let inputs = null
    let sources = null
    try {
      ;({ inputs, sources } = await collectAgentInputs({
        getContext: () => { throw new Error('context 取数炸了') },
        listProblems: () => { throw new Error('problems 取数炸了') },
      }))
    } catch (e) { threw = e }
    chk('取数抛错不会让整次收集失败（不抛）', threw === null, String(threw && threw.message))
    chk('project 记成 error 而不是 ok/absent', String(sources.project).startsWith('error'), sources.project)
    chk('problems 同样记成 error', String(sources.problems).startsWith('error'), sources.problems)
    chk('错误信息里带原因', /context 取数炸了/.test(sources.project), sources.project)
    eq('取不到就是 null / []（不编造）', [inputs.project, inputs.problems.length], [null, 0])

    const snap = buildContextSnapshot(createAgentRequest({ message: 'x' }), inputs, sources)
    chk('快照能看出"哪一路取数异常"', /取数异常=/.test(describeSnapshot(snap)), describeSnapshot(snap))
  }

  console.log('\n=== ⑥ 无项目也能提问（空上下文不崩）===')
  {
    const { inputs, sources } = await collectAgentInputs({})
    const snap = buildContextSnapshot(createAgentRequest({ message: '你好' }), inputs, sources)
    eq('无项目时 hasProject=false', snap.hasProject, false)
    eq('无项目时 project=null', snap.project, null)
    eq('无问题', snap.problems.total, 0)
    eq('全 absent', sources.project, 'absent')
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
