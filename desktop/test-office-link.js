'use strict'

/**
 * 办公文件 ↔ 项目联动单测（Phase 2.1 / P13-04 ～ P13-07）
 *
 * 纯 Node。断言用公共 verify-harness。
 * 三处重点：关联**按项目隔离**、预览**没元信息要如实说**、写便签**是追加不是覆盖**。
 */

const { createHarness } = require('./verify-harness')
const {
  LINK_LIMITS,
  normalizeLink,
  createLinkStore,
  linkFile,
  unlinkFile,
  linksFor,
  projectOf,
  buildOfficePreview,
  toAgentSnippet,
  appendSummaryToNote,
  describeOfficeLink,
} = require('./office-link')

const H = createHarness()
const { chk, eq } = H

const A = 'C:/work/proj-a'
const B = 'C:/work/proj-b'

async function main() {
  console.log('\n=== ① P13-04 关联：显式登记，不靠路径猜 ===')
  {
    let s = createLinkStore(null)
    const r1 = linkFile(s, { file: 'C:/Users/me/Downloads/季度报告.docx', projectRoot: A, kind: 'docx' }, { now: 100 })
    chk('关联成功', r1.ok === true, JSON.stringify(r1.link))
    s = r1.store
    eq('自动取了文件名', r1.link.name, '季度报告.docx')
    eq('记下了类型与项目', [r1.link.kind, r1.link.projectRoot], ['docx', A])

    // 同一个文件再关联（换项目）= 更新，不追加
    const r2 = linkFile(s, { file: 'C:/Users/me/Downloads/季度报告.docx', projectRoot: B }, { now: 200 })
    eq('同文件重复关联 → 只留一条', r2.store.links.length, 1)
    eq('  且归属改成了新项目', projectOf(r2.store, 'C:/Users/me/Downloads/季度报告.docx'), B)

    chk('缺 file 或 projectRoot → 拒', linkFile(s, { file: '', projectRoot: A }).ok === false && linkFile(s, { file: 'x', projectRoot: '' }).ok === false)
    chk('normalizeLink 也拒空', normalizeLink({}).ok === false)
  }

  console.log('\n=== ② ★ 关联也按项目隔离（与 P13 一致）===')
  {
    let s = createLinkStore(null)
    s = linkFile(s, { file: 'C:/dl/甲.docx', projectRoot: A }).store
    s = linkFile(s, { file: 'C:/dl/乙.xlsx', projectRoot: B, kind: 'xlsx' }).store
    s = linkFile(s, { file: 'C:/dl/甲-附录.docx', projectRoot: A }).store

    eq('★ A 只看到 A 的（2 个）', linksFor(s, A).map((l) => l.name), ['甲-附录.docx', '甲.docx'])
    eq('★ B 只看到 B 的（1 个）', linksFor(s, B).map((l) => l.name), ['乙.xlsx'])
    chk('★ A 的列表里没有 B 的文件', !JSON.stringify(linksFor(s, A)).includes('乙'))
    eq('没给项目 → 空（不把全部倒出来）', linksFor(s, null).length, 0)
    eq('查单个文件的归属', [projectOf(s, 'C:/dl/乙.xlsx'), projectOf(s, 'C:/dl/不存在')], [B, null])

    const un = unlinkFile(s, 'C:/dl/甲.docx')
    eq('可以解除关联', linksFor(un.store, A).map((l) => l.name), ['甲-附录.docx'])
    eq('解不存在的 → 报错', unlinkFile(s, 'C:/dl/无').ok, false)
  }

  console.log('\n=== ③ P13-05 预览：有元信息就列出来，没有就如实说 ===')
  {
    const p = buildOfficePreview({ title: '季度经营报告', creator: '张三', pages: '8', words: '1234' }, { file: 'a.docx', kind: 'docx' })
    chk('识别出有元信息', p.hasMeta === true)
    eq('按固定顺序列出', p.rows.map((r) => r[0]).slice(0, 2), ['标题', '作者'])
    chk('含页数与字数', /页数/.test(JSON.stringify(p.rows)) && /字数/.test(JSON.stringify(p.rows)), JSON.stringify(p.rows))
    chk('★ 说明了"能预览到什么程度"', /不是排版还原/.test(p.note), p.note)

    const empty = buildOfficePreview(null, { file: 'x.txt' })
    eq('没有元信息 → hasMeta=false（不装作有）', empty.hasMeta, false)
    chk('★ 并如实说明原因', /没有可读的内置属性/.test(empty.note), empty.note)
    eq('  也没有编造字段', empty.rows.length, 0)
  }

  console.log('\n=== ④ P13-06 送进 Agent：每样东西都能指着说出处 ===')
  {
    const sn = toAgentSnippet({
      file: 'C:/dl/季度报告.docx', kind: 'docx', projectRoot: A,
      meta: { title: '季度经营报告', creator: '张三' },
      text: '第三季度营收同比增长 12%……',
    }, { now: 100 })
    chk('生成了片段', sn.ok === true && sn.snippet.length > 0)
    chk('★ 标明了文件与类型', /季度报告\.docx/.test(sn.snippet) && /docx/.test(sn.snippet), sn.snippet.slice(0, 120))
    chk('★ 标明了已关联的项目', new RegExp(A.replace(/[/\\]/g, '.')).test(sn.snippet), sn.snippet.slice(0, 200))
    chk('带上了元信息（标题/作者）', /季度经营报告/.test(sn.snippet) && /张三/.test(sn.snippet))
    chk('带上了正文', /营收同比增长/.test(sn.snippet))
    eq('标记有正文', sn.hasBody, true)

    const noBody = toAgentSnippet({ file: 'C:/dl/x.docx', kind: 'docx' })
    chk('★ 没有正文时如实说明（而不是留空白让人瞎猜）', /没有正文文本/.test(noBody.snippet), noBody.snippet.slice(-80))
    eq('  hasBody=false', noBody.hasBody, false)

    const long = toAgentSnippet({ file: 'f.txt', text: 'x'.repeat(LINK_LIMITS.maxSnippetChars + 500) })
    eq('★ 超长正文被截断并标记', long.truncated, true)
    chk('  截断说明写清了上限', /只取了前/.test(long.snippet), long.snippet.slice(-60))
  }

  console.log('\n=== ⑤ P13-07 总结 → 便签：追加，不是覆盖 ===')
  {
    const e1 = appendSummaryToNote('', '这个项目的迁移脚本要先跑。', { now: 0 })
    chk('空便签 → 直接写入', e1.ok === true && /迁移脚本要先跑/.test(e1.note), e1.note)
    chk('★ 带了小节标题与时间戳', /Agent 小结/.test(e1.note) && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(e1.note), e1.note)

    const e2 = appendSummaryToNote(e1.note, '另外记得补测试。', { now: 0 })
    chk('★★ 原有内容**还在**（追加不是覆盖）', /迁移脚本要先跑/.test(e2.note), e2.note)
    chk('★ 新内容也进去了', /补测试/.test(e2.note), e2.note)
    chk('  两段之间有分隔', e2.note.split('Agent 小结').length - 1 >= 2, e2.note)

    eq('空总结 → 拒', appendSummaryToNote('', '   ').ok, false)
    eq('总结全空白 → 拒', appendSummaryToNote('x', '').ok, false)

    const long = appendSummaryToNote('', 'y'.repeat(LINK_LIMITS.maxSummaryChars + 1000))
    chk('超长 → 保留最近的（便签不该无限长）', long.note.length <= LINK_LIMITS.maxSummaryChars, String(long.note.length))
  }

  console.log('\n=== ⑥ 损坏 / 异常输入不崩 ===')
  {
    for (const bad of [null, undefined, 'x', 42, {}, { links: 'no' }, { links: [{ file: '' }] }]) {
      const s = createLinkStore(bad)
      chk('createLinkStore 给出合法形状：' + String(JSON.stringify(bad)).slice(0, 18), Array.isArray(s.links))
    }
    eq('缺 file 的记录被过滤', createLinkStore({ links: [{ file: 'x' }] }).links.length, 0)
    eq('空输入也能给预览', buildOfficePreview(undefined).hasMeta, false)
    chk('toAgentSnippet 无参不崩', toAgentSnippet().ok === true)
  }

  console.log('\n=== ⑦ 一行摘要 ===')
  {
    let s = createLinkStore(null)
    s = linkFile(s, { file: 'C:/dl/a.docx', projectRoot: A, kind: 'docx' }).store
    const line = describeOfficeLink(s, A)
    chk('含数量', /关联 1 个文件/.test(line), line)
    chk('含文件名', /a\.docx/.test(line), line)
    chk('无换行', !/[\r\n]/.test(line))
    chk('没有关联时也可读', /关联 0 个文件/.test(describeOfficeLink(createLinkStore(null), A)))
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e))
  process.exit(1)
})
