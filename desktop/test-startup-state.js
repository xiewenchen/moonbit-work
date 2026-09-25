'use strict'

/**
 * 启动恢复 / 异常退出 / 环境检查单测（Phase 2.1 / P20-07、P20-08、P20-09）
 *
 * 纯 Node。断言用公共 verify-harness。
 * 三处重点：**异常退出要降级**、环境检查**不假装**、探测报错 ≠ 没装。
 */

const { createHarness } = require('./verify-harness')
const {
  STARTUP_LIMITS,
  ENV_CHECKS,
  createSnapshot,
  sanitizeSnapshot,
  markRunning,
  markCleanExit,
  updateSnapshot,
  planStartup,
  checkEnvironment,
  describeStartup,
} = require('./startup-state')

const H = createHarness()
const { chk, eq } = H

const A = 'C:/work/proj-a'

async function main() {
  console.log('\n=== ① P20-07 快照：只记"位置"，不记"内容" ===')
  {
    const s0 = createSnapshot({ projectRoot: A, projectType: 'moonbit', activeFile: 'src/main.mbt', tabs: ['src/main.mbt', 'README.md'] })
    chk('对象被冻结（不会被下游改坏）', Object.isFrozen(s0))
    eq('记下了项目', [s0.projectRoot, s0.projectType], [A, 'moonbit'])
    eq('记下了标签与当前文件', [s0.tabs.length, s0.activeFile], [2, 'src/main.mbt'])
    chk('★ 没有记文件内容（快照里不该有正文）', !JSON.stringify(s0).includes('fn main'), JSON.stringify(s0))

    const s1 = updateSnapshot(s0, { activeFile: 'README.md' }, { now: 100 })
    eq('可以只更新位置', s1.activeFile, 'README.md')
    eq('  项目不变', s1.projectRoot, A)
    eq('  时间戳更新', s1.at, 100)

    // 标签上限 + 过滤空值
    const many = createSnapshot({ tabs: Array.from({ length: 30 }, (_, i) => 'f' + i).concat(['', '  ']) })
    eq('标签数封顶', many.tabs.length, STARTUP_LIMITS.maxTabs)
    chk('空标签被过滤', many.tabs.every((t) => t.length > 0))
    eq('空输入也给合法快照', createSnapshot({}).projectRoot, null)
  }

  console.log('\n=== ② ★ P20-08 异常退出要降级（这是这段唯一重要的地方）===')
  {
    let s0 = createSnapshot({ projectRoot: A, tabs: ['a.mbt', 'b.mbt', 'c.mbt'], activeFile: 'b.mbt' })
    // 正常路径：启动标记 running → 退出清掉
    s0 = markRunning(s0, { now: 10 })
    eq('运行中是 running=true', [s0.running, s0.cleanExit], [true, false])
    const clean = markCleanExit(s0, { now: 20 })
    eq('正常退出后 running=false', [clean.running, clean.cleanExit], [false, true])

    const pClean = planStartup(clean)
    eq('正常退出 → 完整恢复', [pClean.restore, pClean.reason], [true, 'clean-exit'])
    eq('  ★ 标签全部恢复', pClean.tabs.length, 3)
    eq('  ★ 当前文件也恢复', pClean.activeFile, 'b.mbt')
    chk('  消息里说明了恢复了几个标签', /3 个标签/.test(pClean.message), pClean.message)

    // 异常路径：running 还是 true（说明上次没走正常退出）
    const pCrash = planStartup(s0)
    eq('★ 异常退出被识别', [pCrash.restore, pCrash.reason, pCrash.crashed], [true, 'after-crash', true])
    eq('★★ 只恢复项目', pCrash.projectRoot, A)
    eq('★★ 标签**不**恢复（返回空）', pCrash.tabs.length, 0)
    eq('★★ 当前文件也**不**恢复', pCrash.activeFile, null)
    chk('  并明确说明了为什么', /没有正常退出/.test(pCrash.message), pCrash.message)

    // 全新启动
    const pNew = planStartup(createSnapshot({}))
    eq('没有项目 → 不恢复', [pNew.restore, pNew.reason], [false, 'first-run'])

    // running 标记不会被 updateSnapshot 误改
    const upd = updateSnapshot(s0, { activeFile: 'c.mbt' })
    eq('★ 更新位置不会清掉 running 标记', upd.running, true)
  }

  console.log('\n=== ③ P20-09 环境检查：只报事实，缺了给可执行建议 ===')
  {
    const allOk = await checkEnvironment(async () => ({ found: true, version: '1.2.3' }))
    eq('全在 → ok=true', allOk.ok, true)
    eq('  检查项数正确', allOk.items.length, ENV_CHECKS.length)
    chk('  每一项都带 version', allOk.items.every((x) => x.version === '1.2.3'))
    chk('  通过时不给 hint', allOk.items.every((x) => x.hint === null))
    chk('  摘要可读', /环境检查通过/.test(allOk.summary), allOk.summary)

    const some = await checkEnvironment(async (id) => ({ found: id !== 'docker' && id !== 'agent' }))
    eq('缺两项 → ok=false', some.ok, false)
    eq('  missingCount 对', some.missingCount, 2)
    chk('★ 缺的项给出**可执行**建议（不是一句"环境异常"）', /装 Docker Desktop/.test(String(some.items.find((x) => x.id === 'docker').hint)), String(some.items.find((x) => x.id === 'docker').hint))
    chk('★ 摘要点名了缺哪些', /Docker/.test(some.summary) && /Agent/.test(some.summary), some.summary)

    // ★ 探测报错 ≠ 没装
    const errored = await checkEnvironment(async (id) => {
      if (id === 'git') throw new Error('探测超时')
      return { found: true }
    })
    chk('★ 探测抛错时 error 被记下来', !!errored.items.find((x) => x.id === 'git').error, JSON.stringify(errored.items.find((x) => x.id === 'git')))
    eq('  errorCount 对', errored.errorCount, 1)
    chk('★ 摘要里把"没装"和"探测报错"分开说', /探测时报了错/.test(errored.summary), errored.summary)
    chk('  并且不把它算成"环境齐"', errored.ok === false)

    // 探测能力没注入就明确抛
    let threw = false
    try { await checkEnvironment(null) } catch (e) { threw = true }
    chk('没注入 probe → 明确抛（而不是静默返回"全好"）', threw)
  }

  console.log('\n=== ④ 边界与一行摘要 ===')
  {
    for (const bad of [null, undefined, 'x', 42, {}, { tabs: 'no' }]) {
      const s = sanitizeSnapshot(bad)
      chk('sanitizeSnapshot 不抛且合法：' + String(JSON.stringify(bad)).slice(0, 16), s && Array.isArray(s.tabs))
    }
    const line = describeStartup(planStartup(markCleanExit(createSnapshot({ projectRoot: A }))), { ok: false, missingCount: 2 })
    chk('摘要含启动原因', /启动：clean-exit/.test(line), line)
    chk('摘要含环境缺项数', /缺 2/.test(line), line)
    chk('无换行', !/[\r\n]/.test(line))
    chk('null 也不崩', typeof describeStartup(null, null) === 'string')
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e))
  process.exit(1)
})
