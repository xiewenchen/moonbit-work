'use strict'

/**
 * Agent 验证闭环单测（Phase 2 / MBW-P9-01 ～ P9-11）
 *
 * 纯 Node：applyPatch / check / test / run / health 全部注入。
 * 重点断言两类行为：
 *   ① 任一步失败 → **立刻停**（不"继续往下跑看看"）且失败变成统一 Problem；
 *   ② 连续失败 → **跑满轮次上限就停**（绝不死循环）。
 */

const {
  VERIFY_STATE,
  ALL_STATES,
  ALLOWED_TRANSITIONS,
  canTransition,
  createVerifyStateMachine,
  problemsFromStep,
  verifyOnce,
  createVerifyLoop,
  buildVerifyReport,
  renderVerifyReport,
} = require('./agent-verify')

let pass = 0
let fail = 0
const failures = []
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 假依赖：记录每一步跑了几次 */
function deps(over = {}) {
  const calls = { check: 0, test: 0, run: 0, health: 0 }
  return {
    calls,
    applyPatch: async () => ({ ok: true, file: 'a.mbt' }),
    check: async () => { calls.check++; return { ok: true } },
    test: async () => { calls.test++; return { ok: true } },
    run: async () => { calls.run++; return { ok: true } },
    health: async () => { calls.health++; return { ok: true } },
    now: () => Date.now(),
    ...over,
  }
}

