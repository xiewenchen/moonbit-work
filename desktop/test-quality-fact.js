// PH3-Q 的验证：Quality 事实层（provenance / 新鲜度 / STALE / 退化检测）。
//
// 纯逻辑，可进 CI。样本用真实形状（与 quality-result.js 的产物一致）。
const { createHarness } = require('./verify-harness')
const { QUALITY_STATE } = require('./quality-result')
const {
  FACT_STATE, VERIFY_ORIGIN, VERIFY_ENV, DEFAULT_MAX_AGE_MS, STATE_RANK,
  withProvenance, ageOf, staleness, applyStaleness, canProceed, countsOf,
  compareQuality, createFactSnapshot, describeFact,
} = require('./quality-fact')

const H = createHarness()
const { chk, eq } = H

const r = (name, state, extra) => Object.assign({ name, state, source: 'desktopVerify', passed: 0, failed: 0 }, extra || {})

console.log('=== ① 状态集合：原 5 态 + STALE ===')
{
  for (const s of ['PASS', 'FAIL', 'WARN', 'SKIP', 'NOT_RUN']) chk('保留 ' + s, FACT_STATE[s] === s)
  eq('★ 多了 STALE（过期）', FACT_STATE.STALE, 'STALE')
  chk('  STALE 不在原 5 态里（是事实层新增的）', ['PASS', 'FAIL', 'WARN', 'SKIP', 'NOT_RUN'].indexOf('STALE') < 0)
  eq('来源恰为 CI/LOCAL/E2E/USER', Object.values(VERIFY_ORIGIN).sort(), ['CI', 'E2E', 'LOCAL', 'USER'])
}

console.log('\n=== ② PH3-Q-05 溯源：四个字段都能填，填不出就留 null ===')
{
  const a = withProvenance(r('构建', 'PASS'), { at: 1000, origin: 'CI', command: 'moon build --target native', env: 'linux', commit: 'abc1234def' })
  eq('什么时候跑', a.provenance.at, 1000)
  eq('谁跑的', a.provenance.origin, 'CI')
  eq('什么命令', a.provenance.command, 'moon build --target native')
  eq('什么环境', a.provenance.env, 'linux')
  eq('对应哪个 commit（PH3-Q-06）', a.provenance.commit, 'abc1234def')
  eq('  verifiedAt 也跟着填上', a.verifiedAt, 1000)

  const b = withProvenance(r('x', 'PASS'), {})
  eq('★ 填不出来的 origin 留 null（不编一个）', b.provenance.origin, null)
  eq('  环境也留 null', b.provenance.env, null)
  const bad = withProvenance(r('x', 'PASS'), { origin: 'SOMETHING', env: 'solaris' })
  eq('★ 非法来源被拒（留 null 而不是原样存）', bad.provenance.origin, null)
  eq('★ 非法环境同样', bad.provenance.env, null)
  chk('null 输入不炸', withProvenance(null, {}).provenance.at === null)
}

console.log('\n=== ③ PH3-Q-03 新鲜度：没有时间戳 ≠ 刚跑过 ===')
{
  eq('★ 没有时间戳 → age 为 null（不是 0）', ageOf(r('x', 'PASS'), 99999), null)
  eq('有 verifiedAt → 能算', ageOf(r('x', 'PASS', { verifiedAt: 1000 }), 1500), 500)
  eq('  从 provenance.at 也能算', ageOf(withProvenance(r('x', 'PASS'), { at: 1000 }), 1600), 600)

  const fresh = staleness(r('x', 'PASS', { verifiedAt: 1000 }), { now: 1500, maxAgeMs: 1000 })
  chk('未过期 → fresh', fresh.fresh === true && fresh.stale === false)
  const stale = staleness(r('x', 'PASS', { verifiedAt: 1000 }), { now: 5000, maxAgeMs: 1000 })
  chk('★ 过期 → stale，并说明原因', stale.stale === true && /已过期/.test(stale.reason), stale.reason)
  const unknown = staleness(r('x', 'PASS'), { now: 5000 })
  chk('★ 没时间戳 → unknown（**不冒充新鲜**）', unknown.unknown === true && unknown.fresh === false && unknown.stale === false)
  chk('  默认上限是 24 小时', DEFAULT_MAX_AGE_MS === 24 * 3600 * 1000)
}

