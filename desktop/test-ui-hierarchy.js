// PH3-UI 的验证：三层分层 / 入口统计 / 三个状态徽标。
//
// 纯逻辑，可进 CI。
const { createHarness } = require('./verify-harness')
const {
  TIER, ENTRIES, tabsOf, byTier, layout, summarizeStructure,
  problemBadge, qualityBadge, backendBadge, workbenchPlacement,
} = require('./ui-hierarchy')

const H = createHarness()
const { chk, eq } = H

console.log('=== ① 边界：null / 空（按记忆，第一组就测它）===')
{
  eq('problemBadge(null) → null（不显示徽标）', problemBadge(null), null)
  eq('problemBadge(空) → null', problemBadge([]), null)
  chk('qualityBadge(null) 不炸且说未知', qualityBadge(null).level === 'unknown')
  chk('backendBadge(null) 不炸', typeof backendBadge(null).text === 'string')
  chk('layout() 不炸', Array.isArray(layout()))
  chk('summarizeStructure() 不炸', typeof summarizeStructure().tabCount === 'number')
  chk('workbenchPlacement() 不炸', typeof workbenchPlacement().weight === 'number')
  eq('tabsOf 只返回 isTab 的', tabsOf().every((e) => e.isTab), true)
  chk('ENTRIES 每个都有 tier 与 why', ENTRIES.every((e) => e.tier && e.why && e.label))
}

console.log('\n=== ② PH3-UI-02/03 结构统计：一级核心是哪五条 ===')
{
  const s = summarizeStructure()
  eq('★ 一级标签 5 个', s.tabCount, 5)
  eq('  分别是 home/project/ai/agent/tools', s.tabs.slice().sort(), ['agent', 'ai', 'home', 'project', 'tools'])
  // 清单点名的五条核心用户路径
  eq('★★ 核心恰是 清单点名的五条（Open Project/Work/Ask Agent/Run/Test）',
    s.coreIds.slice().sort(), ['ai', 'home', 'project', 'run', 'test'])
  chk('  且 Run/Test **不占一级标签**（它们挂在项目页的动作里）',
    !s.tabs.includes('run') && !s.tabs.includes('test'), JSON.stringify(s.tabs))
  chk('说明里写清了这一点', /Run 与 Test/.test(s.note), s.note)
  eq('辅助 4 个（后端/数据库/工程状态/工作台）', s.supportCount, 4)
  eq('工具 2 个（中转站/工具）', s.toolCount, 2)
}

console.log('\n=== ③ PH3-UI-05 三层显示：核心不抢视觉 ===')
{
  const L = layout()
  eq('三层', L.length, 3)
  eq('顺序是 核心 → 辅助 → 工具', L.map((x) => x.tier), ['core', 'support', 'tool'])
  eq('★ 权重递增（0 最显眼）', L.map((x) => x.weight), [0, 1, 2])
  chk('每层都有条目', L.every((x) => x.entries.length > 0), JSON.stringify(L.map((x) => x.entries.length)))
  chk('核心层里没有"工具"类的东西', L[0].entries.every((e) => e.tier === TIER.CORE))
  chk('辅助层恰好是那 4 个', L[1].entries.map((e) => e.id).sort().join(',') === 'backend,database,quality,workbench', JSON.stringify(L[1].entries.map((e) => e.id)))
}

console.log('\n=== ④ PH3-UI-08 Problem 徽标：没问题就**不显示** ===')
{
  eq('★ 没有问题 → 不显示（不是显示 0）', problemBadge([]), null)
  eq('  传 null 也不显示', problemBadge(null), null)

  const b1 = problemBadge([{ severity: 'error' }, { severity: 'warning' }])
  eq('计数对', b1.count, 2)
  eq('  分了错误与警告', b1.errors + '/' + b1.warns, '1/1')
  eq('★ 有 error → level=error（红）', b1.level, 'error')
  chk('  title 说明构成', /错误 1 \/ 警告 1/.test(b1.title), b1.title)

  const b2 = problemBadge([{ severity: 'warning' }, { severity: 'warning' }])
  eq('★ 只有警告 → level=warn（不该用同一个红点）', b2.level, 'warn')
  eq('  errors 为 0', b2.errors, 0)

  const b3 = problemBadge([{ severity: 'info' }])
  eq('只有 info → info', b3.level, 'info')
  chk('其它类也计入', b3.other === 1, JSON.stringify(b3))
  eq('过滤掉数组里的空值', problemBadge([null, undefined, { severity: 'error' }]).count, 1)
}

console.log('\n=== ⑤ PH3-UI-09 Quality 摘要：没跑过 ≠ 失败 ===')
{
  eq('PASS → ok', qualityBadge({ overall: 'PASS' }).level, 'ok')
  eq('★ FAIL → error', qualityBadge({ overall: 'FAIL' }).level, 'error')
  eq('★ STALE → warn（过期有自己的一档）', qualityBadge({ overall: 'STALE' }).level, 'warn')
  eq('★ NOT_RUN → info（**不是 error**）', qualityBadge({ overall: 'NOT_RUN' }).level, 'info')
  chk('  文本如实写"未运行"', /未运行/.test(qualityBadge({ overall: 'NOT_RUN' }).text), qualityBadge({ overall: 'NOT_RUN' }).text)
  eq('没数据 → unknown', qualityBadge({}).level, 'unknown')

  const withStale = qualityBadge({ overall: 'PASS', staleCount: 2, canProceed: { ok: false, reason: '2 项已过期' } })
  chk('★ 有过期项时 title 里说出来', /2 项已过期/.test(withStale.title), withStale.title)
  chk('  且带 canProceed 的说明', /已过期/.test(withStale.title), withStale.title)
}

console.log('\n=== ⑥ PH3-UI-10 Backend 摘要：DEGRADED 有自己的说法 ===')
{
  eq('健康 → RUNNING/ok', backendBadge({ ok: true, port: 8080 }).text, '运行中')
  eq('  等级 ok', backendBadge({ ok: true }).level, 'ok')
  eq('★ 探测了但不健康 → 不健康（**不混进 RUNNING 也不混进 FAILED**）', backendBadge({ ok: false, url: 'http://x/health' }).text, '不健康')
  eq('  等级 warn', backendBadge({ ok: false, url: 'http://x' }).level, 'warn')
  eq('★ 没探测过 → 未启动（不是"失败"）', backendBadge({ ok: false, probed: false }).text, '未启动')
  eq('显式状态优先', backendBadge({ ok: true }, 'FAILED').text, '失败')
  chk('title 带端口', /8080/.test(backendBadge({ ok: true, port: 8080 }).title), backendBadge({ ok: true, port: 8080 }).title)
  chk('有错误时带出来', /连不上/.test(backendBadge({ ok: false, url: 'u', error: '连不上' }).title))
}

console.log('\n=== ⑦ PH3-UI-11 工作台不抢主视觉 ===')
{
  const w = workbenchPlacement()
  eq('★ 工作台不是核心层', w.tier === TIER.CORE, false)
  chk('  权重 >= 1（比核心低）', w.weight >= 1, String(w.weight))
  chk('  且说明理由', /辅助面板/.test(w.reason), w.reason)
  chk('★ 它也确实不在一级标签里', !tabsOf().some((e) => e.id === 'workbench'))
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
