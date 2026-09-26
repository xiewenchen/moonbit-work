// PH3-MEM 的验证：Schema / 类型 / 候选确认 / 检索不相关不注入 / 合并归档 / 跨项目隔离。
//
// 纯逻辑，可进 CI。
const { createHarness } = require('./verify-harness')
const {
  MEMORY_TYPE, ALL_TYPES, MEMORY_SOURCE, LIMITS,
  createMemory, canStore,
  proposeMemory, acceptProposal, discardProposal,
  tokens, retrieve, belongsTo, mergeMemories, deleteMemory,
} = require('./memory-schema')

const H = createHarness()
const { chk, eq } = H

const P = 'C:/proj-a'
const Q = 'C:/proj-b'
const mk = (o) => createMemory(o).memory

console.log('=== ① PH3-MEM-01/02 Schema 与五类 ===')
{
  eq('五类：RULE/FACT/PATTERN/ERROR/DECISION', ALL_TYPES.slice().sort(), ['DECISION', 'ERROR', 'FACT', 'PATTERN', 'RULE'])
  const m = mk({ type: MEMORY_TYPE.FACT, content: '入口是 cmd/main/main.mbt', project: P, now: 1000 })
  eq('type', m.type, 'FACT')
  eq('content', m.content, '入口是 cmd/main/main.mbt')
  eq('★ project 存的是**工作空间身份**（不是原字符串）', m.project, 'ws:c:/proj-a')
  eq('source 默认 agent', m.source, MEMORY_SOURCE.AGENT)
  eq('createdAt 用传入的 now', m.createdAt, 1000)
  eq('updatedAt', m.updatedAt, 1000)
  chk('冻结', Object.isFrozen(m))
  chk('有 id', typeof m.id === 'string' && m.id.length > 4)

  chk('非法 type → 拒绝', createMemory({ type: 'MOOD', content: 'x' }).ok === false)
  chk('空 content → 拒绝', createMemory({ type: 'FACT', content: '  ' }).ok === false)
  chk('null 输入不炸', createMemory(null).ok === false)
}

console.log('\n=== ② PH3-MEM-03 只有 Verified 的 ERROR 才算经验 ===')
{
  eq('★ 新记忆 verified 默认 false（不是"已验过"）', mk({ type: 'FACT', content: 'x', project: P }).verified, false)

  const guess = createMemory({ type: MEMORY_TYPE.ERROR, content: '可能是空指针', project: P })
  eq('★ 未验证的 ERROR → 建不出来', guess.ok, false)
  chk('  且说明原因', /verified/.test(guess.errors.join(' ')), guess.errors.join(' '))

  const verified = mk({ type: MEMORY_TYPE.ERROR, content: '空指针：pool 归还时未置空', verified: true, project: P })
  eq('已验证的 ERROR → 可以', verified.type, 'ERROR')
  eq('  verified 为 true', verified.verified, true)

  eq('★ canStore 也再拦一道', canStore(mk({ type: MEMORY_TYPE.ERROR, content: 'x', verified: true, project: P })).ok, true)
  eq('  未验证的 ERROR 拒绝', canStore({ type: 'ERROR', verified: false, project: 'ws:x' }).ok, false)
  eq('★ 没有归属工作空间 → 拒绝入库', canStore({ type: 'FACT', verified: true, project: null }).ok, false)
}

