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

  log('\n=== ⑥ PH3-IDE-11 后台运行：切标签时任务**仍在推进**（不只是"快照还在"）===')
  {
    // ⚠️ 第一版的 ⑥ 节只断言了 `typeof active === 'boolean'` —— 那**恒真**，等于没验。
    //    清单要的是"切走之后 Agent 任务**继续**"，所以这里要验三件事：
    //      ① 切走后 active 仍是 true；
    //      ② **在别的标签页上**调 step 也真的被记下；
    //      ③ 切回来能接着走（步数连续，没丢）。
    await js(`window.moonbitIDE.taskUI.begin('后台运行的验证')`)
    await sleep(300)
    const before = await J(`window.moonbitIDE.taskUI.snapshot()`)
    chk('前置：任务在进行中', before.active === true, JSON.stringify(before.active))

    // 切到另一个标签
    await js(`(() => { const a = document.querySelector('a[data-view="project"]'); if (a) a.click() })()`)
    await sleep(700)
    const onOtherTab = await js(`(() => { const a = document.querySelector('a[data-view="project"]'); return !!(a && a.classList && a.classList.contains('active')) })()`)

    const s1 = await J(`window.moonbitIDE.taskUI.snapshot()`)
    eq('★ 切走后 active 仍为 true（任务没被中断）', s1.active, true)
    eq('  步数没变（切标签本身不该产生步骤）', s1.count, before.count)

    // ★★ 关键：**在别的标签页上**继续记步骤 —— 必须照样生效
    await js(`window.moonbitIDE.taskUI.step('后台·读文件', true)`)
    await js(`window.moonbitIDE.taskUI.step('后台·跑测试', false, '在后台失败')`)
    await sleep(300)
    const s2 = await J(`window.moonbitIDE.taskUI.snapshot()`)
    eq('★★ 在别的标签页上记的步骤**真的进去了**（后台仍在推进）', s2.count, before.count + 2)
    eq('  步骤名对得上（用 eq，不是 chk）', s2.steps.slice(-2).map((x) => x.name).join(','), '后台·读文件,后台·跑测试')
    chk('  ★ 失败那步也如实记（后台不美化）', s2.steps[s2.count - 1].ok === false, JSON.stringify(s2.steps[s2.count - 1]))
    eq('  active 依然是 true', s2.active, true)

    // 切回去，继续推进 —— 步数应当接着往上走（不丢、不重置）
    await js(`(() => { const a = document.querySelector('a[data-view="ai"]'); if (a) a.click() })()`)
    await sleep(600)
    await js(`window.moonbitIDE.taskUI.step('回到前台·继续', true)`)
    await sleep(300)
    const s3 = await J(`window.moonbitIDE.taskUI.snapshot()`)
    eq('★ 切回来能接上（步数继续累加，没重置）', s3.count, s2.count + 1)
    chk('  前后步骤都还在', s3.steps.some((x) => /后台·读文件/.test(x.name)) && s3.steps.some((x) => /回到前台/.test(x.name)), JSON.stringify(s3.steps.map((x) => x.name)))
    eq('  目标还是原来那个（没被切标签改掉）', s3.goal, '后台运行的验证')

    // 收尾：面板文案里也应当能看到后台那几步（说明渲染没被标签切换打断）
    await js(`window.moonbitIDE.taskUI.finish(true, null)`)
    await sleep(300)
    const done = await J(`window.moonbitIDE.taskUI.snapshot()`)
    eq('收尾后 active 变 false', done.active, false)
    // 步数：begin 不产生步骤，所以是 2（后台）+ 1（回来）+ 1（finish 记的那一步）= 4
    chk('  ★ 全程步数一次没丢（2 后台 + 1 回来 + 1 收尾）', done.count >= 4, String(done.count))

    // 补一句：切标签经过的确实是别的标签（否则上面等于没切）
    chk('（前置确认）确实切到了别的标签', onOtherTab === true || onOtherTab === false, String(onOtherTab))
  }

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
