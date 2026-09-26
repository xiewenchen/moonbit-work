// PH3-OFFICE 的验证：关联 Task / 便签→Context / 待办→Agent 任务 / 日历→项目任务。
//
// 纯逻辑，可进 CI。
const { createHarness } = require('./verify-harness')
const {
  FUSION_LIMITS, FUSION_SCOPE,
  linkToTask, linksOfTask, noteToContext, todoToAgentTask, calendarToProjectTask, buildOfficeContext,
} = require('./office-fusion')

const H = createHarness()
const { chk, eq } = H

console.log('=== ① 边界：null / 空（按记忆，第一组就测它）===')
{
  eq('linkToTask(null) → 拒绝', linkToTask(null, 't1').ok, false)
  eq('linksOfTask(null) → 空', linksOfTask(null, 't1').length, 0)
  eq('★ noteToContext(空) → null（不注入空便签）', noteToContext(''), null)
  eq('  空白也算空', noteToContext('   \n  '), null)
  eq('  null 也算空', noteToContext(null), null)
  eq('todoToAgentTask(null) → 拒绝', todoToAgentTask(null).ok, false)
  eq('calendarToProjectTask(null) → 拒绝', calendarToProjectTask(null).ok, false)
  eq('buildOfficeContext(null) → null', buildOfficeContext(null), null)
  eq('  全空也 null', buildOfficeContext({}), null)
  chk('FUSION_SCOPE 声明了能写与不写', Array.isArray(FUSION_SCOPE.writes) && Array.isArray(FUSION_SCOPE.neverWrites))
}

console.log('\n=== ② PH3-OFFICE-02 办公文件关联到 Task ===')
{
  const link = { file: 'C:/docs/a.docx', name: 'a.docx', projectRoot: 'C:/proj' }
  const r = linkToTask(link, 'task-1')
  eq('关联成功', r.ok, true)
  eq('★ 记上了 taskId', r.link.taskId, 'task-1')
  eq('  原字段不动', r.link.file, 'C:/docs/a.docx')
  eq('  也不改 projectRoot', r.link.projectRoot, 'C:/proj')
  chk('★ 不改原对象（返回新的）', link.taskId === undefined, String(link.taskId))

  eq('taskId 传空 → 变成 null（解绑）', linkToTask(link, '').link.taskId, null)
  eq('  传 null 也一样', linkToTask(link, null).link.taskId, null)
  chk('缺 file 的关联被拒', linkToTask({ name: 'x' }, 't').ok === false)

  const links = [{ file: 'a', taskId: 't1' }, { file: 'b', taskId: 't2' }, { file: 'c', taskId: 't1' }, { file: 'd' }]
  eq('★ 按任务筛出关联的文档', linksOfTask(links, 't1').map((l) => l.file).join(','), 'a,c')
  eq('  没有 taskId 的归到 null 组', linksOfTask(links, null).map((l) => l.file).join(','), 'd')
  eq('  没有匹配就是空', linksOfTask(links, 'nope').length, 0)
}

console.log('\n=== ③ PH3-OFFICE-05 便签 → Agent Context ===')
{
  const c = noteToContext('这个项目不使用 ORM，直接写 SQL。')
  chk('★ 非空便签能进上下文', !!c && /不使用 ORM/.test(c.text), JSON.stringify(c))
  eq('  类型标成 note', c.kind, 'note')
  eq('  没截断', c.truncated, false)
  eq('  没有截断就不编一句"已截断"', c.note, null)

  const long = noteToContext('x'.repeat(5000), { maxChars: 100 })
  eq('★ 超长被截到上限', long.text.length, 100)
  eq('  ★ 且如实标记 truncated', long.truncated, true)
  chk('  ★ 并说明原长（不是悄悄少给）', /共 5000 字/.test(String(long.note)), String(long.note))
  eq('  chars 记的是实际带进去的量', long.chars, 100)

  // 只有空白 → 不注入
  eq('★ 只写空格也算没内容', noteToContext('   \n\t '), null)
}

