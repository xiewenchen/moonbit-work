'use strict'

/**
 * 工作台数据层单测（Phase 2.1 / P13-01～03、P13-08）
 *
 * 纯 Node。断言用公共 verify-harness。
 *
 * 两处重点：
 *   ① **按项目隔离** —— 一个项目的待办/便签不能出现在另一个项目里；
 *   ② **不反向污染 IDE 状态**（P13-08）—— store 里只许有工作台自己的键。
 */

const { createHarness } = require('./verify-harness')
const {
  WORKBENCH_SCOPE,
  emptyStore,
  sanitizeStore,
  touchRecent,
  listRecent,
  forgetRecent,
  todosFor,
  addTodo,
  toggleTodo,
  removeTodo,
  noteFor,
  setNote,
  describeWorkbench,
} = require('./workbench')

const H = createHarness()
const { chk, eq } = H

const A = 'C:/work/proj-a'
const B = 'C:/work/proj-b'
const PROJ_A = { rootDir: A, projectType: 'moonbit', label: '甲项目' }
const PROJ_B = { rootDir: B, projectType: 'node', label: '乙项目' }

async function main() {
  console.log('\n=== ① P13-01 最近项目：同根去重、提到最前 ===')
  {
    let s = emptyStore()
    s = touchRecent(s, PROJ_A, { now: 100 })
    s = touchRecent(s, PROJ_B, { now: 200 })
    eq('两个都在', listRecent(s).map((r) => r.label), ['乙项目', '甲项目'])
    s = touchRecent(s, PROJ_A, { now: 300 })
    eq('★ 再打开 A 是把它提到最前（不是追加）', listRecent(s).map((r) => r.label), ['甲项目', '乙项目'])
    eq('  没有重复项', listRecent(s).length, 2)
    eq('记下了类型（供展示，不改 IDE）', listRecent(s)[0].projectType, 'moonbit')
    chk('没有项目根时不记', listRecent(touchRecent(s, {})).length === 2)

    let many = emptyStore()
    for (let i = 0; i < 30; i++) many = touchRecent(many, { rootDir: 'C:/p/' + i })
    eq('上限生效（最近 20）', listRecent(many).length, 20)
    eq('保留的是最近的', listRecent(many)[0].root, 'C:/p/29')

    const f = forgetRecent(s, A)
    eq('可以忘掉一个项目', listRecent(f).map((r) => r.label), ['乙项目'])
    chk('返回的是副本（改不到 store）', (() => { const l = listRecent(s); l[0].label = '改了'; return listRecent(s)[0].label !== '改了' })())
  }

  console.log('\n=== ② P13-02 项目待办：增 / 勾 / 删 ===')
  {
    let s = emptyStore()
    const r1 = addTodo(s, A, '  把迁移跑一遍  ', { now: 100 })
    chk('新增成功且去掉了两侧空格', r1.ok === true && r1.item.text === '把迁移跑一遍', JSON.stringify(r1.item))
    s = r1.store
    const r2 = addTodo(s, A, '补测试', { now: 200 })
    s = r2.store
    eq('两条都在', todosFor(s, A).map((t) => t.text), ['把迁移跑一遍', '补测试'])
    chk('id 不重复', todosFor(s, A)[0].id !== todosFor(s, A)[1].id)

    const t = toggleTodo(s, A, r1.item.id, { now: 300 })
    eq('可以勾上', todosFor(t.store, A).find((x) => x.id === r1.item.id).done, true)
    eq('可以只看未完成', todosFor(t.store, A, { includeDone: false }).map((x) => x.text), ['补测试'])

    const rm = removeTodo(t.store, A, r1.item.id)
    eq('可以删', todosFor(rm.store, A).map((x) => x.text), ['补测试'])
    eq('删不存在的 → 报错', removeTodo(s, A, 'nope').ok, false)
    eq('空内容 → 拒', addTodo(s, A, '   ').ok, false)
    eq('没有项目根 → 拒', addTodo(s, null, 'x').ok, false)

    // 长文本截断
    const long = addTodo(s, A, 'x'.repeat(500))
    chk('超长待办被截断', long.item.text.length <= 300, String(long.item.text.length))
  }

  console.log('\n=== ③ P13-03 项目便签 ===')
  {
    let s = emptyStore()
    eq('没有便签时是空串', noteFor(s, A), '')
    const r = setNote(s, A, '这个项目有个坑：先跑迁移')
    eq('写入成功', r.ok, true)
    eq('读回来一致', noteFor(r.store, A), '这个项目有个坑：先跑迁移')
    eq('没有项目根 → 拒', setNote(s, null, 'x').ok, false)
    const long = setNote(s, A, 'y'.repeat(30000))
    chk('超长便签被截断', noteFor(long.store, A).length <= 20000, String(noteFor(long.store, A).length))
  }

  console.log('\n=== ④ ★ 按项目隔离（待办/便签）===')
  {
    let s = emptyStore()
    s = addTodo(s, A, '甲项目的活儿').store
    s = addTodo(s, B, '乙项目的活儿').store
    s = setNote(s, A, '甲的便签').store
    s = setNote(s, B, '乙的便签').store

    eq('★ A 只看到 A 的待办', todosFor(s, A).map((t) => t.text), ['甲项目的活儿'])
    eq('★ B 只看到 B 的待办', todosFor(s, B).map((t) => t.text), ['乙项目的活儿'])
    eq('★ 便签也隔离', [noteFor(s, A), noteFor(s, B)], ['甲的便签', '乙的便签'])
    chk('★ A 的待办文本不出现在 B 的视图里', !JSON.stringify(todosFor(s, B)).includes('甲项目'))
    eq('没打开项目时拿不到任何待办', todosFor(s, null).length, 0)
    eq('  便签也拿不到', noteFor(s, null), '')

    // 删 A 的不影响 B
    const idA = todosFor(s, A)[0].id
    const after = removeTodo(s, A, idA).store
    eq('删 A 的待办后 A 空了', todosFor(after, A).length, 0)
    eq('  B 不受影响', todosFor(after, B).length, 1)
  }

  console.log('\n=== ⑤ ★ P13-08 不反向污染 IDE 状态 ===')
  {
    // 书面声明：这一层只拥有自己的三样东西，读的只有项目上下文的三个字段
    eq('owns 就是三样', WORKBENCH_SCOPE.owns, ['recent', 'todos', 'notes'])
    chk('reads 只提项目上下文', WORKBENCH_SCOPE.reads.every((k) => k.startsWith('projectContext.')), JSON.stringify(WORKBENCH_SCOPE.reads))
    chk('★ neverWritesIDE 里明确列了 IDE 状态', ['tabs', 'activeFile', 'runState', 'problems', 'session'].every((k) => WORKBENCH_SCOPE.neverWritesIDE.indexOf(k) >= 0))

    // 实际数据：store 里只许有工作台自己的键
    let s = emptyStore()
    s = touchRecent(s, PROJ_A)
    s = addTodo(s, A, 'x').store
    s = setNote(s, A, 'y').store
    const keys = Object.keys(s).sort()
    eq('★ store 的键只有工作台自己的', keys, ['notes', 'recent', 'todos', 'version'])
    for (const forbidden of WORKBENCH_SCOPE.neverWritesIDE) {
      chk('★ store 里没有 IDE 状态键：' + forbidden, keys.indexOf(forbidden) < 0)
    }
    chk('★ 整份 store 里找不到 IDE 的字段名', WORKBENCH_SCOPE.neverWritesIDE.every((k) => !JSON.stringify(s).includes(k)))

    // 传入的 IDE 状态必须被忽略（这是"只读"的实证）
    const withIDE = addTodo(Object.assign({}, s, { activeFile: 'x.mbt', runState: 'RUNNING', tabs: ['a'] }), A, 'z')
    const keys2 = Object.keys(withIDE.store).sort()
    eq('★ 传进来的 IDE 字段不会被带进 store', keys2, ['notes', 'recent', 'todos', 'version'])
  }

  console.log('\n=== ⑥ 损坏的 store 不该让工作台打不开 ===')
  {
    for (const bad of [null, undefined, 'string', 42, [], { recent: 'not-array', todos: 5, notes: null }]) {
      const s = sanitizeStore(bad)
      chk('sanitizeStore 不抛且给出合法形状：' + JSON.stringify(bad), Array.isArray(s.recent) && typeof s.todos === 'object' && typeof s.notes === 'object')
    }
    eq('类型错的 recent 被丢弃', sanitizeStore({ recent: 'x' }).recent.length, 0)
    // 待办字段类型不对时：**保留项目键、值清空**（项目还在，只是没待办）
    eq('待办不是数组时被当空', todosFor(sanitizeStore({ todos: { [A]: 'x' } }), A).length, 0)
    chk('缺少 root 的 recent 项被过滤', sanitizeStore({ recent: [{ label: 'x' }] }).recent.length === 0)
  }

  console.log('\n=== ⑦ 一行摘要 ===')
  {
    let s = emptyStore()
    s = touchRecent(s, PROJ_A)
    s = addTodo(s, A, 'a').store
    s = addTodo(s, A, 'b').store
    s = toggleTodo(s, A, todosFor(s, A)[0].id).store
    s = setNote(s, A, 'n').store
    const line = describeWorkbench(s)
    chk('含最近项目数', /最近 1 个项目/.test(line), line)
    chk('含待办与未完成数', /待办 2（未完成 1）/.test(line), line)
    chk('含便签数', /有便签的项目 1/.test(line), line)
    chk('无换行', !/[\r\n]/.test(line))
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