async function main() {
  console.log('\n=== P9-08 Verify 状态机 ===')
  {
    chk('7 个状态', ALL_STATES, ['patched', 'checking', 'testing', 'starting', 'health_check', 'verified', 'verify_failed'])
    chk('允许：patched → checking', canTransition(VERIFY_STATE.PATCHED, VERIFY_STATE.CHECKING), true)
    chk('允许：checking → testing / verify_failed', [canTransition(VERIFY_STATE.CHECKING, VERIFY_STATE.TESTING), canTransition(VERIFY_STATE.CHECKING, VERIFY_STATE.VERIFY_FAILED)], [true, true])
    chk('**禁止跳级**：patched → verified', canTransition(VERIFY_STATE.PATCHED, VERIFY_STATE.VERIFIED), false)
    chk('终态无出边', [ALLOWED_TRANSITIONS[VERIFY_STATE.VERIFIED].length, ALLOWED_TRANSITIONS[VERIFY_STATE.VERIFY_FAILED].length], [0, 0])

    const sm = createVerifyStateMachine()
    chk('初始 patched', sm.state, VERIFY_STATE.PATCHED)
    for (const s of [VERIFY_STATE.CHECKING, VERIFY_STATE.TESTING, VERIFY_STATE.STARTING, VERIFY_STATE.HEALTH_CHECK, VERIFY_STATE.VERIFIED]) sm.to(s)
    chk('一路走到 VERIFIED', [sm.state, sm.isTerminal()], [VERIFY_STATE.VERIFIED, true])
    chk('终态不能再前进', sm.to(VERIFY_STATE.CHECKING).ok, false)
  }

  console.log('\n=== P9-01 ～ P9-07 闭环：全成功 ===')
  {
    const d = deps()
    const r = await verifyOnce({ patch: { file: 'a.mbt' }, deps: d })
    chk('结果 VERIFIED', [r.ok, r.status], [true, VERIFY_STATE.VERIFIED])
    chk('五步都跑了且都 ok', r.steps.map((s) => s.name + ':' + s.ok), ['apply:true', 'check:true', 'test:true', 'run:true', 'health:true'])
    chk('五个阶段各调一次', d.calls, { check: 1, test: 1, run: 1, health: 1 })
    chk('没有产生问题', r.problems.length, 0)
  }

  console.log('\n=== P9-02/04/07 失败 → 立刻停 + 变成统一 Problem ===')
  {
    // check 失败：不该再跑 test/run/health
    const d = deps({ check: async () => { d.calls.check++; return { ok: false, error: '编译失败', output: 'Error: [4021]\n   \u256d\u2500[ /p/a.mbt:2:1 ]\n   \u2502   \u2570\u2500 unbound' } } })
    const r = await verifyOnce({ patch: { file: 'a.mbt' }, deps: d })
    chk('**check 失败 → 立刻停**', [r.ok, r.status], [false, VERIFY_STATE.VERIFY_FAILED])
    chk('**没有继续跑 test/run/health**', [d.calls.test, d.calls.run, d.calls.health], [0, 0, 0])
    chk('失败变成 Problem（来源=compiler）', [r.problems.length, r.problems[0].source], [1, 'compiler'])
    chk('步骤表停在 check', r.steps.map((s) => s.name), ['apply', 'check'])
  }
  {
    const d = deps({ test: async () => { d.calls.test++; return { ok: false, error: '测试失败', name: 't1' } } })
    const r = await verifyOnce({ patch: { file: 'a.mbt' }, deps: d })
    chk('test 失败 → Problem 来源=test', [r.status, r.problems[0].source], [VERIFY_STATE.VERIFY_FAILED, 'test'])
    chk('run/health 没跑', [d.calls.run, d.calls.health], [0, 0])
  }
  {
    const d = deps({ run: async () => { d.calls.run++; return { ok: false, error: '端口没起来' } } })
    const r = await verifyOnce({ patch: { file: 'a.mbt' }, deps: d })
    chk('run 失败 → Problem 来源=runtime', [r.status, r.problems[0].source], [VERIFY_STATE.VERIFY_FAILED, 'runtime'])
    chk('health 没跑', d.calls.health, 0)
  }
  {
    const d = deps({ health: async () => { d.calls.health++; return { ok: false, error: '502', status: 502, url: 'http://127.0.0.1:1/health' } } })
    const r = await verifyOnce({ patch: { file: 'a.mbt' }, deps: d })
    chk('health 失败 → Problem 来源=api', [r.status, r.problems[0].source], [VERIFY_STATE.VERIFY_FAILED, 'api'])
  }
  {
    const d = deps({ check: async () => { throw new Error('检查器炸了') } })
    const r = await verifyOnce({ patch: { file: 'a.mbt' }, deps: d })
    chk('步骤抛错 → 转成失败（不冒泡）', [r.ok, /检查器炸了/.test(String(r.error))], [false, true])
  }
  {
    const d = deps({ applyPatch: async () => ({ ok: false, error: 'old 匹配不上' }) })
    const r = await verifyOnce({ patch: { file: 'a.mbt' }, deps: d })
    chk('apply 失败 → 一步都不往下跑', [r.ok, d.calls.check], [false, 0])
  }

  console.log('\n=== P9-09/P9-10 轮次上限：绝不死循环 ===')
  {
    let fixCalls = 0
    const loop = createVerifyLoop({
      maxRounds: 3,
      fix: async () => { fixCalls++; return { patch: { file: 'a.mbt', n: fixCalls } } },   // 一直给"新 patch"，但永远失败
    })
    const r = await loop.run({ patch: { file: 'a.mbt' }, deps: deps({ check: async () => ({ ok: false, error: '一直失败' }) }) })
    chk('**跑满 3 轮就停**', [r.ok, r.rounds], [false, 3])
    chk('停止原因写明是轮次用尽', /已用满/.test(String(r.stoppedReason)), true)
    chk('fix 只被叫 2 次（第 3 轮后不再尝试）', fixCalls, 2)
    chk('保留了每一轮的结果', r.all.length, 3)
    chk('maxRounds 可查询', loop.maxRounds, 3)
  }
  {
    let attempt = 0
    const loop = createVerifyLoop({
      maxRounds: 5,
      fix: async () => ({ patch: { file: 'a.mbt', attempt: ++attempt } }),
    })
    const d = deps({ check: async () => (attempt >= 1 ? { ok: true } : { ok: false, error: '还没修好' }) })
    const r = await loop.run({ patch: { file: 'a.mbt' }, deps: d })
    chk('**第 2 轮修好后停止且 ok**', [r.ok, r.rounds], [true, 2])
    chk('停止原因清空（因为成功了）', r.stoppedReason, null)
  }
  {
    const loop = createVerifyLoop({ maxRounds: 3 })                    // 没有 fix
    const r = await loop.run({ patch: { file: 'a.mbt' }, deps: deps({ check: async () => ({ ok: false, error: 'x' }) }) })
    chk('没提供 fix → 只跑 1 轮就停', [r.rounds, /没有提供 fix/.test(String(r.stoppedReason))], [1, true])
  }
  {
    const loop = createVerifyLoop({
      maxRounds: 3,
      fix: async () => { throw new Error('修复提议炸了') },
    })
    const r = await loop.run({ patch: { file: 'a.mbt' }, deps: deps({ check: async () => ({ ok: false, error: 'x' }) }) })
    chk('fix 抛错 → 停止（不无限重试）', [r.ok, r.rounds], [false, 1])
  }

  console.log('\n=== P9-11 最终报告 ===')
  {
    const loop = createVerifyLoop({ maxRounds: 2 })
    const session = await loop.run({ patch: { file: 'a.mbt' }, deps: deps({ check: async () => ({ ok: false, error: '编译失败', output: 'Error: [4021]\n   \u256d\u2500[ /p/a.mbt:2:1 ]\n   \u2502   \u2570\u2500 unbound' }) }) })
    const rep = buildVerifyReport(session)
    chk('报告含结论/轮次/步骤/问题', [rep.ok, rep.rounds, rep.maxRounds, rep.steps.length > 0, rep.problems.length > 0], [false, 1, 2, true, true])
    chk('报告带停止原因', typeof rep.stoppedReason, 'string')

    const md = renderVerifyReport(rep)
    chk('渲染成可读文本（含结论与步骤表）', [/验证报告/.test(md), /VERIFY_FAILED/.test(md), /\| 步骤 \| 结果 \|/.test(md), /待处理问题/.test(md)], [true, true, true, true])

    const okSession = await createVerifyLoop({ maxRounds: 2 }).run({ patch: { file: 'b.mbt' }, deps: deps() })
    const okMd = renderVerifyReport(buildVerifyReport(okSession))
    chk('成功路径的报告写 VERIFIED', [/VERIFIED/.test(okMd), /通过/.test(okMd)], [true, true])
  }

  console.log('\n=== problemsFromStep 的来源映射 ===')
  {
    chk('check → compiler', problemsFromStep('check', { output: 'Error: [4021]\n   \u256d\u2500[ /p/a.mbt:2:1 ]\n   \u2502   \u2570\u2500 x' })[0].source, 'compiler')
    chk('test → test', problemsFromStep('test', { name: 't', error: 'e' })[0].source, 'test')
    chk('run → runtime', problemsFromStep('run', { error: 'e' })[0].source, 'runtime')
    chk('health → api', problemsFromStep('health', { status: 500, url: 'http://x' })[0].source, 'api')
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('单测异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
