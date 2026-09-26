// PH3-ENV + PH3-REC 的验证：环境四态 / PATH 补全 / 恢复范围 / 异常退出降级。
//
// 纯逻辑，可进 CI。
const { createHarness } = require('./verify-harness')
const {
  ENV_STATE, ALL_ENV, PATH_CANDIDATES,
  classifyEnv, describeEnv, pathFixups,
  captureScene, planStartup, markRunning, markCleanExit, simulateKill,
} = require('./env-recovery')

const H = createHarness()
const { chk, eq } = H

console.log('=== ① 边界：null / 空（按记忆，第一组就测它）===')
{
  eq('classifyEnv(null) → UNKNOWN（不是 ERROR）', classifyEnv(null).state, 'UNKNOWN')
  chk('describeEnv(null) 不炸', describeEnv(null).rows.length === 0)
  eq('pathFixups(null) → 空', pathFixups(null).length, 0)
  chk('captureScene(null) 不炸', captureScene(null).tabs.length === 0)
  const p = planStartup(null)
  eq('planStartup(null) → 不 restore', p.restore, false)
  eq('  原因如实是 first-run', p.reason, 'first-run')
  chk('markRunning(null) 不炸', markRunning(null).running === true)
  chk('markCleanExit(null) 不炸', markCleanExit(null).cleanExit === true)
  chk('simulateKill(null) 不炸', simulateKill(null).killed === true)
  eq('ALL_ENV 四态', ALL_ENV.length, 4)
  eq('planStartup(空 {}) → first-run', planStartup({}).reason, 'first-run')
}

console.log('\n=== ② ★ PH3-ENV-03 别把 MISSING 当 ERROR ===')
{
  eq('没探测 → UNKNOWN', classifyEnv({}).state, 'UNKNOWN')
  eq('探测了、找不到 → MISSING', classifyEnv({ attempted: true, found: false, output: 'command not found' }).state, 'MISSING')
  chk('  且原因说"没安装"', /没安装/.test(classifyEnv({ attempted: true, found: false, output: 'x not found' }).reason))
  eq('★ 装了但跑不起来 → BROKEN', classifyEnv({ attempted: true, found: true, ok: false, error: '版本不兼容' }).state, 'BROKEN')
  chk('  原因带出真实输出', /版本不兼容/.test(classifyEnv({ attempted: true, found: true, ok: false, error: '版本不兼容' }).reason))
  const ok = classifyEnv({ attempted: true, found: true, ok: true, version: '0.1.20260915' })
  eq('装了能用 → AVAILABLE', ok.state, 'AVAILABLE')
  eq('  带版本号', ok.version, '0.1.20260915')
  eq('探测结果说不清 → UNKNOWN', classifyEnv({ attempted: true, found: true }).state, 'UNKNOWN')

  // ★ 分级：只有 BROKEN 才算"需要修的环境故障"
  const d = describeEnv([
    { id: 'moon', name: 'MoonBit', probe: { attempted: true, found: true, ok: true, version: 'x' } },
    { id: 'docker', name: 'Docker', probe: { attempted: true, found: false, output: 'command not found' } },
    { id: 'opencode', name: 'opencode', probe: { attempted: true, found: true, ok: false, error: 'boom' } },
  ])
  eq('★ 只有 BROKEN 进 blocking', d.blocking.length, 1)
  eq('  ★ MISSING 归 optional（按需安装，不是故障）', d.optional.length, 1)
  chk('  摘要如实说"没有环境故障"还是"有异常"', /环境异常/.test(d.summary), d.summary)
  chk('  每行有人话标签', d.rows.every((r) => r.label && r.label !== r.state), JSON.stringify(d.rows.map((r) => r.label)))

  const allMissing = describeEnv([{ id: 'docker', name: 'Docker', probe: { attempted: true, found: false, output: 'not found' } }])
  chk('★ 全 MISSING 时摘要**不**说"故障"', /没有环境故障/.test(allMissing.summary), allMissing.summary)
}

console.log('\n=== ③ PH3-ENV-04 PATH 补全（项目真踩过：快捷方式里 PATH 错）===')
{
  const rows = [
    { id: 'moon', name: 'MoonBit', state: ENV_STATE.MISSING },
    { id: 'node', name: 'Node', state: ENV_STATE.AVAILABLE },
    { id: 'docker', name: 'Docker', state: ENV_STATE.MISSING },
    { id: 'weird', name: '未知工具', state: ENV_STATE.MISSING },
  ]
  const f = pathFixups(rows)
  eq('★ 只对 MISSING 的给建议（可用的不用管）', f.length, 2)
  chk('  moon 的候选里含 ~/.moon/bin', f.find((x) => x.id === 'moon').candidates.some((c) => /\.moon/.test(c)), JSON.stringify(f.find((x) => x.id === 'moon')))
  chk('  没有已知候选的工具不给瞎建议', !f.some((x) => x.id === 'weird'))
  chk('★ 提醒先确认目录真的存在', /先确认/.test(f[0].note), f[0].note)
  chk('BROKEN 的**不**给 PATH 建议（装是装了）', pathFixups([{ id: 'node', state: ENV_STATE.BROKEN }]).length === 0)
  // ⚠️ 接线时才发现：两个来源的字段名不一样 —— classifyEnv 用 state，
  //    而 checkEnvironment（环境面板真正喂进来的那个）用 found:boolean。
  //    只认 state 的话，界面上**永远看不到建议**。这里把两种都锁住。
  eq('★ 认 checkEnvironment 的形状（found:false 就是 MISSING）',
    pathFixups([{ id: 'moon', name: 'MoonBit', found: false }]).length, 1)
  chk('  且真的给出候选目录',
    pathFixups([{ id: 'moon', name: 'MoonBit', found: false }])[0].candidates.some((c) => /\.moon/.test(c)))
  eq('★ 装了的不给建议（found:true）', pathFixups([{ id: 'moon', name: 'MoonBit', found: true }]).length, 0)
  eq('★ 探测出错的不给 PATH 建议（与「没装」不是一回事）',
    pathFixups([{ id: 'moon', name: 'MoonBit', found: false, error: '探测超时' }]).length, 0)
  chk('候选表覆盖清单点名的五样', ['moon', 'node', 'git', 'docker', 'opencode'].every((k) => Array.isArray(PATH_CANDIDATES[k])))
}

