// PH3-SESSION 的验证：标题 / 列表 / 搜索 / 归档删除 / 导出 / 关联 / 回放。
//
// 重点是 SESSION-10：**回放与导出都不得泄漏隐藏思维链**（reasoning / thinking …）。
// 纯逻辑，可进 CI。
const { createHarness } = require('./verify-harness')
const {
  LIMITS, REPLAY_KIND,
  titleOf, listItemOf, listSessions, searchSessions,
  archiveSession, deleteSession, replaySession, exportSession,
  withLinks, resumeTarget,
} = require('./session-view')

const H = createHarness()
const { chk, eq } = H

const P = 'C:/proj'
function sess(over) {
  return Object.assign({
    id: 's1', projectRoot: P, createdAt: 1000, updatedAt: 2000,
    messages: [
      { role: 'user', text: '修复登录接口的超时问题', at: 1100 },
      { role: 'assistant', text: '好的', at: 1200, reasoning: '我先把登录链路过一遍', thinking: '内部草稿' },
    ],
    toolCalls: [{ name: 'readFile', ok: true, at: 1300, summary: '读了 3 个文件' }],
    patches: [{ file: 'auth.mbt', applied: true, at: 1400, summary: '改超时', sessionId: 's1', taskId: 't1' }],
    verifications: [{ ok: false, status: 'VERIFY_FAILED', at: 1500, steps: [{ name: 'test', ok: false }] }],
  }, over || {})
}

console.log('=== ① 边界：null / 空（按记忆，第一组就测它）===')
{
  eq('titleOf(null) 不炸', titleOf(null), '（未命名会话）')
  eq('listItemOf(null) → null', listItemOf(null), null)
  eq('listSessions(null) → 空', listSessions(null).length, 0)
  eq('searchSessions(null, q) → 空', searchSessions(null, 'x').length, 0)
  eq('replaySession(null) → 不炸且 ok:false', replaySession(null).ok, false)
  eq('exportSession(null) → ok:false', exportSession(null).ok, false)
  eq('archiveSession(null) → ok:false', archiveSession(null).ok, false)
  eq('deleteSession(null, {confirmed:true}) → ok:false', deleteSession(null, { confirmed: true }).ok, false)
  eq('resumeTarget(null) → ok:false', resumeTarget(null, P).ok, false)
  chk('withLinks(null) 不炸', withLinks(null).sessionId === undefined)
  eq('空会话也有标题占位', titleOf({ messages: [] }), '（未命名会话）')
}

console.log('\n=== ② PH3-SESSION-01 标题来自第一条用户任务 ===')
{
  eq('★ 由第一条 user 消息生成', titleOf(sess()), '修复登录接口的超时问题')
  // assistant 的消息不能当标题（那不是"任务"）
  eq('★ assistant 的不能当标题', titleOf({ messages: [{ role: 'assistant', text: '你好' }, { role: 'user', text: '真正的任务' }] }), '真正的任务')
  // 换行压平
  eq('换行压成空格', titleOf({ messages: [{ role: 'user', text: '第一行\n第二行' }] }), '第一行 第二行')
  // 过长截断，且**看得出来被截了**
  const long = titleOf({ messages: [{ role: 'user', text: 'x'.repeat(100) }] })
  eq('★ 截到上限', long.length, LIMITS.maxTitleChars)
  chk('  ★ 末尾有省略号（不是悄悄截断）', long.endsWith('…'), long.slice(-3))
  // 没有任务 → 明确说未命名，而不是拿时间戳假装标题
  eq('★ 没有任务文本 → 明确"未命名"', titleOf({ messages: [], createdAt: 123 }), '（未命名会话）')
  chk('  不拿时间戳假装标题', titleOf({ messages: [], createdAt: 123 }).indexOf('123') < 0)
  eq('空白消息不算任务', titleOf({ messages: [{ role: 'user', text: '   ' }] }), '（未命名会话）')
}