console.log('\n=== ④ PH3-Q-04 过期 → STALE（只动曾经通过的项）===')
{
  const results = [
    r('构建', 'PASS', { verifiedAt: 1000 }),
    r('单元测试', 'FAIL', { verifiedAt: 1000 }),
    r('安全', 'NOT_RUN'),
    r('性能', 'SKIP'),
    r('真实负载', 'WARN', { verifiedAt: 1000 }),
  ]
  const out = applyStaleness(results, { now: 99999999, maxAgeMs: 1000 })
  eq('★ 过期的 PASS → STALE', out[0].state, 'STALE')
  chk('  且保留"上次是 PASS"', out[0].previousState === 'PASS', JSON.stringify(out[0].previousState))
  chk('  带过期原因', /已过期/.test(String(out[0].staleReason)), String(out[0].staleReason))
  eq('★ FAIL 不改成 STALE（本来就失败，改了会丢信息）', out[1].state, 'FAIL')
  eq('★ NOT_RUN 不动（"没跑过"≠"跑过但过期"）', out[2].state, 'NOT_RUN')
  eq('★ SKIP 不动', out[3].state, 'SKIP')
  eq('过期的 WARN 也标 STALE', out[4].state, 'STALE')

  const fresh = applyStaleness(results, { now: 1500, maxAgeMs: 10000 })
  eq('没过期就不动它', fresh[0].state, 'PASS')
  eq('空输入不炸', applyStaleness(null).length, 0)
  eq('非数组不炸', applyStaleness('x').length, 0)
}

console.log('\n=== ⑤ PH3-Q-09 能不能继续 ===')
{
  chk('全 PASS → 可以继续', canProceed([r('a', 'PASS'), r('b', 'PASS')]).ok === true)
  const withFail = canProceed([r('a', 'PASS'), r('测试', 'FAIL')])
  eq('★ 有 FAIL → 不许继续', withFail.ok, false)
  chk('  说清是哪些项挡着', /测试/.test(JSON.stringify(withFail.blockers)), JSON.stringify(withFail.blockers))
  const withStale = canProceed([r('a', 'STALE')])
  eq('★ 有 STALE → 也不许继续（过期不算通过）', withStale.ok, false)
  chk('NOT_RUN / SKIP 不算阻塞（它们只是"没这一项"）',
    canProceed([r('a', 'NOT_RUN'), r('b', 'SKIP')]).ok === true)
  chk('空输入不炸', canProceed(null).ok === true)
}

console.log('\n=== ⑥ PH3-Q-10/11 退化检测 ===')
{
  // 清单点名的例子：Test 156 → 154
  const before = [r('单元测试', 'PASS', { passed: 156, failed: 0 }), r('构建', 'PASS')]
  const after = [r('单元测试', 'PASS', { passed: 154, failed: 0 }), r('构建', 'PASS')]
  const c1 = compareQuality(before, after)
  eq('★ 通过数 156→154 被判为退化', c1.hasRegression, true)
  const reg = c1.regressions.find((x) => x.kind === 'fewer-passed')
  chk('  退化里带上了数字', !!reg && reg.from === 156 && reg.to === 154, JSON.stringify(reg))
  chk('  摘要可读', /通过数下降/.test(c1.summary), c1.summary)

  // 状态变差
  const c2 = compareQuality([r('构建', 'PASS')], [r('构建', 'FAIL')])
  chk('★ PASS → FAIL 判为退化', c2.hasRegression === true && c2.regressions[0].kind === 'state-worse', JSON.stringify(c2.regressions))
  // 变好
  const c3 = compareQuality([r('构建', 'FAIL')], [r('构建', 'PASS')])
  eq('FAIL → PASS 不算退化', c3.hasRegression, false)
  eq('  而且算改进', c3.improvements.length, 1)
  // 新增失败项
  const c4 = compareQuality([r('a', 'PASS')], [r('a', 'PASS'), r('新测试', 'FAIL', { passed: 0, failed: 3 })])
  chk('★ 新出现的失败项也算退化', c4.regressions.some((x) => x.kind === 'new-failure'), JSON.stringify(c4.regressions))
  // 通过数变多
  const c5 = compareQuality([r('t', 'PASS', { passed: 1 })], [r('t', 'PASS', { passed: 5 })])
  eq('通过数变多 → 改进，不是退化', c5.hasRegression, false)
  // 边界
  eq('两次都空 → 无退化', compareQuality([], []).hasRegression, false)
  eq('null 输入不炸', compareQuality(null, null).hasRegression, false)
  eq('没变化时摘要也如实说', compareQuality(before, before).summary, '与上次相比没有退化')

  chk('状态排序：PASS 优于 FAIL', STATE_RANK.PASS > STATE_RANK.FAIL)
  chk('STALE 排在 FAIL 之上（过期 > 失败）', STATE_RANK.STALE > STATE_RANK.FAIL)
}