console.log('\n=== ④ PH3-REC-02/03/04/05 现场包含什么 ===')
{
  const sc = captureScene({
    projectRoot: 'C:/proj',
    tabs: [{ path: 'a.mbt', scrollTop: 120, cursorLine: 8 }, { path: 'b.mbt' }, { nope: 1 }],
    activeFile: 'a.mbt', sessionId: 'sess-1', at: 1000,
  })
  eq('项目', sc.projectRoot, 'C:/proj')
  eq('★ 标签只收有路径的（坏数据丢掉）', sc.tabs.length, 2)
  eq('★ 滚动位置也记下来（REC-04）', sc.tabs[0].scrollTop, 120)
  eq('  光标行也记', sc.tabs[0].cursorLine, 8)
  eq('取不到的滚动位置是 null（不是 0）', sc.tabs[1].scrollTop, null)
  eq('当前文件', sc.activeFile, 'a.mbt')
  eq('★ Agent Session 也在现场里（REC-05）', sc.sessionId, 'sess-1')
  eq('记录时间', sc.capturedAt, 1000)
}

console.log('\n=== ⑤ ★★ PH3-REC-06/07/08/09 异常退出**不搬现场** ===')
{
  const scene = captureScene({
    projectRoot: 'C:/proj',
    tabs: [{ path: 'a.mbt', scrollTop: 120 }, { path: 'b.mbt' }],
    activeFile: 'a.mbt', sessionId: 'sess-1', at: 1000,
  })

  // 正常退出 → 恢复完整现场
  let snap = markRunning({ projectRoot: 'C:/proj', scene }, 100)
  snap = markCleanExit(snap, 200)
  const clean = planStartup(snap)
  eq('★ 正常退出 → 恢复现场', clean.reason, 'clean')
  eq('  标签恢复', clean.tabs.length, 2)
  eq('  当前文件恢复', clean.activeFile, 'a.mbt')
  eq('  ★ 滚动位置也恢复', clean.scroll.scrollTop, 120)
  eq('  ★ Session 也恢复', clean.sessionId, 'sess-1')
  eq('  没标成崩溃', clean.crashed, false)

  // ★ 强杀 → 只恢复项目，**不搬现场**
  const killed = simulateKill({ projectRoot: 'C:/proj', scene }, 300)
  const rec = planStartup(killed)
  eq('★ 判定为异常退出降级', rec.reason, 'crash-degraded')
  eq('★ 项目仍然恢复', rec.projectRoot, 'C:/proj')
  eq('★★ 标签**一个都不恢复**', rec.tabs.length, 0)
  eq('★★ 当前文件不恢复', rec.activeFile, null)
  eq('★★ 滚动位置不恢复', rec.scroll, null)
  eq('★★ Session 不恢复（属于现场）', rec.sessionId, null)
  eq('  标成 crashed', rec.crashed, true)
  chk('  ★ 且**明确告诉用户为什么**（不悄悄少恢复几样）', /不恢复编辑现场/.test(rec.message), rec.message)
  chk('  说明是为了避免把崩溃原因带回来', /崩溃原因/.test(rec.message), rec.message)

  // 被强杀的快照本身长什么样
  chk('强杀快照里 cleanExit 仍是 false（这就是判据）', killed.cleanExit === false && killed.killed === true)

  // 崩过之后用户正常退出一次 → 下次应当恢复现场
  const afterCrash = markCleanExit(simulateKill({ projectRoot: 'C:/proj', scene }, 300), 400)
  eq('★ 崩溃后正常退出一次，下次恢复现场', planStartup(afterCrash).reason, 'clean')

  // maxTabs 生效
  chk('maxTabs 生效', planStartup(markCleanExit(markRunning({ scene: { projectRoot: 'p', tabs: Array.from({ length: 30 }, (_, i) => ({ path: 'f' + i })) } }, 1), 2), { maxTabs: 3 }).tabs.length === 3)

  // 只有项目、没有现场时，崩了也照样恢复项目
  const onlyProj = planStartup({ projectRoot: 'C:/proj', cleanExit: false })
  eq('没有现场也能恢复项目', onlyProj.projectRoot, 'C:/proj')
  eq('  但 tabs 仍为空', onlyProj.tabs.length, 0)
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