console.log('\n=== ③ PH3-SESSION-02 列表（标题/时间/项目/状态）===')
{
  const it = listItemOf(sess())
  eq('标题', it.title, '修复登录接口的超时问题')
  eq('项目', it.project, P)
  eq('状态：未结束 → 进行中', it.status, '进行中')
  eq('  已结束 → 已结束', listItemOf(sess({ endedAt: 9000 })).status, '已结束')
  chk('带四类计数', it.counts.toolCalls === 1 && it.counts.patches === 1 && it.counts.verifications === 1, JSON.stringify(it.counts))

  const many = [sess({ id: 'a', updatedAt: 100 }), sess({ id: 'b', updatedAt: 900 }), sess({ id: 'c', updatedAt: 500 })]
  eq('★ 按更新时间倒序', listSessions(many).map((x) => x.id), ['b', 'c', 'a'])
  eq('★ 默认不含归档的', listSessions([sess({ id: 'x' }), sess({ id: 'y', archived: true })]).length, 1)
  eq('  显式要求才含归档', listSessions([sess({ id: 'x' }), sess({ id: 'y', archived: true })], { includeArchived: true }).length, 2)
}

console.log('\n=== ④ PH3-SESSION-03 搜索（标题与消息，且说明命中在哪）===')
{
  const list = [sess({ id: 's1' }), sess({ id: 's2', messages: [{ role: 'user', text: '帮忙看看数据库', at: 1 }, { role: 'user', text: '给它加个索引', at: 2 }] })]
  const r1 = searchSessions(list, '登录')
  eq('★ 命中标题', r1.length, 1)
  eq('  并说明命中在 title', r1[0].hit, 'title')
  const r2 = searchSessions(list, '索引')
  eq('★ 命中消息（标题里没有这个词）', r2.length, 1)
  eq('  并说明命中在 message', r2[0].hit, 'message')
  eq('搜不到 → 空', searchSessions(list, '不存在的词').length, 0)
  eq('空查询 → 空（不返回全部）', searchSessions(list, '  ').length, 0)
  eq('归档的不参与搜索', searchSessions([sess({ id: 'z', archived: true, messages: [{ role: 'user', text: '登录' }] })], '登录').length, 0)
  eq('大小写不敏感', searchSessions([sess({ messages: [{ role: 'user', text: 'Fix Auth Timeout' }] })], 'auth').length, 1)
}

console.log('\n=== ⑤ PH3-SESSION-04/05/06 Resume / Archive / Delete ===')
{
  const list = [sess({ id: 'old', updatedAt: 100 }), sess({ id: 'new', updatedAt: 900 }), sess({ id: 'gone', archived: true, updatedAt: 999 })]
  const r = resumeTarget(list, P)
  eq('★ Resume 接最近更新的**非归档**会话', r.session.id, 'new')
  chk('  并说明依据', /最近/.test(r.reason), r.reason)
  eq('★ 不跨项目：别的项目没有会话', resumeTarget(list, 'C:/other').ok, false)

  const ar = archiveSession(sess(), 5000)
  eq('归档成功', ar.ok, true)
  eq('  标记 archived', ar.session.archived, true)
  eq('  记时间', ar.session.archivedAt, 5000)

  eq('★ 删除必须明确确认', deleteSession(sess(), {}).ok, false)
  chk('  说明要传 confirmed', /confirmed/.test(String(deleteSession(sess(), {}).error)))
  const d = deleteSession(sess(), { confirmed: true, by: 'user', now: 6000 })
  eq('确认后可删', d.ok, true)
  eq('★ 留墓碑（谁删的/何时）', d.tombstone.deletedBy, 'user')
  eq('  墓碑带标题（便于事后核对删了哪条）', d.tombstone.title, '修复登录接口的超时问题')
}

