// PH3-OFFICE 端到端：办公与工程的融合（真注入 + 真发起请求）。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(__dirname, 'office-fusion-result.txt')
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

  log('\n=== ① 注入与全局卫生 ===')
  {
    chk('★ window.moonbitOfficeFusion 存在', await js(`typeof window.moonbitOfficeFusion === 'object' && window.moonbitOfficeFusion !== null`), true)
    chk('★ 没污染全局（顶层标识符不该冒出来）', await js(`typeof window.FUSION_LIMITS === 'undefined' && typeof window.FUSION_SCOPE === 'undefined' && typeof window.linkToTask === 'undefined'`), true)
    const api = await J(`(() => { const o = window.moonbitIDE.officeFusion; return { has: !!o, keys: Object.keys(o) } })()`)
    chk('★ window.moonbitIDE.officeFusion 入口在', api.has === true, JSON.stringify(api.keys))
  }

  log('\n=== ② PH3-OFFICE-02 关联 Task + 按任务筛 ===')
  {
    const r = await J(`window.moonbitIDE.officeFusion.linkToTask({ file: 'C:/docs/spec.docx', name: 'spec.docx', projectRoot: 'C:/proj' }, 'task-7')`)
    eq('关联成功', r.ok, true)
    eq('★ 记上 taskId', r.link.taskId, 'task-7')
    chk('  不改原字段', r.link.name === 'spec.docx' && r.link.projectRoot === 'C:/proj')
    const list = await J(`window.moonbitIDE.officeFusion.linksOfTask([
      { file: 'a', name: 'a', taskId: 'task-7' }, { file: 'b', name: 'b', taskId: 'task-9' }, { file: 'c', name: 'c' }
    ], 'task-7')`)
    eq('★ 按任务筛出对应文档', list.map((x) => x.file).join(','), 'a')
  }

  log('\n=== ③ PH3-OFFICE-05 便签 → Context（限量 + 如实说明）===')
  {
    const c = await J(`window.moonbitIDE.officeFusion.noteToContext('这个项目不使用 ORM，直接写 SQL。')`)
    chk('★ 非空便签能进上下文', !!c && /不使用 ORM/.test(c.text), JSON.stringify(c))
    eq('★ 空便签 → null（不注入噪音）', await js(`window.moonbitIDE.officeFusion.noteToContext('   ') === null`), true)

    const long = await J(`window.moonbitIDE.officeFusion.noteToContext('x'.repeat(5000), { maxChars: 120 })`)
    eq('超长被截到上限', long.text.length, 120)
    chk('★ 如实标记 truncated', long.truncated === true, String(long.truncated))
    chk('  并说明原长', /共 5000 字/.test(String(long.note)), String(long.note))
  }

  log('\n=== ④ ★ PH3-OFFICE-06 待办 → Agent 任务：**真的发起请求**且**不补话术** ===')
  {
    const r = await J(`(() => { const t = window.moonbitIDE.officeFusion.todoToTask({ id: 'td1', text: '修复登录 API 的超时' }, { projectRoot: 'C:/p' }); return { ok: t.ok, goal: t.task.goal, prompt: t.prompt, note: t.note } })()`)
    eq('转换成功', r.ok, true)
    eq('★ goal 是待办原文', r.goal, '修复登录 API 的超时')
    eq('★★ prompt 原样（不补"请修复"之类）', r.prompt, '修复登录 API 的超时')
    chk('  且说明了为什么不补', /不自动补/.test(r.note), r.note)

    eq('★ 已完成的待办不重复发起', await js(`window.moonbitIDE.officeFusion.todoToTask({ text: 'x', done: true }).ok`), false)

    // ★★ 端到端：从待办直接发起一次真实请求
    await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
    await sleep(1500)
    // ⚠️ 这里不能走 J()：J 是 `JSON.stringify(expr)`，而 expr 是个 Promise，
    //    会得到 "{}"。所以自己 await 再 parse。
    const started = JSON.parse(await js(`(async () => {
      const r = await window.moonbitIDE.officeFusion.startFromTodo({ id: 'td2', text: '看看项目入口在哪' }, ${JSON.stringify(ROOT)})
      const req = r.request || {}
      return JSON.stringify({ ok: r.ok, goal: r.task && r.task.goal, hasReq: !!(req.ok), msg: (req.request && req.request.message) || null, err: r.error || null })
    })()`))
    chk('★★ 从待办发起成功', started.ok === true, JSON.stringify(started))
    chk('  请求真的建出来了（带上下文）', started.hasReq === true, JSON.stringify(started))
    eq('  目标仍是原样文本', started.goal, '看看项目入口在哪')
    eq('★ 请求的 message 就是那句待办（没被改写成别的话术）', started.msg, '看看项目入口在哪')

    eq('空待办不发起', await js(`window.moonbitIDE.officeFusion.todoToTask({ text: '  ' }).ok`), false)
  }

  log('\n=== ⑤ PH3-OFFICE-07 日历 → 项目任务 ===')
  {
    const r = await J(`window.moonbitIDE.officeFusion.calendarToTask({ title: '给登录接口加限流', at: 1700000000000, note: '下周三前' }, { projectRoot: 'C:/p' })`)
    eq('转换成功', r.ok, true)
    eq('★ 标题当任务', r.task.text, '给登录接口加限流')
    eq('  带上时间', r.task.dueAt, 1700000000000)
    eq('  标来源 calendar', r.task.from, 'calendar')
    eq('★ 没时间就是 null（不编）', (await J(`window.moonbitIDE.officeFusion.calendarToTask({ title: 'x' })`)).task.dueAt, null)
    eq('没标题 → 拒绝', await js(`window.moonbitIDE.officeFusion.calendarToTask({ at: 1 }).ok`), false)
  }

  log('\n=== ⑥ PH3-OFFICE-08 组合上下文 + 不碰 ProjectContext ===')
  {
    const ctx = await J(`window.moonbitIDE.officeFusion.buildContext({
      note: '不使用 ORM',
      todos: [{ id: 'a', text: '修复登录' }, { id: 'b', text: '已完成', done: true }],
      links: [{ file: 'C:/d/spec.docx', name: 'spec.docx', taskId: 't1' }],
    })`)
    chk('★ 组合成功', !!ctx, JSON.stringify(ctx))
    eq('★ 只带未完成的待办', ctx.todos.join(','), '修复登录')
    chk('  文档带 taskId', ctx.docs[0].taskId === 't1')
    eq('★ 全空 → null（不占上下文位置）', await js(`window.moonbitIDE.officeFusion.buildContext({ note: '', todos: [], links: [] }) === null`), true)

    const scope = await J(`window.moonbitIDE.officeFusion.scope()`)
    chk('★★ 结构声明：绝不写 ProjectContext', scope.neverWrites.some((x) => /ProjectContext/.test(x)), JSON.stringify(scope.neverWrites))
    chk('★ 也绝不写源码', scope.neverWrites.some((x) => /源码/.test(x)), JSON.stringify(scope.neverWrites))
    chk('  能写的都在用户目录或 .moonbit-work',
      scope.writes.every((x) => /用户目录|moonbit-work/.test(x)), JSON.stringify(scope.writes))

    // ★ 真验证：调用完这些 API 之后，ProjectContext 仍是**冻结**的、内容没变
    const before = await J(`window.moonbitIDE.getContext()`)
    await js(`window.moonbitIDE.officeFusion.linkToTask({ file: 'x', name: 'x' }, 't')`)
    await js(`window.moonbitIDE.officeFusion.buildContext({ note: 'x' })`)
    const after = await J(`window.moonbitIDE.getContext()`)
    eq('★★ 这些操作没有改动 ProjectContext', JSON.stringify(after), JSON.stringify(before))
    chk('  且它仍是冻结的', await js(`Object.isFrozen(window.moonbitIDE.getContext())`), true)
  }

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
