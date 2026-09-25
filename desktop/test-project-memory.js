'use strict'

/**
 * 项目级记忆单测（Phase 2.1 / P11-01 ～ P11-09）
 *
 * 纯 Node。断言用公共 verify-harness。
 * 最要紧的三节：⑤ 规则不可无确认修改、⑥ verified 默认 false、⑦ 检索只给相关的。
 */

const { createHarness } = require('./verify-harness')
const fs = require('fs')
const os = require('os')
const path = require('path')
const memStore = require('./project-memory-store')
const {
  MEMORY_DIR,
  memoryLayout,
  renderProjectMd,
  extractHandWritten,
  buildContextJson,
  parseRules,
  renderRulesTemplate,
  canWriteRules,
  createExperience,
  experienceFingerprint,
  searchExperiences,
  compressExperiences,
  deleteExperience,
  describeMemory,
} = require('./project-memory')
const { createProjectContext } = require('./project-context')

const H = createHarness()
const { chk, eq } = H

const CTX = createProjectContext({ root: 'C:/work/proj', kind: 'moonbit' })

async function main() {
  console.log('\n=== ① P11-01 布局（都在项目内的 .moonbit-work/）===')
  {
    const L = memoryLayout()
    eq('目录名', L.dir, MEMORY_DIR)
    eq('四个产物路径', [L.project, L.rules, L.context, L.historyDir], [
      '.moonbit-work/project.md', '.moonbit-work/agent-rules.md',
      '.moonbit-work/context.json', '.moonbit-work/history',
    ])
    chk('路径都在项目内（相对路径）', Object.values(L).every((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p)))
    chk('布局被冻结', Object.isFrozen(L))
  }

  console.log('\n=== ② P11-02 project.md 自动生成 + 保留手工补充 ===')
  {
    const md = renderProjectMd(CTX)
    chk('顶部写明是自动生成的', /自动生成/.test(md))
    chk('含根目录', md.indexOf('C:/work/proj') >= 0)
    chk('含项目类型', /`moonbit`/.test(md))
    chk('含常用命令小节（moonbit 类型有 test 命令）', /## 常用命令/.test(md) && /测试/.test(md), md.slice(0, 260))
    chk('有「手工补充」一节', /## 手工补充/.test(md))

    // ★ 关键：重新生成时不能把用户写的东西冲掉
    const mine = renderProjectMd(CTX, { handWritten: '这个项目有个坑：迁移脚本必须先跑。' })
    const kept = extractHandWritten(mine)
    eq('能把手工补充抠出来', kept, '这个项目有个坑：迁移脚本必须先跑。')
    const regen = renderProjectMd(CTX, { handWritten: kept })
    chk('★ 重新生成后手工内容仍在', regen.indexOf('迁移脚本必须先跑') >= 0)
    eq('没打开项目也不崩', typeof renderProjectMd(null), 'string')
  }

  console.log('\n=== ③ P11-03 context.json ===')
  {
    const j = buildContextJson(CTX, { files: ['a.mbt', 'b.mbt'], now: 1234 })
    eq('带 schema 版本（可演进）', j.schema, 'moonbit-work/project-context@1')
    eq('generatedAt 用传入的时间', j.generatedAt, 1234)
    eq('根目录与类型', [j.rootDir, j.projectType], ['C:/work/proj', 'moonbit'])
    eq('命令归到 commands 下', typeof j.commands, 'object')
    eq('文件列表被带上', j.files, ['a.mbt', 'b.mbt'])
    chk('无项目时不崩', buildContextJson(null).rootDir === null)
  }

  console.log('\n=== ④ P11-04 规则解析 + 模板 ===')
  {
    const tpl = renderRulesTemplate()
    chk('模板写明"未经确认不可修改"', /未经确认不可修改/.test(tpl))
    const rules = parseRules([
      '# Agent 规则',
      '## 通用',
      '- 只读优先',
      '- ! 绝不删数据库',
      '## 本项目',
      '- 迁移要先备份',
      '（这行不是规则，应被忽略）',
    ].join('\n'))
    eq('解析出 3 条', rules.length, 3)
    eq('第一条文本', rules[0].text, '只读优先')
    eq('第一条不是硬约束', rules[0].hard, false)
    eq('`!` 开头是硬约束', rules[1].hard, true)
    eq('  且文本去掉了 !', rules[1].text, '绝不删数据库')
    eq('记下了所属分类', [rules[0].section, rules[2].section], ['通用', '本项目'])
    chk('每条都有 id', rules.every((r) => typeof r.id === 'string'))
    eq('空文本 → 空数组', parseRules('').length, 0)
  }

  console.log('\n=== ⑤ P11-05 ★ 规则不可无确认修改 ===')
  {
    const no = canWriteRules({})
    eq('没有确认 → 拒绝', no.ok, false)
    chk('  并说明原因与需要确认', /受保护/.test(no.error) && no.needsConfirm === true, no.error)
    chk('  原因里点明了"约束的是 Agent 自己"', /Agent 自己/.test(no.error), no.error)
    eq('显式确认才算过', canWriteRules({ confirmed: true }).ok, true)
    chk('  confirmed 是非真值也不算过', canWriteRules({ confirmed: 1 }).ok === false)
  }

  console.log('\n=== ⑥ P11-06 经验：verified 默认 false ===')
  {
    const bad = createExperience({ error: '', solution: 'x' })
    eq('缺 error → 拒绝', bad.ok, false)
    eq('缺 solution → 拒绝', createExperience({ error: 'x' }).ok, false)

    const e = createExperience({ error: 'The value identifier x is unbound.', solution: '改成正确的名字', files: ['a.mbt'] })
    eq('合法经验 ok', e.ok, true)
    eq('★ 默认 verified=false（没验过的不算经验）', e.verified, false)
    chk('有 id', typeof e.id === 'string' && e.id.length > 0)
    eq('带上了 files', e.files, ['a.mbt'])
    const longTags = createExperience({ error: 'x', solution: 'y', tags: Array.from({ length: 20 }, (_, i) => 't' + i) })
    chk('tags 有上限', longTags.tags.length <= 12)
    const dupTags = createExperience({ error: 'x', solution: 'y', tags: ['a', 'a', 'b'] })
    eq('tags 去重', dupTags.tags, ['a', 'b'])

    // 指纹：数字与字面量不算区别（同类问题要能归到一起）；
    // 但**标识符不归一** —— 否则"类型不匹配"和"变量名打错"会被合到一起。
    const f1 = experienceFingerprint(createExperience({ error: 'unbound identifier foo at line 12', solution: 's' }))
    const f2 = experienceFingerprint(createExperience({ error: 'unbound identifier foo at line 99', solution: 's' }))
    eq('★ 同一句式、只有行号不同 → 指纹相同', f1, f2)
    const f3 = experienceFingerprint(createExperience({ error: 'unbound identifier bar at line 12', solution: 's' }))
    chk('标识符不同 → 指纹不同（宁少合并、不误合并）', f3 !== f1, f1 + ' vs ' + f3)
    const f4 = experienceFingerprint(createExperience({ error: '类型不匹配 int vs string', solution: 's' }))
    chk('不同错误指纹不同', f4 !== f1, f1 + ' vs ' + f4)
  }

  console.log('\n=== ⑦ P11-07 ★ 检索只给相关的（不是把库倒出来）===')
  {
    const lib = [
      createExperience({ error: 'unbound identifier fooUnbound', solution: '改正名字', files: ['a.mbt'], verified: true, tags: ['compiler'] }),
      createExperience({ error: '数据库连接超时', solution: '检查 PG 是否启动', files: ['db.mbt'], verified: true }), 
      createExperience({ error: 'CSS 里少了个分号', solution: '补分号', files: ['style.css'], verified: false }),
    ]
    const hit = searchExperiences(lib, { text: 'unbound identifier 报错', file: 'a.mbt' })
    chk('命中的排第一', hit.length >= 1 && /unbound/.test(hit[0].error), JSON.stringify(hit.map((e) => e.error)))
    chk('★ 完全不相关的（CSS）不在结果里', !hit.some((e) => /CSS/.test(e.error)), JSON.stringify(hit.map((e) => e.error)))
    eq('limit 生效', searchExperiences(lib, { text: 'unbound' }, { limit: 1 }).length, 1)

    // 完全无关的查询 → 返回空（而不是"随便给几条"）
    eq('★ 无关查询返回空', searchExperiences(lib, { text: '今天天气怎么样' }).length, 0)
    eq('空库不崩', searchExperiences([], { text: 'x' }).length, 0)

    // verified 有加权：同样命中时已验证的排前面
    const lib2 = [
      createExperience({ error: 'same issue here', solution: 'guess', verified: false, at: 999 }),
      createExperience({ error: 'same issue here', solution: 'real fix', verified: true, at: 1 }),
    ]
    const r2 = searchExperiences(lib2, { text: 'same issue' })
    eq('★ 已验证的排在未验证的前面（哪怕更旧）', r2[0].solution, 'real fix')
  }

  console.log('\n=== ⑧ P11-08 压缩：同类太多 → 合成一条 ===')
  {
    // 造 6 条同类（超过默认阈值 5）
    const same = []
    for (let i = 0; i < 6; i++) {
      same.push(createExperience({ error: 'unbound identifier name' + i + ' at line ' + i, solution: 'fix-' + i, at: 100 + i, verified: i >= 4 }))
    }
    const other = createExperience({ error: '完全不相关的错误 zzz', solution: 's', at: 500 })
    const r = compressExperiences(same.concat([other]))
    chk('★ 同类被压缩（6 → 1）', r.experiences.filter((e) => /unbound/.test(e.error)).length === 1, JSON.stringify(r.experiences.map((e) => e.error)))
    eq('无关那条原样保留', r.experiences.filter((e) => /zzz/.test(e.error)).length, 1)
    chk('压缩后条数明显减少', r.experiences.length < same.length + 1, String(r.experiences.length))
    const merged = r.experiences.find((e) => /unbound/.test(e.error))
    chk('合成条标了 compressed 与来源数量', merged.compressed === true && merged.compressedFrom === 6, JSON.stringify({ c: merged.compressed, n: merged.compressedFrom }))
    chk('★ hits 累计（说明这个问题反复出现）', merged.hits >= 6, String(merged.hits))
    chk('★ 组里有 verified 的 → 合成条也是 verified', merged.verified === true)
    eq('保留了最近那条的 solution', merged.solution, 'fix-5')
    eq('removedCount 如实统计', r.removedCount, 6)

    // 未超阈值就不动
    const small = compressExperiences(same.slice(0, 2))
    eq('没超过阈值不动', small.experiences.length, 2)
  }

  console.log('\n=== ⑨ P11-09 删除 ===')
  {
    const lib = [
      createExperience({ error: 'e1', solution: 's1', id: 'exp-1' }),
      createExperience({ error: 'e2', solution: 's2', id: 'exp-2' }),
    ]
    const r = deleteExperience(lib, 'exp-1')
    eq('删掉了', r.ok, true)
    eq('  只剩一条', r.experiences.map((e) => e.id), ['exp-2'])
    const miss = deleteExperience(lib, 'nope')
    eq('删不存在的 → ok=false', miss.ok, false)
    chk('  并说明没找到', /没有找到/.test(miss.error), miss.error)
    eq('  且不改原列表', miss.experiences.length, 2)
  }

  console.log('\n=== ⑩ describeMemory 可读 ===')
  {
    const rules = parseRules('- a\n- ! b')
    const exps = [createExperience({ error: 'x', solution: 'y', verified: true })]
    const line = describeMemory(['project.md'], rules, exps)
    chk('含规则数与硬约束数', /规则 2/.test(line) && /硬约束 1/.test(line), line)
    chk('含经验数与已验证数', /经验 1/.test(line) && /已验证 1/.test(line), line)
    chk('无换行', !/[\r\n]/.test(line))
  }

  console.log('\n=== ⑪ store 层：真建目录 / 手工补充保留 / 规则写保护 ===')
  {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-mem-'))
    try {
      const r1 = memStore.ensureLayout(ROOT, CTX, { now: 111 })
      chk('ensureLayout 成功', r1.ok === true, JSON.stringify(r1).slice(0, 120))
      chk('建出了 .moonbit-work/', fs.existsSync(path.join(ROOT, '.moonbit-work')))
      chk('建出了 history/', fs.existsSync(path.join(ROOT, '.moonbit-work', 'history')))
      chk('建出了 project.md', fs.existsSync(path.join(ROOT, '.moonbit-work', 'project.md')))
      chk('建出了 agent-rules.md', fs.existsSync(path.join(ROOT, '.moonbit-work', 'agent-rules.md')))
      chk('建出了 context.json', fs.existsSync(path.join(ROOT, '.moonbit-work', 'context.json')))

      // ★ 手工补充必须在重新生成后仍在
      const pj = path.join(ROOT, '.moonbit-work', 'project.md')
      const t1 = fs.readFileSync(pj, 'utf8')
      fs.writeFileSync(pj, t1.replace('（这里可以写项目背景、约定、注意事项 —— 重新生成时会被保留）', '我的项目备注：先跑迁移'), 'utf8')
      const r2 = memStore.ensureLayout(ROOT, CTX)
      chk('重新生成：保留了手工补充', r2.handWrittenKept === true, JSON.stringify(r2.handWrittenKept))
      chk('★ 重新生成后我的备注还在', fs.readFileSync(pj, 'utf8').indexOf('先跑迁移') >= 0)

      // ★ 规则存在时绝不被覆盖
      const rf = path.join(ROOT, '.moonbit-work', 'agent-rules.md')
      fs.writeFileSync(rf, '- 我自己写的规则\n', 'utf8')
      memStore.ensureLayout(ROOT, CTX)
      eq('★ 再次 ensureLayout 不覆盖已有规则', fs.readFileSync(rf, 'utf8').trim(), '- 我自己写的规则')

      // ★ P11-05：写规则没确认就拒
      const noW = memStore.writeRules(ROOT, '- 偷偷改掉\n', {})
      eq('★ 无确认写规则 → 拒绝', noW.ok, false)
      chk('  并说明原因', /受保护/.test(noW.error), noW.error)
      eq('  文件没被动', fs.readFileSync(rf, 'utf8').trim(), '- 我自己写的规则')
      const okW = memStore.writeRules(ROOT, '- 用户确认过的新规则\n', { confirmed: true })
      eq('有确认才写成功', okW.ok, true)
      eq('  且真的写进去了', fs.readFileSync(rf, 'utf8').trim(), '- 用户确认过的新规则')

      // 规则能被读回并解析
      const lr = memStore.loadRules(ROOT)
      eq('loadRules 能读回 1 条', lr.rules.length, 1)

      // 经验读写
      eq('初始没有经验库', memStore.loadExperiences(ROOT).exists, false)
      const w = memStore.saveExperiences(ROOT, [createExperience({ error: 'E', solution: 'S', verified: true })])
      chk('经验落盘成功', w.ok === true && w.count === 1, JSON.stringify(w))
      const le = memStore.loadExperiences(ROOT)
      eq('读回来 1 条', le.experiences.length, 1)
      eq('  内容一致', le.experiences[0].solution, 'S')

      // 损坏的经验文件 → 当空（不抛）
      fs.writeFileSync(path.join(ROOT, '.moonbit-work', 'history', 'experiences.json'), '{ 坏的', 'utf8')
      const bad = memStore.loadExperiences(ROOT)
      chk('损坏文件 → 当空且带 warning（不抛）', bad.ok === true && bad.experiences.length === 0 && !!bad.warning, JSON.stringify(bad).slice(0, 100))

      chk('describe 可读', /项目知识/.test(memStore.describe(ROOT)), memStore.describe(ROOT))
      chk('无效根不崩', memStore.ensureLayout('C:/__绝对不存在的路径__', CTX).ok === false)
    } finally {
      try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch (e) {
        console.log('[WARN] 清理临时目录失败：' + String((e && e.message) || e))
      }
    }
  }

  console.log('\n=== ⑫ review 后的加固：手工区边界 / 手改保护 / id 不撞 / 归档 ===')
  {
    // ① `### ` 不能被当成手工区的结尾（否则后面的内容会被静默丢掉）
    const md = ['## 手工补充', '第一段', '### 三级标题', '第二段（这个不能被丢）', '', '## 别的节', '不该被算进手工区'].join('\n')
    const hand = extractHandWritten(md)
    chk('★ ### 不被当成结尾（后面内容保留）', /第二段（这个不能被丢）/.test(hand), hand)
    chk('  但同级 ## 节会被排除', !/不该被算进手工区/.test(hand), hand)

    // ② 手工改写过的 project.md 不能被模板盖掉
    const R2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-guard-'))
    try {
      fs.mkdirSync(path.join(R2, '.moonbit-work'), { recursive: true })
      fs.writeFileSync(path.join(R2, '.moonbit-work', 'project.md'), '# 我自己写的项目说明\n\n绝不能丢\n', 'utf8')
      const res = memStore.ensureLayout(R2, CTX)
      eq('★ 手改过的 project.md → 跳过刷新', res.ok, false)
      chk('  并说明原因', /手工改写/.test(String(res.error)), String(res.error))
      chk('★★ 我的内容还在', fs.readFileSync(path.join(R2, '.moonbit-work', 'project.md'), 'utf8').indexOf('绝不能丢') >= 0)
    } finally {
      try { fs.rmSync(R2, { recursive: true, force: true }) } catch (e) { console.log('[WARN] ' + String((e && e.message) || e)) }
    }

    // ③ 正常刷新前会先备份
    const R3 = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-bak-'))
    try {
      const a = memStore.ensureLayout(R3, CTX)
      chk('第一次生成（无需备份）', a.ok === true && a.backedUp === false, JSON.stringify({ ok: a.ok, b: a.backedUp }))
      const b = memStore.ensureLayout(R3, CTX)
      chk('★ 第二次刷新前留下 .bak', b.ok === true && b.backedUp === true && fs.existsSync(path.join(R3, '.moonbit-work', 'project.md.bak')))
    } finally {
      try { fs.rmSync(R3, { recursive: true, force: true }) } catch (e) { console.log('[WARN] ' + String((e && e.message) || e)) }
    }

    // ④ 同毫秒批量创建 id 不重复（否则按 id 删会一次删多条）
    const ids = []
    for (let i = 0; i < 20; i++) ids.push(createExperience({ error: 'e', solution: 's', now: 1000 }).id)
    eq('★ 同毫秒批量建经验 id 不重复', new Set(ids).size, ids.length)

    // ⑤ 规则模板里的注释行不能被当成规则读给 Agent
    const tplRules = parseRules(renderRulesTemplate())
    chk('★ 模板里的说明不是规则', !tplRules.some((r) => /在这里写/.test(r.text)), JSON.stringify(tplRules.map((r) => r.text)))
    chk('  但真规则还在', tplRules.length > 0, String(tplRules.length))

    // ⑥ 被压缩掉的条目要能找回（归档）
    const R4 = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-arch-'))
    try {
      const six = []
      for (let i = 0; i < 6; i++) six.push(createExperience({ error: 'same pattern ' + i, solution: 'fix-' + i, verified: true, at: 100 + i }))
      const r = compressExperiences(six)
      const arch = memStore.archiveExperiences(R4, r.removed)
      chk('★ 被合并的条目被归档（可找回）', arch.ok === true && arch.count === 6 && fs.existsSync(path.join(R4, arch.file)), JSON.stringify(arch).slice(0, 120))
      const back = JSON.parse(fs.readFileSync(path.join(R4, arch.file), 'utf8'))
      eq('  归档里确实有原始解法', back.experiences.length, 6)
      chk('  且带原始 id 可对应', back.experiences.every((e) => typeof e.id === 'string'))
    } finally {
      try { fs.rmSync(R4, { recursive: true, force: true }) } catch (e) { console.log('[WARN] ' + String((e && e.message) || e)) }
    }
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