console.log('\n=== ⑥ ★★ PH3-SESSION-10 回放：不展示隐藏思维链 ===')
{
  const r = replaySession(sess())
  eq('回放成功', r.ok, true)
  chk('  有步骤', r.steps.length >= 4, String(r.steps.length))
  const kinds = r.steps.map((s) => s.kind)
  chk('★ 含 任务/工具/补丁/验证 四类', ['task', 'tool', 'patch', 'verify'].every((k) => kinds.indexOf(k) >= 0), JSON.stringify(kinds))

  // ★ 核心断言：产出里**没有任何**思维链字段
  chk('★ 明确报告没有泄漏字段', Array.isArray(r.leak) && r.leak.length === 0, JSON.stringify(r.leak))
  const allKeys = []
  for (const st of r.steps) allKeys.push(...Object.keys(st))
  for (const f of ['reasoning', 'thinking', 'thought', 'rawResponse', 'raw']) {
    chk('★ 不含字段 ' + f, allKeys.indexOf(f) < 0, JSON.stringify(allKeys))
  }
  // 而且**值**里也不能漏出来（字段名换了也得防）
  const blob = JSON.stringify(r.steps)
  chk('★ 内容里也不含思维链文本', blob.indexOf('我先把登录链路过一遍') < 0 && blob.indexOf('内部草稿') < 0, blob.slice(0, 160))
  chk('  确实只展示了"做了什么"', blob.indexOf('readFile') >= 0 && blob.indexOf('auth.mbt') >= 0)

  // 工具参数全文不给（可能有敏感内容），只给摘要
  chk('★ 工具只给结论摘要，不给参数全文', r.steps.find((s) => s.kind === 'tool').summary === '读了 3 个文件')
  chk('  声明了只展示什么', /不展示隐藏思维链/.test(r.note), r.note)

  eq('空会话 → 空步骤（不炸）', replaySession({ messages: [] }).steps.length, 0)
}

console.log('\n=== ⑦ PH3-SESSION-07 导出（JSON / Markdown，同样不含思维链）===')
{
  const j = exportSession(sess(), 'json')
  eq('JSON 导出成功', j.ok, true)
  chk('★ JSON 里不含思维链', j.text.indexOf('内部草稿') < 0 && j.text.indexOf('reasoning') < 0, j.text.slice(0, 120))
  chk('  含标题与统计', /修复登录接口/.test(j.text) && /counts/.test(j.text))
  const parsed = JSON.parse(j.text)
  chk('★ 导出的是 replay 的白名单结果（不是原始 session）', Array.isArray(parsed.steps) && parsed.messages === undefined, JSON.stringify(Object.keys(parsed)))

  const m = exportSession(sess(), 'markdown')
  eq('Markdown 导出成功', m.ok, true)
  chk('★ 也不含思维链', m.text.indexOf('内部草稿') < 0, m.text.slice(0, 120))
  chk('  有标题与任务小节', /^# 修复登录接口/m.test(m.text) && /## 任务/.test(m.text))
  chk('  工具与补丁是可读行', /- 工具 readFile：成功/.test(m.text) && /- 补丁 auth.mbt：已落盘/.test(m.text))
  chk('  验证失败也如实写', /- 验证：未通过/.test(m.text), m.text.slice(-200))
  eq('非法格式默认走 json', exportSession(sess(), 'pdf').format, 'json')
}

console.log('\n=== ⑧ PH3-SESSION-08/09 Patch 与 Verification 的关联 ===')
{
  const p = withLinks({ file: 'a.mbt' }, { sessionId: 's1', taskId: 't9' })
  eq('★ Patch 记了 sessionId', p.sessionId, 's1')
  eq('★ 也记了 taskId', p.taskId, 't9')
  eq('不影响别的字段', p.file, 'a.mbt')

  // 回放里也要能看到关联（否则事后无法把补丁归到哪次任务）
  const r = replaySession(sess({ patches: [{ file: 'a.mbt', applied: true, sessionId: 's1', taskId: 't9', at: 1 }] }))
  const step = r.steps.find((s) => s.kind === 'patch')
  chk('★ 回放里带出关联', step.sessionId === 's1' && step.taskId === 't9', JSON.stringify(step))

  // 验证步骤也带结论
  const v = r.steps.find((s) => s.kind === 'verify')
  chk('★ 验证步骤带 status 与步骤数', v.status === 'VERIFY_FAILED' && v.stepsCount === 1, JSON.stringify(v))
  chk('  且失败如实为 false', v.ok === false)
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
