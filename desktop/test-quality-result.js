'use strict'

/**
 * Quality Center 模型单测（Phase 2.1 / P16-01 ～ P16-09、P16-13/14）
 *
 * 纯 Node。断言用公共 verify-harness。
 *
 * 三处最容易犯的错，这里都盯着：
 *   ① 把"没读懂"当成 PASS（所以解析不出必须 NOT_RUN）；
 *   ② 把"环境跳过"和"没跑"混成一个（所以 SKIP 与 NOT_RUN 分开）；
 *   ③ 有失败还让人继续（所以 canProceed 必须拦住）。
 */

const { createHarness } = require('./verify-harness')
const {
  QUALITY_STATE,
  ALL_STATES,
  createQualityResult,
  parseCounts,
  fromBuildResult,
  fromTestResult,
  fromWasmResult,
  fromSecurityReport,
  fromRealWorldReport,
  fromPerfReport,
  fromDesktopVerify,
  createQualityStore,
  overall,
  canProceed,
  describeQuality,
} = require('./quality-result')

const H = createHarness()
const { chk, eq } = H

async function main() {
  console.log('\n=== ① P16-01 QualityResult 与五态 ===')
  {
    eq('五态齐备', ALL_STATES, ['PASS', 'FAIL', 'WARN', 'SKIP', 'NOT_RUN'])
    const r = createQualityResult({ name: '构建', state: QUALITY_STATE.PASS, source: 'build' })
    chk('合法结果 ok', r.ok === true)
    chk('对象被冻结', Object.isFrozen(r))
    eq('id 由 name+source 组成', r.id, '构建@build')
    chk('缺 name → 拒绝', createQualityResult({ state: 'PASS' }).ok === false)
    chk('非法 state → 拒绝', createQualityResult({ name: 'x', state: 'GOOD' }).ok === false)
    eq('缺省是 NOT_RUN（不默认成功）', createQualityResult({ name: 'x' }).state, 'NOT_RUN')
    const long = createQualityResult({ name: 'x', detail: 'y'.repeat(2000) })
    chk('detail 被裁剪', long.detail.length <= 800, String(long.detail.length))
  }

  console.log('\n=== ② 计数解析 ===')
  {
    eq('中文', parseCounts('结果：31 通过 / 0 失败 / 共 31 项'), { passed: 31, failed: 0, skipped: null })
    eq('含跳过', parseCounts('10 通过 / 2 失败 / 3 跳过'), { passed: 10, failed: 2, skipped: 3 })
    eq('解析不出 → 全 null（不瞎猜 0）', parseCounts('啥也没有'), { passed: null, failed: null, skipped: null })
  }

  console.log('\n=== ③ P16-02 构建 Adapter ===')
  {
    eq('成功 → PASS', fromBuildResult({ ok: true }).state, 'PASS')
    eq('失败且带 error → FAIL', fromBuildResult({ ok: false, error: 'moon check 未通过' }).state, 'FAIL')
    eq('没有结果 → NOT_RUN', fromBuildResult({}).state, 'NOT_RUN')
    chk('详情保留了报错', /moon check/.test(fromBuildResult({ ok: false, error: 'moon check 未通过' }).detail))
  }

  console.log('\n=== ④ P16-03/04 测试 Adapter（native / wasm-gc）===')
  {
    const t = fromTestResult({ ok: true, stdout: '156 通过 / 0 失败' })
    eq('native 成功 → PASS', t.state, 'PASS')
    eq('  计数被解析', [t.passed, t.failed], [156, 0])
    const w = fromWasmResult({ ok: false, error: 'boom', code: 1 })
    eq('wasm 失败 → FAIL', w.state, 'FAIL')
    eq('  名字区分得开', w.name.indexOf('wasm-gc') >= 0, true)
    eq('没有输出也没失败 → NOT_RUN', fromTestResult({}).state, 'NOT_RUN')
  }

  console.log('\n=== ⑤ P16-05/06 靶场与 RealWorld：**解析不出不假装通过** ===')
  {
    const secOk = fromSecurityReport('安全靶场：23/23 通过')
    eq('靶场全过 → PASS', secOk.state, 'PASS')
    eq('  计数对', [secOk.passed, secOk.failed], [23, 0])
    const secBad = fromSecurityReport('安全靶场：20/23 通过')
    eq('靶场有缺 → FAIL', secBad.state, 'FAIL')
    eq('  failed = 3', secBad.failed, 3)

    // ★ 关键：读不懂必须 NOT_RUN
    eq('★ 读不懂的报告 → NOT_RUN（不是 PASS）', fromSecurityReport('这里啥也没说').state, 'NOT_RUN')
    eq('  空报告也一样', fromSecurityReport('').state, 'NOT_RUN')

    const rw = fromRealWorldReport('hurl：13/13 套件 passed')
    eq('RealWorld 全过 → PASS', rw.state, 'PASS')
    eq('  failed = 0', rw.failed, 0)
    eq('读不懂 → NOT_RUN', fromRealWorldReport('???').state, 'NOT_RUN')
  }

  console.log('\n=== ⑥ P16-07 性能：没阈值就是 WARN（不说它够快）===')
  {
    const noBudget = fromPerfReport('实测 2200 qps，零失败')
    eq('★ 有数据但无阈值 → WARN', noBudget.state, 'WARN')
    chk('  详情里写明"未设阈值"', /未设阈值/.test(noBudget.detail), noBudget.detail)
    eq('给了阈值且达标 → PASS', fromPerfReport('2200 qps', { budgetQps: 2000 }).state, 'PASS')
    eq('给了阈值但不达标 → FAIL', fromPerfReport('800 qps', { budgetQps: 2000 }).state, 'FAIL')
    eq('没数据 → NOT_RUN', fromPerfReport('no numbers here').state, 'NOT_RUN')
  }

  console.log('\n=== ⑦ P16-08 桌面验证 Adapter（解析本项目自己的输出）===')
  {
    const ok = fromDesktopVerify('  [PASS] a\n结果：31 通过 / 0 失败 / 共 31 项', { name: 'verify-agent-tools.js' })
    eq('全过 → PASS', ok.state, 'PASS')
    eq('  计数对', [ok.passed, ok.failed], [31, 0])
    chk('  名字带上了脚本名', /verify-agent-tools/.test(ok.name), ok.name)

    const bad = fromDesktopVerify('  [FAIL] x\n结果：30 通过 / 1 失败 / 共 31 项', { name: 'v.js' })
    eq('有失败 → FAIL', bad.state, 'FAIL')
    eq('  失败计数对', bad.failed, 1)

    eq('只有 [FAIL] 没结果行 → FAIL', fromDesktopVerify('  [FAIL] what', { name: 'v.js' }).state, 'FAIL')
    eq('SKIP 输出 → SKIP（与 NOT_RUN 分开）', fromDesktopVerify('[SKIP] 环境未就绪', { name: 'v.js' }).state, 'SKIP')
    eq('全 ✅ → PASS', fromDesktopVerify('✅ a\n✅ b', { name: 'v.js' }).state, 'PASS')
    eq('★ 空输出 → NOT_RUN', fromDesktopVerify('', { name: 'v.js' }).state, 'NOT_RUN')
  }

  console.log('\n=== ⑧ P16-09 Store：聚合 / 覆盖 / 失败项排序 ===')
  {
    const st = createQualityStore()
    eq('空 store 统计为 0', st.stats().total, 0)
    st.put(fromBuildResult({ ok: true }))
    st.put(fromTestResult({ ok: false, error: 'x', code: 1 }))
    st.put(fromSecurityReport('23/23 通过'))
    eq('三项都进来了', st.stats().total, 3)
    eq('分状态统计', [st.stats().byState.PASS, st.stats().byState.FAIL], [2, 1])

    // 同一个 id 再 put = 覆盖（重跑一遍是更新，不是追加）
    st.put(fromBuildResult({ ok: false, error: 'y' }))
    eq('同 id 覆盖，总数不变', st.stats().total, 3)

    const fails = st.failures()
    chk('失败项能列出来', fails.length >= 1, String(fails.length))
    chk('  按严重度排（FAIL 在前）', fails[0].state === 'FAIL', JSON.stringify(fails.map((f) => f.state)))
    chk('  非法结果不进去', st.put(createQualityResult({ name: '', state: 'PASS' })) === false)
  }

  console.log('\n=== ⑨ 总体状态与"能不能继续" ===')
  {
    eq('空 → NOT_RUN', overall([]), 'NOT_RUN')
    eq('全 PASS → PASS', overall([{ state: 'PASS' }, { state: 'PASS' }]), 'PASS')
    eq('PASS + SKIP → PASS（跳过不算失败）', overall([{ state: 'PASS' }, { state: 'SKIP' }]), 'PASS')
    eq('★ 有 FAIL → FAIL', overall([{ state: 'PASS' }, { state: 'FAIL' }]), 'FAIL')
    eq('★ WARN 优先于 PASS', overall([{ state: 'PASS' }, { state: 'WARN' }]), 'WARN')
    eq('全 SKIP → SKIP（不等于通过）', overall([{ state: 'SKIP' }, { state: 'SKIP' }]), 'SKIP')
    eq('混了 NOT_RUN → NOT_RUN', overall([{ state: 'PASS' }, { state: 'NOT_RUN' }]), 'NOT_RUN')

    // P16-14
    eq('★ 有失败 → 不让继续', canProceed([{ state: 'FAIL' }]).ok, false)
    chk('  并说明原因', /先把它们处理掉/.test(canProceed([{ state: 'FAIL' }]).reason))
    eq('★ 全跳过 → 不让继续（等于没验）', canProceed([{ state: 'SKIP' }]).ok, false)
    eq('★ 什么都没跑 → 不让继续', canProceed([]).ok, false)
    eq('WARN 允许继续（但要人看）', canProceed([{ state: 'PASS' }, { state: 'WARN' }]).ok, true)
    eq('全通过 → 允许继续', canProceed([{ state: 'PASS' }]).ok, true)

    // 用真实 store 走一遍
    const st = createQualityStore()
    st.put(fromBuildResult({ ok: true }))
    st.put(fromDesktopVerify('结果：31 通过 / 0 失败 / 共 31 项', { name: 'v' }))
    eq('真实 store：全过 → PASS 且可继续', [overall(st), canProceed(st).ok], ['PASS', true])
    st.put(fromTestResult({ ok: false, error: 'test 崩了', code: 1 }))
    eq('加一个失败后 → FAIL 且不可继续', [overall(st), canProceed(st).ok], ['FAIL', false])
  }

  console.log('\n=== ⑩ describeQuality 可读 ===')
  {
    const st = createQualityStore()
    st.put(fromBuildResult({ ok: true }))
    st.put(fromTestResult({ ok: false, error: 'x', code: 1 }))
    const line = describeQuality(st)
    chk('含总体状态', /工程状态：FAIL/.test(line), line)
    chk('含各项计数', /PASS 1/.test(line) && /FAIL 1/.test(line), line)
    chk('无换行', !/[\r\n]/.test(line))
    chk('空列表也不崩', /NOT_RUN/.test(describeQuality([])))
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