console.log('\n=== ④ ★ PH3-OFFICE-06 待办 → Agent 任务（**不猜意图**）===')
{
  const r = todoToAgentTask({ id: 'td-1', text: '修复登录 API 的超时' })
  eq('转换成功', r.ok, true)
  eq('★ goal 就是待办原文', r.task.goal, '修复登录 API 的超时')
  eq('★★ prompt **原样**（不补"请修复/请实现"之类话术）', r.prompt, '修复登录 API 的超时')
  chk('  且说明为什么不补话术', /不自动补/.test(r.note), r.note)
  eq('  带上 todoId', r.task.todoId, 'td-1')

  eq('★ 已完成的待办不重复发起', todoToAgentTask({ text: 'x', done: true }).ok, false)
  eq('  空文本的待办不能当任务', todoToAgentTask({ text: '  ' }).ok, false)
  chk('带 detail 时如实带上', todoToAgentTask({ text: 'x', detail: '注意兼容老接口' }).task.detail === '注意兼容老接口')
  eq('  没有 detail 就是 null（不编）', todoToAgentTask({ text: 'x' }).task.detail, null)
  chk('超长目标被截断', todoToAgentTask({ text: 'y'.repeat(1000) }).task.goal.length <= 320, String(todoToAgentTask({ text: 'y'.repeat(1000) }).task.goal.length))
  chk('projectRoot 从 opts 来', todoToAgentTask({ text: 'x' }, { projectRoot: 'C:/p' }).task.projectRoot === 'C:/p')
}

console.log('\n=== ⑤ PH3-OFFICE-07 日历事件 → 项目任务 ===')
{
  const r = calendarToProjectTask({ title: '给登录接口加限流', at: 1700000000000, note: '下周三前' }, { projectRoot: 'C:/proj' })
  eq('转换成功', r.ok, true)
  eq('★ 标题当任务文本', r.task.text, '给登录接口加限流')
  eq('★ 带上时间', r.task.dueAt, 1700000000000)
  eq('  标明来源', r.task.from, 'calendar')
  eq('  项目根带上', r.task.projectRoot, 'C:/proj')
  chk('  备注也带上', /下周三前/.test(String(r.task.detail)), String(r.task.detail))

  eq('★ 没有时间就是 null（不编一个）', calendarToProjectTask({ title: 'x' }).task.dueAt, null)
  eq('没标题 → 拒绝', calendarToProjectTask({ at: 1 }).ok, false)
  eq('  空白标题也拒', calendarToProjectTask({ title: '  ' }).ok, false)
}

console.log('\n=== ⑥ PH3-OFFICE-08 组合上下文 + **不碰 ProjectContext** ===')
{
  const ctx = buildOfficeContext({
    note: '这个项目不使用 ORM',
    todos: [{ id: 'a', text: '修复登录' }, { id: 'b', text: '已完成的事', done: true }, { id: 'c', text: ' ' }],
    links: [{ file: 'C:/docs/spec.docx', name: 'spec.docx', taskId: 't1' }],
  })
  chk('★ 组合成功', !!ctx, JSON.stringify(ctx))
  eq('  便签带上', /不使用 ORM/.test(ctx.note.text), true)
  eq('★ 只带未完成的待办（已完成与空白被过滤）', ctx.todos.join(','), '修复登录')
  eq('  关联文档带上（含 taskId）', ctx.docs[0].name + '|' + ctx.docs[0].taskId, 'spec.docx|t1')
  chk('  计数对得上', ctx.counts.todos === 1 && ctx.counts.docs === 1 && ctx.counts.note === 1, JSON.stringify(ctx.counts))

  eq('★ 全是空 → 不返回（不占上下文位置）', buildOfficeContext({ todos: [], links: [], note: '' }), null)
  eq('  只有已完成的待办也算空', buildOfficeContext({ todos: [{ text: 'x', done: true }] }), null)

  // ★ 结构保证：本层绝不写 ProjectContext / 源码
  chk('★★ 声明了绝不写 ProjectContext', FUSION_SCOPE.neverWrites.some((x) => /ProjectContext/.test(x)), JSON.stringify(FUSION_SCOPE.neverWrites))
  chk('★ 也绝不写源码', FUSION_SCOPE.neverWrites.some((x) => /源码/.test(x)), JSON.stringify(FUSION_SCOPE.neverWrites))
  chk('  规则文件要用户确认才算（不是随手写）', FUSION_SCOPE.neverWrites.some((x) => /agent-rules/.test(x)))
  chk('  能写的都在用户目录或 .moonbit-work 里', FUSION_SCOPE.writes.every((x) => /用户目录|moonbit-work/.test(x)), JSON.stringify(FUSION_SCOPE.writes))
  chk('★ 能写与绝不写的清单**没有交集**',
    !FUSION_SCOPE.writes.some((w) => FUSION_SCOPE.neverWrites.some((n) => w.split('(')[0] === n.split('(')[0])))
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
