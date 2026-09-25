'use strict'

/**
 * Session 单测（Phase 2.1 / P10-01 ～ P10-11）
 *
 * 纯 Node。断言用公共 verify-harness。
 * 最要紧的一节是 ⑦：**禁止跨项目污染** —— 这正是旧实现（localStorage 里一个字符串）会犯的错。
 */

const { createHarness } = require('./verify-harness')
const fs = require('fs')
const path = require('path')
const store = require('./session-store')
const {
  SESSION_LIMITS,
  SESSION_STATE,
  createSession,
  isSameProject,
  addMessage,
  addToolCall,
  addToolResult,
  addPatch,
  addVerification,
  setOpencodeSessionId,
  endSession,
  findOrCreateForProject,
  listForProject,
  describeSession,
} = require('./session')
const { createProjectContext } = require('./project-context')

const H = createHarness()
const { chk, eq } = H

const PROJ_A = createProjectContext({ root: 'C:/work/proj-a', kind: 'moonbit' })
const PROJ_B = createProjectContext({ root: 'C:/work/proj-b', kind: 'node' })
const NO_PROJ = null

async function main() {
  console.log('\n=== ① P10-01 会话 id ===')
  {
    const s1 = createSession({ projectContext: PROJ_A })
    const s2 = createSession({ projectContext: PROJ_A })
    chk('生成了 id', typeof s1.id === 'string' && s1.id.length > 0, s1.id)
    chk('两次生成不重复', s1.id !== s2.id, s1.id + ' vs ' + s2.id)
    chk('会话被冻结（不可被下游改坏）', Object.isFrozen(s1))
    eq('初始状态 active', s1.state, 'active')
    chk('初始四类记录都是空数组', [s1.messages, s1.toolCalls, s1.patches, s1.verifications].every((x) => Array.isArray(x) && x.length === 0))
  }

  console.log('\n=== ② P10-02 绑定 ProjectContext ===')
  {
    const a = createSession({ projectContext: PROJ_A })
    eq('记下项目根', a.projectRoot, 'C:/work/proj-a')
    eq('记下项目类型', a.projectType, 'moonbit')
    const n = createSession({ projectContext: NO_PROJ })
    eq('没打开项目也能建会话（不匹配任何项目）', n.projectRoot, null)
    chk('  isSameProject(无项目会话, A) = false', isSameProject(n, PROJ_A) === false)
    chk('  isSameProject(A会话, A) = true', isSameProject(a, PROJ_A) === true)
    chk('  isSameProject(A会话, B) = false', isSameProject(a, PROJ_B) === false)
    // 类型变了但根没变 → 算同一个项目
    const a2 = createProjectContext({ root: 'C:/work/proj-a', kind: 'node' })
    chk('根相同、类型变化仍算同一项目', isSameProject(a, a2) === true)
  }

  console.log('\n=== ③ P10-03 消息：不可变 + 裁剪 ===')
  {
    const s0 = createSession({ projectContext: PROJ_A })
    const s1 = addMessage(s0, { role: 'user', text: '帮我修一下' })
    chk('返回的是新对象（不可变）', s1 !== s0)
    eq('原对象没被改', s0.messages.length, 0)
    eq('新对象多了一条', s1.messages.length, 1)
    eq('内容保真', s1.messages[0].text, '帮我修一下')
    const long = addMessage(s1, { role: 'assistant', text: 'x'.repeat(SESSION_LIMITS.maxTextChars + 50) })
    chk('过长正文被裁剪', long.messages[1].text.length <= SESSION_LIMITS.maxTextChars + 1, String(long.messages[1].text.length))

    // 上限：不断加，长度封顶
    let s = createSession({ projectContext: PROJ_A })
    for (let i = 0; i < SESSION_LIMITS.maxMessages + 20; i++) s = addMessage(s, { text: 'm' + i })
    eq('消息条数封顶', s.messages.length, SESSION_LIMITS.maxMessages)
    eq('保留的是最近的（第一条是 m20）', s.messages[0].text, 'm20')
  }

  console.log('\n=== ④ P10-04～07 工具调用 / 结果 / 补丁 / 验证 ===')
  {
    let s = createSession({ projectContext: PROJ_A })
    s = addToolCall(s, { name: 'readFile', ok: true, ms: 12 })
    eq('工具调用记下了', [s.toolCalls[0].name, s.toolCalls[0].ok, s.toolCalls[0].ms], ['readFile', true, 12])
    s = addToolResult(s, { name: 'readFile', ok: true, truncated: true, summary: '前 8000 字' })
    chk('结果单独记一条（能看出是否被截断）', s.toolCalls[1].truncated === true)
    s = addToolCall(s, { name: 'noSuchTool', ok: false, error: '未知或不允许的工具：noSuchTool' })
    eq('失败也记（并留原因）', [s.toolCalls[2].ok, /未知/.test(s.toolCalls[2].error)], [false, true])

    s = addPatch(s, { file: 'a.mbt', summary: '改输出', applied: true })
    eq('补丁记下了', [s.patches[0].file, s.patches[0].applied], ['a.mbt', true])
    s = addPatch(s, { file: 'b.mbt', summary: '未确认', applied: false })
    eq('未落盘的补丁 applied=false（不混进"已改"）', s.patches[1].applied, false)

    s = addVerification(s, { ok: false, status: 'verify_failed', rounds: 1, steps: [{ name: 'check', ok: true }, { name: 'test', ok: false }] })
    eq('验证结论记下了', [s.verifications[0].ok, s.verifications[0].status], [false, 'verify_failed'])
    eq('  步骤也被裁剪保存', s.verifications[0].steps.map((x) => x.name + ':' + x.ok), ['check:true', 'test:false'])
    chk('每条记录都带时间戳',
      [s.toolCalls, s.patches, s.verifications].every((arr) => arr.length > 0 && arr.every((x) => typeof x.at === 'number')),
      JSON.stringify({ tools: s.toolCalls.length, patches: s.patches.length, vs: s.verifications.length }))
    chk('会话本身也带 updatedAt', typeof s.updatedAt === 'number')
  }

  console.log('\n=== ⑤ P10-08 恢复：序列化往返不丢东西 ===')
  {
    let s = createSession({ projectContext: PROJ_A, id: 'sess-fixed-1', now: 1000 })
    s = addMessage(s, { role: 'user', text: 'q', at: 1001 })
    s = addToolCall(s, { name: 'readFile', ok: true, ms: 5, at: 1002 })
    s = addPatch(s, { file: 'a.mbt', applied: true, at: 1003 })
    s = addVerification(s, { ok: true, status: 'verified', steps: [{ name: 'check', ok: true }], at: 1004 })
    s = setOpencodeSessionId(s, 'oc-123')
    const json = JSON.stringify(s)
    const back = JSON.parse(json)
    eq('id 往返一致', back.id, 'sess-fixed-1')
    eq('项目绑定往返一致（恢复后仍认得自己的项目）', back.projectRoot, 'C:/work/proj-a')
    eq('opencode 会话 id 往返一致（下一轮能续接）', back.opencodeSessionId, 'oc-123')
    eq('四类记录条数往返一致', [back.messages.length, back.toolCalls.length, back.patches.length, back.verifications.length], [1, 1, 1, 1])
    chk('恢复出来的仍能被 isSameProject 认出', isSameProject(back, PROJ_A) === true)
  }

  console.log('\n=== ⑥ P10-09 / P10-10 按项目取会话 + 结束会话 ===')
  {
    const r1 = findOrCreateForProject([], PROJ_A)
    chk('第一次是新建', r1.created === true)
    const r2 = findOrCreateForProject([r1.session], PROJ_A)
    chk('同项目第二次复用', r2.created === false)
    eq('  且是同一条', r2.session.id, r1.session.id)

    const ended = endSession(r1.session, { now: 9999 })
    eq('结束后状态为 ended', ended.state, SESSION_STATE.ENDED)
    const r3 = findOrCreateForProject([ended], PROJ_A)
    chk('已结束的会话不再被复用（会新建）', r3.created === true && r3.session.id !== ended.id)

    // 结束后不再接受新记录
    const after = addMessage(ended, { text: '不该进去' })
    eq('ended 的会话不再接受消息', after.messages.length, ended.messages.length)
  }

  console.log('\n=== ⑦ P10-11 ★ 禁止跨项目污染 ===')
  {
    // 用真实流程造两个项目的会话
    const A = findOrCreateForProject([], PROJ_A).session
    const B = findOrCreateForProject([A], PROJ_B)
    chk('切到别的项目 → 新建而不是复用 A 的会话', B.created === true)
    chk('  且 B 的会话 id 与 A 不同', B.session.id !== A.id)
    eq('  B 的会话绑的是 B 的项目', B.session.projectRoot, 'C:/work/proj-b')

    const a1 = addMessage(A, { role: 'user', text: 'A 项目的秘密' })
    const b1 = addMessage(B.session, { role: 'user', text: 'B 项目的问题' })
    chk('★ A 的消息**不在** B 的会话里', !JSON.stringify(b1).includes('A 项目的秘密'))
    chk('★ B 的消息也不在 A 的会话里', !JSON.stringify(a1).includes('B 项目的问题'))

    const all = [a1, b1]
    eq('★ listForProject(A) 只返回 A 的', listForProject(all, PROJ_A).map((s) => s.id), [a1.id])
    eq('★ listForProject(B) 只返回 B 的', listForProject(all, PROJ_B).map((s) => s.id), [b1.id])
    eq('  无项目时返回空（不会把所有人的会话漏出来）', listForProject(all, NO_PROJ).length, 0)

    // 回切到 A：应复用 A 的会话（不是 B 的）
    const backToA = findOrCreateForProject(all, PROJ_A)
    chk('★ 切回 A 复用 A 的会话而非 B 的', backToA.created === false && backToA.session.id === a1.id)
    chk('  且里面只有 A 的消息', !JSON.stringify(backToA.session).includes('B 项目的问题'))

    // 不同类型的项目、同名目录也不算同一个
    const otherRoot = createProjectContext({ root: 'C:/work/proj-a2', kind: 'moonbit' })
    const c = findOrCreateForProject(all, otherRoot)
    chk('★ 目录不同就是不同项目（不靠类型猜）', c.created === true && c.session.id !== a1.id)
  }

  console.log('\n=== ⑧ store 层：真写盘 / 真读回 / clear / 损坏（之前零覆盖）===')
  {
    // review 指出：store 的 load/save/clear/resumeOrCreate 之前**没有任何测试**，
    // 只在 verify 里走了内存缓存。这里用一个绝不会与真实项目重合的根来真读写。
    const FAKE = 'C:/__p10_store_probe__'
    const ctx = createProjectContext({ root: FAKE, kind: 'moonbit' })
    store.clear(FAKE)

    let s = createSession({ projectContext: ctx })
    s = addMessage(s, { role: 'user', text: '落盘探针' })
    const w = store.save(s)
    chk('save 报成功并给出文件路径', w.ok === true && !!w.file, JSON.stringify(w).slice(0, 140))
    chk('文件真的写出来了', fs.existsSync(w.file))

    const back = store.load(FAKE)
    chk('load 能读回来', !!back && back.id === s.id, String(back && back.id))
    eq('★ 内容真的从磁盘恢复（不是内存）', back.messages[0].text, '落盘探针')
    eq('★ 绑定信息也恢复了', back.projectRoot, FAKE)

    // ★ 存储层隔离：换一个根必须读不到（它只读自己那个文件）
    eq('★ 用别的根 load → null（读不到别人的）', store.load('C:/__p10_other__'), null)

    store.clear(FAKE)
    chk('clear 之后文件没了', !fs.existsSync(w.file))
    const fresh = store.resumeOrCreate(ctx)
    chk('clear 之后 resumeOrCreate 会新建', fresh.id !== s.id)
    eq('  且绑的还是这个项目', fresh.projectRoot, FAKE)

    // 没绑定项目的会话**拒绝落盘**
    eq('没绑定项目的会话拒绝落盘', store.save(createSession({ projectContext: null })).ok, false)

    // 文件损坏 → 当作没有（不抛）
    const f = path.join(store.SESSION_DIR, store.fileFor(FAKE))
    fs.writeFileSync(f, '{ 这不是 JSON', 'utf8')
    eq('损坏文件 → load 当作没有（不抛）', store.load(FAKE), null)
    chk('  resumeOrCreate 也不崩、会新建', typeof store.resumeOrCreate(ctx).id === 'string')

    store.clear(FAKE)
    chk('收尾：探针文件已清除', !fs.existsSync(f))
  }

  console.log('\n=== ⑨ describeSession 可读 ===')
  {
    let s = createSession({ projectContext: PROJ_A })
    s = addMessage(s, { text: 'x' })
    const line = describeSession(s)
    chk('含会话 id', /sess=/.test(line), line)
    chk('含项目', /项目=moonbit@C:\/work\/proj-a/.test(line), line)
    chk('含各类计数', /消息=1/.test(line) && /补丁=0/.test(line), line)
    chk('无换行（不会伪造日志行）', !/[\r\n]/.test(line))
    eq('null 也不崩', describeSession(null), '（无会话）')
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