console.log('\n=== ③ PH3-MEM-06/07 候选 → 用户确认（Agent 不能直接写）===')
{
  const fact = mk({ type: 'FACT', content: '入口是 cmd/main/main.mbt', project: P })
  const p = proposeMemory(fact, { origin: 'agent', reason: '从目录结构看出来的' }, 2000)
  eq('propose 成功', p.ok, true)
  eq('★ 候选状态是 PENDING（**不在**记忆库里）', p.proposal.state, 'PENDING')
  chk('  记下是谁提的、为什么', p.proposal.origin === 'agent' && /目录结构/.test(p.proposal.reason), JSON.stringify(p.proposal))
  chk('  且如实说"能入库"', p.proposal.willStore === true, JSON.stringify(p.proposal.willStore))

  const acc = acceptProposal(p.proposal, { by: 'user' }, 3000)
  eq('★ 用户 Keep → 才拿到 memory', acc.ok, true)
  chk('  记下是谁确认的', acc.memory.acceptedBy === 'user', String(acc.memory.acceptedBy))
  eq('  候选状态变 ACCEPTED', acc.proposal.state, 'ACCEPTED')

  const dis = discardProposal(p.proposal, '不对', 4000)
  eq('★ 用户 Discard', dis.ok, true)
  eq('  ★ 且**没有**产出 memory', dis.memory, undefined)
  eq('  候选状态 DISCARDED', dis.proposal.state, 'DISCARDED')
  chk('  记下丢弃原因', /不对/.test(String(dis.proposal.discardReason)), String(dis.proposal.discardReason))

  // 未验证的 ERROR 提议上去，确认了也**不能**入库（但要如实说明）
  const badErr = { id: 'x', type: 'ERROR', content: '猜测', project: 'ws:c:/proj-a', verified: false }
  const pb = proposeMemory(badErr)
  eq('★ 提议时就说清"进不了库"', pb.proposal.willStore, false)
  chk('  并给出原因', /不进记忆库/.test(String(pb.proposal.blockedReason)), String(pb.proposal.blockedReason))
  eq('★ 就算用户确认也拒绝', acceptProposal(pb.proposal).ok, false)

  chk('对非 PENDING 的候选再确认 → 拒绝', acceptProposal({ state: 'DONE' }).ok === false)
  chk('  discard 同理', discardProposal({ state: 'DONE' }).ok === false)
}

console.log('\n=== ④ ★ PH3-MEM-10 检索：不相关就**不注入** ===')
{
  const memories = [
    mk({ id: 'a', type: 'FACT', content: '入口是 cmd/main/main.mbt', project: P }),
    mk({ id: 'b', type: 'DECISION', content: '这个项目不使用 ORM，直接写 SQL', project: P }),
    mk({ id: 'c', type: 'FACT', content: '构建命令是 moon build --target native', project: P }),
  ]
  const hit = retrieve(memories, '我想加一个接口，入口文件在哪？', { project: P })
  chk('★ 相关问题 → 命中', hit.items.length >= 1, JSON.stringify(hit.items.map((x) => x.id)))
  chk('  且命中的确实相关（入口那条排前面）', hit.items[0].content.indexOf('入口') >= 0, hit.items[0].content)

  const miss = retrieve(memories, '帮我画一个日历组件', { project: P })
  eq('★ 不相关问题 → **一条都不给**', miss.items.length, 0)
  chk('  且如实说明是"不注入"而不是空着不说', /不注入/.test(miss.reason), miss.reason)

  // 无关任务不得因为"是 verified"就被塞进来
  const verifiedOnly = [mk({ id: 'v', type: 'FACT', content: 'Redis 连接池上限 64', verified: true, project: P })]
  eq('★ 不能因为"它是 verified"就无条件注入', retrieve(verifiedOnly, '写个 README', { project: P }).items.length, 0)

  eq('任务为空 → 没有可检索的词', retrieve(memories, '', { project: P }).items.length, 0)
  chk('  且说明原因', /没有可检索的词/.test(retrieve(memories, '', { project: P }).reason))
  eq('空记忆库不炸', retrieve(null, 'x', { project: P }).items.length, 0)
  chk('limit 生效', retrieve(
    [mk({ id: 'a', type: 'FACT', content: 'token pool redis cache', project: P }),
      mk({ id: 'b', type: 'FACT', content: 'token pool redis limit', project: P }),
      mk({ id: 'c', type: 'FACT', content: 'token pool redis size', project: P })],
    'token pool redis', { project: P, limit: 2 }).items.length === 2)
}

console.log('\n=== ⑤ ★ PH3-MEM-13 跨项目隔离（A 的规则不能被 B 看到）===')
{
  const ruleA = mk({ id: 'ra', type: 'RULE', content: 'Rule A：只允许 SELECT', project: P })
  const ruleB = mk({ id: 'rb', type: 'RULE', content: 'Rule B：必须用 ORM', project: Q })

  const forB = retrieve([ruleA, ruleB], 'SELECT 查询怎么写', { project: Q })
  chk('★ 在 B 里检索 → 只看到 B 的', forB.items.every((m) => m.project === 'ws:c:/proj-b'), JSON.stringify(forB.items.map((m) => m.id)))
  chk('★ A 的规则**不出现**', !forB.items.some((m) => /Rule A/.test(m.content)), JSON.stringify(forB.items.map((m) => m.content)))

  const forA = retrieve([ruleA, ruleB], 'SELECT 查询怎么写', { project: P })
  chk('反过来也一样', !forA.items.some((m) => /Rule B/.test(m.content)))

  chk('belongsTo 用身份判断', belongsTo(ruleA, 'C:/proj-a') === true)
  chk('★ 大小写/斜杠不同也算同一项目', belongsTo(ruleA, 'c:\\proj-a\\') === true)
  chk('★ 别的项目 → false', belongsTo(ruleA, Q) === false)
  chk('没有 project 的记忆不归属于任何项目', belongsTo({ id: 'x' }, P) === false)
}

