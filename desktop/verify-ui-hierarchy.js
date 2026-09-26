// PH3-UI 端到端：三层分层 + 状态栏徽标（真 DOM）。
//
// ⚠️ 会往 Problem Store 里加几条测试用问题（**结束时清掉**），因为要验证"有问题就显示"。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const OUT = path.join(__dirname, 'ui-hierarchy-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

function dump(code) {
  try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (e) {
    console.log('（结果文件写入失败，忽略：' + String((e && e.message) || e) + '）')
  }
  setTimeout(() => app.exit(code), 500)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  const J = async (expr) => JSON.parse(await js(`(() => { try { return JSON.stringify(${expr}) } catch (e) { return JSON.stringify({ __throw: String((e && e.message) || e) }) } })()`))
  await sleep(3000)

  log('\n=== ① ui-hierarchy.js 真的被注入了 ===')
  {
    chk('★ window.moonbitUiHierarchy 存在', await js(`typeof window.moonbitUiHierarchy === 'object' && window.moonbitUiHierarchy !== null`), true)
    eq('  暴露了三层定义', await js(`typeof window.moonbitUiHierarchy.TIER`), 'object')
    chk('★ 没污染全局（顶层 const 不该冒出来）', await js(`typeof window.ENTRIES === 'undefined' && typeof window.TIER === 'undefined'`), true)
    const api = await J(`(() => { const u = window.moonbitIDE.ui; return { has: !!u, t: u.tiers() } })()`)
    chk('★ window.moonbitIDE.ui 入口在', api.has === true, JSON.stringify(api))
    eq('  三层名对（键是大写 CORE/SUPPORT/TOOL）', JSON.stringify([api.t.CORE, api.t.SUPPORT, api.t.TOOL]), '["core","support","tool"]')
  }

  log('\n=== ② PH3-UI-02/05 结构与分层（渲染侧算出的一致）===')
  {
    const s = await J(`window.moonbitIDE.ui.structure()`)
    eq('★ 一级标签 5 个', s.tabCount, 5)
    chk('★ 核心是清单点名的五条', JSON.stringify(s.coreIds.slice().sort()) === JSON.stringify(['ai', 'home', 'project', 'run', 'test']), JSON.stringify(s.coreIds))
    const L = await J(`window.moonbitIDE.ui.layout()`)
    eq('三层顺序 核心→辅助→工具', L.map((x) => x.tier), ['core', 'support', 'tool'])
    eq('★ 权重递增 0/1/2', L.map((x) => x.weight), [0, 1, 2])
    chk('★ 工作台不在核心层', L[0].entries.every((e) => e.id !== 'workbench'))
    const wb = await J(`window.moonbitIDE.ui.workbenchPlacement()`)
    chk('  且给出不抢视觉的理由', /辅助面板/.test(wb.reason), wb.reason)
  }

  log('\n=== ③ PH3-UI-08 徽标：没问题就**不显示** ===')
  {
    // ⚠️ problems 没有 clear()，所以先**读一次真实条数**再断言（不靠能清空）
    const before = await J(`window.moonbitIDE.problems.list()`)
    const rb = await J(`window.moonbitIDE.ui.refreshBadges()`)
    chk('刷新成功', rb.ok === true, JSON.stringify(rb))
    await sleep(200)
    const badgeCount0 = await js(`document.querySelectorAll('#statusBadges .status-badge-problems').length`)
    // 本来就有问题 → 有徽标；本来没有 → 不该有徽标（**不是显示 0**）
    if (before.length === 0) {
      eq('★ 没有问题 → problemBadge 是 null', rb.problems, null)
      eq('★ DOM 里也**没有**问题徽标（不是显示 0）', badgeCount0, 0)
    } else {
      chk('★ 本来就有问题 → 计数对得上', rb.problems && rb.problems.count === before.length, JSON.stringify(rb.problems))
      eq('  且 DOM 里有徽标', badgeCount0, 1)
    }
    chk('  容器本身在（便于后续追加）', await js(`!!document.getElementById('statusBadges')`), true)
  }

  log('\n=== ④ 有问题 → 显示，且严重度决定样式 ===')
  {
    await js(`(() => {
      const P = window.MoonbitProblems
      window.moonbitIDE.problems.add([
        { source: P.PROBLEM_SOURCE.COMPILER, severity: 'error', message: 'PH3-UI 探针错误', file: 'a.mbt', line: 1 },
        { source: P.PROBLEM_SOURCE.COMPILER, severity: 'warning', message: 'PH3-UI 探针警告', file: 'b.mbt', line: 2 },
      ])
      return true
    })()`)
    await sleep(300)
    const r = await J(`window.moonbitIDE.ui.refreshBadges()`)
    chk('★ 有问题时给出徽标', !!r.problems, JSON.stringify(r.problems))
    eq('  计数 2', r.problems.count, 2)
    eq('★ 有 error → level=error（红）', r.problems.level, 'error')
    const dom = await js(`(() => { const e = document.querySelector('#statusBadges .status-badge-problems'); return e ? e.textContent + '|' + e.title : '' })()`)
    chk('★ DOM 里真的出现了问题徽标', /问题 2/.test(String(dom)), String(dom).slice(0, 80))
    chk('  且 title 说明构成', /错误 1 \/ 警告 1/.test(String(dom)), String(dom).slice(0, 140))
    const styled = await js(`(() => { const e = document.querySelector('#statusBadges .status-badge-error'); return !!e })()`)
    chk('★ 用了 error 档样式（颜色分级真的生效）', styled === true)

    // 只留警告 → 不该还是 error
    const warnOnly = await J(`window.moonbitIDE.ui.problemBadge([{ severity: 'warning' }, { severity: 'warning' }])`)
    eq('★ 只有警告 → level=warn（不混用同一个红点）', warnOnly.level, 'warn')
    eq('  且 errors 为 0', warnOnly.errors, 0)
  }

  log('\n=== ⑤ PH3-UI-09 Quality 摘要（用事实层的数据）===')
  {
    const q = await J(`(() => { const b = window.moonbitIDE.ui.qualityBadge({ overall: 'PASS' }); return { l: b.level, t: b.text } })()`)
    eq('PASS → ok', q.l, 'ok')
    const n = await J(`(() => { const b = window.moonbitIDE.ui.qualityBadge({ overall: 'NOT_RUN' }); return { l: b.level, t: b.text } })()`)
    eq('★ NOT_RUN → info（不是 error）', n.l, 'info')
    chk('  文本是"未运行"', /未运行/.test(n.t), n.t)
    // 真拉一次（会用上刚接的 fact）
    const real = await J(`window.moonbitIDE.ui.refreshBadges()`)
    chk('刷新不炸', real.ok !== false, JSON.stringify(real).slice(0, 80))
  }

  log('\n=== ⑥ PH3-UI-10 Backend 摘要：DEGRADED 有自己的说法 ===')
  {
    const okB = await J(`(() => { const b = window.moonbitIDE.ui.backendBadge({ ok: true, port: 8080 }); return { t: b.text, l: b.level } })()`)
    eq('健康 → 运行中', okB.t, '运行中')
    eq('  等级 ok', okB.l, 'ok')
    const degB = await J(`(() => { const b = window.moonbitIDE.ui.backendBadge({ ok: false, url: 'http://x' }); return { t: b.text, l: b.level } })()`)
    eq('★ 探测了但不健康 → 不健康', degB.t, '不健康')
    chk('  等级 warn（不混进 FAILED）', String(degB.l) === 'warn', String(degB.l))
    const nb = await J(`(() => { const b = window.moonbitIDE.ui.backendBadge({ ok: false, probed: false }); return b.text })()`)
    eq('★ 没探测 → 未启动（不是失败）', nb, '未启动')
  }

  // ⚠️ 探针问题无法清空（Store 没有 clear），但它们在**内存**里，不影响落盘与别的验证。

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
