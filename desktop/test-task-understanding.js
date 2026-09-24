'use strict'

/**
 * TaskUnderstanding 单测（Phase 2.1 / P9A-01）
 *
 * 纯 Node。断言用公共 verify-harness（P19-18 起新脚本一律如此）。
 *
 * 重点验的是"可核对"：每一栏都要能指出来源，而不是"模型说了算"。
 */

const { createHarness } = require('./verify-harness')
const {
  buildTaskUnderstanding,
  applyLlmPlan,
  describeUnderstanding,
  extractPathLike,
  extractKeywords,
} = require('./task-understanding')
const { createProjectContext } = require('./project-context')
const { createProblem } = require('./problem-model')

const H = createHarness()
const { chk, eq } = H

/** 造一份真实形状的输入（ProjectContext / Problem 都用项目自己的模块）*/
function makeInputs(extra = {}) {
  return Object.assign({
    project: createProjectContext({ root: 'C:/tmp/proj', kind: 'moonbit' }),
    activeFile: { path: 'conduit/app.mbt', content: 'fn main {}' },
    problems: [],
    selection: null,
    lastRun: null,
    lastTest: null,
    recentFiles: [],
  }, extra)
}

async function main() {
  console.log('\n=== ① 从一句话里认出路径（P9A-01 的输入面）===')
  {
    const got = extractPathLike('修复 /users 返回 500，改 conduit/users.mbt 里的 handler')
    chk('认出了 conduit/users.mbt', got.indexOf('conduit/users.mbt') >= 0, JSON.stringify(got))
    chk('不会把 /users 当成文件（它没有扩展名也没有第二段）', got.indexOf('/users') < 0, JSON.stringify(got))
    eq('去重且保序', extractPathLike('a.mbt b.mbt a.mbt'), ['a.mbt', 'b.mbt'])
    eq('认多语言扩展名', extractPathLike('看 src/app.ts 和 db/init.sql'), ['src/app.ts', 'db/init.sql'])
  }

  console.log('\n=== ② 关键词抽取（用于匹配问题描述）===')
  {
    const kw = extractKeywords('修复 users 接口返回 500 的问题')
    chk('抽出英文词 users', kw.indexOf('users') >= 0, JSON.stringify(kw))
    chk('抽出中文片段', kw.some((w) => /接口|返回/.test(w)), JSON.stringify(kw))
    chk('停用词被去掉', kw.indexOf('the') < 0 && kw.indexOf('fix') < 0)
  }

  console.log('\n=== ③ goal / project 来自事实 ===')
  {
    const req = { message: '修复 conduit/users.mbt 的 500', requestId: 'req-1' }
    const u = buildTaskUnderstanding(req, makeInputs())
    eq('goal 就是用户这句话', u.goal, '修复 conduit/users.mbt 的 500')
    eq('project 来自真实 ProjectContext', u.project.projectType, 'moonbit')
    eq('project 标了来源', u.project.source, 'projectContext')
    eq('requestId 带上（可回溯是哪次请求）', u.requestId, 'req-1')
    chk('对象被冻结', Object.isFrozen(u))
    chk('空 message 不崩', buildTaskUnderstanding({}, {}).goal === '')
    eq('无项目时 project=null', buildTaskUnderstanding({ message: 'x' }, {}).project, null)
  }

  console.log('\n=== ④ relevantFiles：两类来源各标 why（可核对）===')
  {
    const inputs = makeInputs({
      activeFile: { path: 'conduit/app.mbt', content: 'x' },
      problems: [createProblem({ severity: 'error', file: 'conduit/auth.mbt', line: 7, message: '类型不匹配', source: 'compiler' })],
    })
    const u = buildTaskUnderstanding({ message: '看下 conduit/users.mbt' }, inputs, { exists: () => true })
    const byPath = {}
    for (const f of u.relevantFiles) byPath[f.path] = f.why
    eq('任务里提到的文件 why=mentionedInTask', byPath['conduit/users.mbt'], 'mentionedInTask')
    eq('当前文件 why=activeFile', byPath['conduit/app.mbt'], 'activeFile')
    // ⚠️ 与任务无关的那个问题（auth.mbt）不该把它的文件拖进"相关"里 ——
    // 否则每个有问题的文件都会因为"它自己有错"而命中自己，"相关"就没意义了。
    eq('无关问题的文件**不**进相关列表', u.relevantFiles.length, 2)
    eq('  它也不在相关文件里', Object.keys(byPath).indexOf('conduit/auth.mbt'), -1)

    // 正例：问题文件与任务提到的文件重合 → 只出现一次，why 取"任务里提到"
    const u3 = buildTaskUnderstanding({ message: '看下 conduit/auth.mbt' },
      makeInputs({ activeFile: null, problems: [createProblem({ severity: 'error', file: 'conduit/auth.mbt', message: 'x' })] }),
      { exists: () => true })
    eq('重合时只出现一次', u3.relevantFiles.length, 1)
    eq('  且 why=mentionedInTask', u3.relevantFiles[0].why, 'mentionedInTask')

    // hasProblem 的来源：问题靠**关键词**命中（任务里没写文件名）→ 它的文件以 hasProblem 进来
    const u4 = buildTaskUnderstanding({ message: '修复 users 接口 500' },
      makeInputs({ activeFile: null, problems: [createProblem({ severity: 'error', file: 'conduit/users.mbt', message: 'users handler 返回 500' })] }),
      { exists: () => true })
    eq('关键词命中的问题其文件以 hasProblem 进来', u4.relevantFiles[0] && u4.relevantFiles[0].why, 'hasProblem')

    // exists 注入为 false 时，任务里提到的（不存在的）路径要被过滤掉
    const u2 = buildTaskUnderstanding({ message: '看下 ghost.mbt' }, makeInputs({ activeFile: null }), { exists: () => false })
    eq('不存在的路径被过滤', u2.relevantFiles.length, 0)
  }

  console.log('\n=== ⑤ relevantProblems：文件对得上 或 关键词命中 ===')
  {
    const inputs = makeInputs({
      problems: [
        createProblem({ severity: 'error', file: 'conduit/auth.mbt', line: 7, message: '类型不匹配', source: 'compiler' }),
        createProblem({ severity: 'warning', file: 'unrelated.mbt', line: 1, message: '未使用变量', source: 'lsp' }),
        createProblem({ severity: 'error', file: 'other.mbt', line: 2, message: 'users handler 返回 500', source: 'runtime' }),
      ],
    })
    const u = buildTaskUnderstanding({ message: '修复 users 返回 500' }, inputs, { exists: () => true })
    const ids = u.relevantProblems.map((p) => p.file)
    chk('关键词命中 other.mbt（message 里有 users/500）', ids.indexOf('other.mbt') >= 0, JSON.stringify(ids))
    chk('完全无关的不进列表', ids.indexOf('unrelated.mbt') < 0, JSON.stringify(ids))
    chk('每条都带 id（能点开）', u.relevantProblems.every((p) => typeof p.id === 'string' && p.id.length > 0))
    chk('message 被裁到 200 字符以内', u.relevantProblems.every((p) => p.message.length <= 200))
  }

  console.log('\n=== ⑥ proposedActions：规则推出来的，每条带 rule ===')
  {
    const withErr = buildTaskUnderstanding(
      { message: '修复 conduit/auth.mbt' },
      makeInputs({ problems: [createProblem({ severity: 'error', file: 'conduit/auth.mbt', message: '类型不匹配' })] }),
      { exists: () => true },
    )
    const names = withErr.proposedActions.map((a) => a.action)
    eq('有 error → 四步（读/改/检查/测试）', names, ['readFile', 'proposePatch', 'check', 'test'])
    chk('每条都说明为什么（rule 非空）', withErr.proposedActions.every((a) => a.rule && a.rule.length > 0))
    eq('改文件走 proposePatch（不是直接写）', names.indexOf('applyPatch'), -1)

    const noErr = buildTaskUnderstanding({ message: '看看这个项目' }, makeInputs(), { exists: () => true })
    const n2 = noErr.proposedActions.map((a) => a.action)
    eq('没问题时只读 + 检查（不提议改文件）', n2, ['readFile', 'check'])
    chk('没问题时不出现 proposePatch', n2.indexOf('proposePatch') < 0)

    // review 指出的边界：有问题但**定位不到文件**（没 file、也没当前文件）时，
    // 不该推出"改某处"——否则会得到一个"改哪里都不知道"的补丁动作。
    const noTarget = buildTaskUnderstanding(
      { message: '修复 users 接口 500' },
      makeInputs({ activeFile: null, problems: [createProblem({ severity: 'error', file: null, message: 'users 返回 500' })] }),
      { exists: () => true },
    )
    const n3 = noTarget.proposedActions.map((a) => a.action)
    chk('定位不到文件时不推 proposePatch', n3.indexOf('proposePatch') < 0, JSON.stringify(n3))
    chk('而是推 locateFile（先找到要改的地方）', n3.indexOf('locateFile') >= 0, JSON.stringify(n3))
  }

  console.log('\n=== ⑦ constraints 来自门禁（不是模型自律）===')
  {
    const u = buildTaskUnderstanding({ message: 'x' }, makeInputs())
    eq('默认就要确认（Gate P8）', u.constraints.needsConfirmBeforeApply, true)
    eq('当前不允许直接改文件', u.constraints.canModifyFiles, false)
    eq('默认不自动执行', u.constraints.autoStart, false)
    chk('写清了两条边界', u.constraints.notes.length >= 2, JSON.stringify(u.constraints.notes))

    const auto = buildTaskUnderstanding({ message: 'x' }, makeInputs(), { policy: { autoStart: true, confirmBeforeApply: false } })
    eq('policy 可放开 autoStart', auto.constraints.autoStart, true)
    eq('policy 可关掉确认（只影响"要不要先问"，不代表能绕过 Gate）', auto.constraints.needsConfirmBeforeApply, false)
  }

  console.log('\n=== ⑧ applyLlmPlan：只允许覆盖计划，事实不许被改 ===')
  {
    const before = buildTaskUnderstanding(
      { message: '修复 conduit/auth.mbt', requestId: 'r1' },
      makeInputs({ problems: [createProblem({ severity: 'error', file: 'conduit/auth.mbt', message: 'boom' })] }),
      { exists: () => true },
    )
    const after = applyLlmPlan(before, [
      { action: 'readFile', target: 'conduit/auth.mbt' },
      { action: 'proposePatch', target: 'conduit/auth.mbt' },
    ])
    eq('计划被替换', after.proposedActions.map((a) => a.action), ['readFile', 'proposePatch'])
    eq('计划来源标为 llm', after.planSource, 'llm')
    eq('每条 rule=llmPlan', after.proposedActions[0].rule, 'llmPlan')
    eq('**goal 没被改**', after.goal, before.goal)
    eq('**project 没被改**', after.project.projectType, before.project.projectType)
    eq('**relevantFiles 没被改**', after.relevantFiles.length, before.relevantFiles.length)
    eq('**relevantProblems 没被改**', after.relevantProblems.length, before.relevantProblems.length)
    eq('**constraints 没被改**', after.constraints.needsConfirmBeforeApply, true)
    chk('空的/非法的 plan 不会把计划清空', applyLlmPlan(before, [{}]).proposedActions.length === before.proposedActions.length)
    chk('传非数组 → 原样返回', applyLlmPlan(before, 'not-an-array') === before)
  }

  console.log('\n=== ⑨ describeUnderstanding 可读 ===')
  {
    const u = buildTaskUnderstanding(
      { message: '修复 conduit/auth.mbt' },
      makeInputs({ problems: [createProblem({ severity: 'error', file: 'conduit/auth.mbt', message: 'x' })] }),
      { exists: () => true },
    )
    const line = describeUnderstanding(u)
    chk('含项目类型', /项目=moonbit/.test(line), line)
    chk('含相关文件', /相关文件=conduit\/auth\.mbt/.test(line), line)
    chk('含问题数', /相关问题=1/.test(line), line)
    chk('含需确认标记', /需确认/.test(line), line)
    chk('摘要里没有换行（不会伪造日志行）', !/[\r\n]/.test(line), JSON.stringify(line))
    eq('null 也不崩', describeUnderstanding(null), '（无理解结果）')
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
