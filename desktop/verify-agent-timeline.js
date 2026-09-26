// PH3-IDE-09/10 端到端：Agent 任务时间线 + 状态栏。
//
// 纯渲染层（不依赖真实模型）—— 但走的是**真实的 window.moonbitIDE.taskUI**，
// 不是测试里另造一个假对象。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const OUT = path.join(__dirname, 'agent-timeline-result.txt')
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

  log('\n=== ① PH3-IDE-09：时间线真的被建出来 ===')
  {
    chk('taskUI 暴露出来了', await js(`typeof window.moonbitIDE.taskUI === 'object'`), true)
    const r = await J(`window.moonbitIDE.taskUI.begin('修复登录接口')`)
    eq('begin 成功', r.ok, true)
    await sleep(400)
    chk('★ 页面上出现了时间线容器', await js(`!!document.getElementById('agentTimeline')`), true)
    const head = await js(`(document.getElementById('agentTimelineHead') || {}).textContent || ''`)
    chk('  标题带上了目标', /修复登录接口/.test(String(head)), String(head).slice(0, 60))
  }

  log('\n=== ② PH3-IDE-10：状态栏跟着走 ===')
  {
    const st = await js(`(document.getElementById('stMsg') || {}).textContent || ''`)
    chk('★ 状态栏显示"Agent: 理解中"', /Agent: 理解中/.test(String(st)), String(st))
  }

  log('\n=== ③ 逐步记录（清单里的七步）===')
  {
    const steps = [
      ['Understanding · 理解任务', true],
      ['Read · 读取相关文件', true],
      ['Patch · 生成补丁', true],
      ['Check · 编译检查', true],
      ['Test · 运行测试', false, '2 个用例失败'],
      ['Run · 启动服务', null],
      ['Health · 健康检查', null],
    ]
    for (const [name, ok, detail] of steps) {
      await js(`window.moonbitIDE.taskUI.step(${JSON.stringify(name)}, ${ok === null ? 'null' : ok}, ${JSON.stringify(detail || null)})`)
    }
    await sleep(400)
    const snap = await J(`window.moonbitIDE.taskUI.snapshot()`)
    eq('★ 七步都记下了', snap.count, 7)
    eq('  成功步骤标 ok', snap.steps[1].ok, true)
    eq('★ 失败步骤标 false（不美化）', snap.steps[4].ok, false)
    chk('  失败原因保留', /2 个用例失败/.test(String(snap.steps[4].detail)), String(snap.steps[4].detail))
    eq('进行中的标 null', snap.steps[5].ok, null)

    const rows = await js(`document.querySelectorAll('#agentTimeline .agent-tl-step').length`)
    eq('★ 页面上真的有 7 行（不是只在内存里）', rows, 7)
    const failed = await js(`(() => { const xs = Array.from(document.querySelectorAll('#agentTimeline .agent-tl-step')); const f = xs.find((x) => x.textContent.indexOf('✗') === 0); return f ? f.textContent : '' })()`)
    chk('  失败那行显示成 ✗ 开头', String(failed).indexOf('✗') === 0, String(failed).slice(0, 60))
  }

  log('\n=== ④ 收尾必须如实（失败就是失败）===')
  {
    const f1 = await J(`window.moonbitIDE.taskUI.finish(false, '测试没过，已停下')`)
    eq('finish(false) 返回 ok=false', f1.ok, false)
    await sleep(300)
    const st = await js(`(document.getElementById('stMsg') || {}).textContent || ''`)
    chk('★ 状态栏显示"Agent: 失败"（不是"已完成"）', /Agent: 失败/.test(String(st)), String(st))
    chk('  失败原因写进了时间线', /测试没过，已停下/.test(await js(`(document.getElementById('agentTimeline') || {}).textContent || ''`)), true)

    const f2 = await J(`window.moonbitIDE.taskUI.finish(true, null)`)
    eq('finish(true) 返回 ok=true', f2.ok, true)
    chk('  状态栏变成"Agent: 已完成"', /Agent: 已完成/.test(await js(`(document.getElementById('stMsg') || {}).textContent || ''`)))
    eq('  且快照里 active=false', (await J(`window.moonbitIDE.taskUI.snapshot()`)).active, false)
  }

  log('\n=== ⑤ 接到已有的 verify 进度通道（不新开一条）===')
  {
    await js(`window.moonbitIDE.taskUI.begin('跑一遍验证')`)
    const before = (await J(`window.moonbitIDE.taskUI.snapshot()`)).count
    await js(`window.moonbitIDE.taskUI.fromVerifyProgress({ step: 'check', ok: true })`)
    await js(`window.moonbitIDE.taskUI.fromVerifyProgress({ step: 'test', ok: false, reason: '断言失败' })`)
    const snap = await J(`window.moonbitIDE.taskUI.snapshot()`)
    eq('★ 两条进度变成了两步', snap.count, before + 2)
    chk('  失败原因（reason）带进来了', /断言失败/.test(String(snap.steps[snap.count - 1].detail)), String(snap.steps[snap.count - 1].detail))
  }

  log('\n=== ⑥ 后台运行：切标签不影响任务状态（PH3-IDE-11 的基础）===')
  {
    // 切到别的标签，时间线数据仍在
    await js(`(() => { const a = document.querySelector('a[data-view="project"]'); if (a) a.click() })()`)
    await sleep(700)
    const snap = await J(`window.moonbitIDE.taskUI.snapshot()`)
    chk('★ 切标签后任务快照还在（没被清掉）', snap.count >= 2, String(snap.count))
    chk('  active 状态保留', typeof snap.active === 'boolean')
  }

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