console.log('\n=== ⑦ PH3-Q-01 事实快照（结果 + 环境 + 来源 + 时间 + commit）===')
{
  const snap = createFactSnapshot({
    project: 'C:/proj',
    results: [r('构建', 'PASS', { verifiedAt: 1000 }), r('测试', 'FAIL', { verifiedAt: 1000 })],
    environment: 'windows', origin: 'LOCAL', commit: 'deadbeef', now: 1500,
  })
  eq('project', snap.project, 'C:/proj')
  eq('timestamp', snap.timestamp, 1500)
  eq('environment', snap.environment, 'windows')
  eq('origin', snap.origin, 'LOCAL')
  eq('commit（PH3-Q-06 绑定）', snap.commit, 'deadbeef')
  eq('★ 有 FAIL → overall 是 FAIL', snap.overall, 'FAIL')
  eq('  恰好 0 项过期', snap.staleCount, 0)
  chk('  快照冻结', Object.isFrozen(snap))

  // 全过期 → overall 是 STALE（而不是悄悄仍显示 PASS）
  const stale2 = createFactSnapshot({ results: [r('构建', 'PASS', { verifiedAt: 1000 })], now: 9e9 })
  eq('★ 全过期 → overall 是 STALE，不是 PASS', stale2.overall, 'STALE')
  eq('  staleCount 对得上', stale2.staleCount, 1)
  eq('★ 且 canProceed 说不行', stale2.canProceed.ok, false)

  // 全没跑 → NOT_RUN（PH3-Q-12 不允许假设）
  const none = createFactSnapshot({ results: [r('a', 'NOT_RUN'), r('b', 'SKIP')], now: 1 })
  eq('★ 没数据 → NOT_RUN（不假设通过）', none.overall, 'NOT_RUN')
  eq('空结果也是 NOT_RUN', createFactSnapshot({ results: [], now: 1 }).overall, 'NOT_RUN')

  // 非法 environment → unknown
  eq('非法环境退化为 unknown', createFactSnapshot({ results: [], environment: 'plan9', now: 1 }).environment, 'unknown')
  eq('非法来源留 null', createFactSnapshot({ results: [], origin: 'X', now: 1 }).origin, null)
  chk('null 输入不炸', createFactSnapshot({}).overall === 'NOT_RUN')
}

console.log('\n=== ⑧ describeFact 可读 ===')
{
  const snap = createFactSnapshot({ results: [r('构建', 'PASS', { verifiedAt: 1000 })], commit: 'abcdef123456', now: 1500 })
  const d = describeFact(snap)
  chk('说状态', /工程状态：通过/.test(d), d)
  chk('带 commit 短哈希', /abcdef12/.test(d), d)
  chk('说能不能继续', /可以继续/.test(d), d)
  eq('null → 占位（不炸）', describeFact(null), '（没有快照）')
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