console.log('\n=== ⑥ PH3-MEM-11 合并：生成 C，A/B **先归档**（不是删除）===')
{
  const a = mk({ id: 'a', type: 'FACT', content: '入口是 main.mbt', verified: true, project: P })
  const b = mk({ id: 'b', type: 'FACT', content: '入口文件为 cmd/main/main.mbt', verified: true, project: P })
  const r = mergeMemories(a, b, {}, 5000)
  eq('合并成功', r.ok, true)
  chk('★ 生成一条新的 C', r.merged.id !== a.id && r.merged.id !== b.id, r.merged.id)
  chk('  C 记下来源两条', JSON.stringify(r.merged.mergedFrom) === JSON.stringify(['a', 'b']), JSON.stringify(r.merged.mergedFrom))
  eq('★ A/B 被**归档**（不是删除）', r.archived.length, 2)
  chk('  归档标记与去向', r.archived.every((x) => x.archived === true && /已合并到/.test(x.archivedReason)), JSON.stringify(r.archived[0]))
  chk('  原内容还在（还能找回来）', r.archived[0].content === a.content)
  chk('★ 说明是归档不是删除', /归档/.test(r.note), r.note)

  // 一条验过一条没验 → 合并条**不算**验过（不能把没验的洗白）
  const c2 = mergeMemories(a, mk({ id: 'c', type: 'FACT', content: '入口在 main.mbt 附近', project: P }))
  eq('★ 一边没验 → 合并条也不算验过', c2.merged.verified, false)

  eq('类型不同 → 拒绝合并', mergeMemories(a, mk({ id: 'd', type: 'RULE', content: '入口 main.mbt', project: P })).ok, false)
  eq('不同工作空间 → 拒绝合并', mergeMemories(a, mk({ id: 'e', type: 'FACT', content: '入口 main.mbt', project: Q })).ok, false)
  eq('缺一条 → 拒绝', mergeMemories(a, null).ok, false)

  // 归档后不再被检索到（否则同一件事会出现两遍）
  const after = retrieve([r.merged, ...r.archived], '入口 main.mbt', { project: P })
  chk('★ 归档的不再参与检索', after.items.every((m) => !m.archived), JSON.stringify(after.items.map((m) => m.id)))
}

console.log('\n=== ⑦ PH3-MEM-12 删除必须明确 ===')
{
  const m = mk({ id: 'x', type: 'FACT', content: '入口是 main.mbt', project: P })
  eq('★ 没确认 → 拒绝', deleteMemory(m, {}).ok, false)
  chk('  说明要传 confirmed', /confirmed/.test(String(deleteMemory(m, {}).error)), String(deleteMemory(m, {}).error))
  const d = deleteMemory(m, { confirmed: true, by: 'user', reason: '过时了' }, 6000)
  eq('确认后可以删', d.ok, true)
  eq('★ 留下墓碑（谁删的、为什么）', d.tombstone.deletedBy, 'user')
  chk('  原因保留', /过时/.test(String(d.tombstone.reason)), String(d.tombstone.reason))
  chk('  预览保留（便于事后核对删了什么）', /入口/.test(String(d.tombstone.contentPreview)), String(d.tombstone.contentPreview))
  eq('null → 拒绝', deleteMemory(null, { confirmed: true }).ok, false)
}

console.log('\n=== ⑧ 分词语料（检索质量的基础）===')
{
  chk('中文按 2-gram 切（否则中文检索等于失效）', tokens('入口文件').indexOf('入口') >= 0, JSON.stringify(tokens('入口文件')))
  chk('英文按词切', tokens('moon build native').indexOf('build') >= 0)
  chk('英文停用词被去掉', tokens('the a of and').length === 0, JSON.stringify(tokens('the a of and')))
  eq('空输入 → 空', tokens(null).length, 0)
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
