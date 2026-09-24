'use strict'

/**
 * 元测试：**验证"验证器本身"能抓到错**（Phase 2 / P19）
 *
 * 起因很具体：`verify-*.js` 里曾有 25 处 `chk('x', [a,b], [c,d])` ——
 * 数组恒为真 → 断言**永远 PASS**，等于没验。那段时间我报告的"通过"里
 * 有一部分是假的。教训是：**测试脚本自己没被测试过**。
 *
 * 所以这个文件用**独立的**计数器（不依赖被测对象来自证），
 * 逐条确认 `verify-harness` 的行为，尤其是"**能抓到错**"这一点。
 *
 * 纯 Node，可进 CI。
 */

const { createHarness, deepEqual, stable } = require('./verify-harness')

// ⚠️ 故意**不用** createHarness 来断言自己 —— 那样就成了自证
let P = 0
let F = 0
function assert(name, cond, detail) {
  if (cond === true) {
    P++
    console.log('  [PASS] ' + name)
  } else {
    F++
    console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
  }
}

/** 跑一段断言，收集它输出的行 + 计数（用于观察被测 harness 的行为）*/
function run(fn) {
  const lines = []
  const h = createHarness({ log: (s) => lines.push(String(s)) })
  fn(h)
  return { h, lines, text: lines.join('\n') }
}

console.log('\n=== ① 最要紧的一条：传数组必须失败（防"永远通过"）===')
{
  const r = run((h) => h.chk('数组当条件', [1, 2], [1, 2]))
  assert('chk 传数组 → fail 计数 +1', r.h.fail === 1, 'fail=' + r.h.fail)
  assert('chk 传数组 → pass 计数为 0', r.h.pass === 0, 'pass=' + r.h.pass)
  assert('输出里是 [FAIL] 而不是 [PASS]', r.text.includes('[FAIL]') && !r.text.includes('[PASS]'), r.text)
  assert('提示了"请用 eq"', /请用 eq/.test(r.text), r.text)

  for (const [label, val] of [['对象', { a: 1 }], ['字符串', 'x'], ['数字', 1], ['null', null], ['undefined', undefined]]) {
    const rr = run((h) => h.chk(label + '当条件', val))
    assert('chk 传' + label + ' → 失败', rr.h.fail === 1, label + ' fail=' + rr.h.fail)
  }
}

console.log('\n=== ② chk 的正常用法 ===')
{
  const r1 = run((h) => h.chk('真', true))
  assert('chk(true) → pass', [r1.h.pass, r1.h.fail].join('/') === '1/0', JSON.stringify([r1.h.pass, r1.h.fail]))
  const r2 = run((h) => h.chk('假', false))
  assert('chk(false) → fail', [r2.h.pass, r2.h.fail].join('/') === '0/1', JSON.stringify([r2.h.pass, r2.h.fail]))
  const r3 = run((h) => h.chk('表达式', 1 + 1 === 2))
  assert('chk(布尔表达式) → pass', r3.h.pass === 1, 'pass=' + r3.h.pass)
  const r4 = run((h) => h.chk('假带说明', false, '补充信息'))
  assert('失败时输出说明', r4.text.includes('补充信息'), r4.text)
}

console.log('\n=== ③ eq 的正常用法 ===')
{
  assert('数组相等 → pass', run((h) => h.eq('a', [1, 2], [1, 2])).h.pass === 1)
  assert('数组不等 → fail', run((h) => h.eq('a', [1, 2], [1, 3])).h.fail === 1)
  assert('标量相等 → pass', run((h) => h.eq('a', 7, 7)).h.pass === 1)
  assert('字符串相等 → pass', run((h) => h.eq('a', 'x', 'x')).h.pass === 1)
  assert("null 与 undefined 不等", run((h) => h.eq('a', null, undefined)).h.fail === 1)
  assert('false 与 0 不等', run((h) => h.eq('a', false, 0)).h.fail === 1)
}

console.log('\n=== ④ 深比较：键序无关（比原来的 JSON.stringify 更严）===')
{
  assert('{a,b} 与 {b,a} 相等（键序无关）', deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }) === true)
  assert('嵌套对象键序无关', deepEqual({ x: { p: 1, q: 2 } }, { x: { q: 2, p: 1 } }) === true)
  assert('嵌套数组顺序**有关**（顺序不同就不等）', deepEqual([1, 2], [2, 1]) === false)
  assert('对象键不同 → 不等', deepEqual({ a: 1 }, { a: 1, b: 2 }) === false)
  assert('数组与对象不等', deepEqual([], {}) === false)
  assert('NaN 与 NaN 相等（这里是结构比较，不是 ===）', deepEqual(NaN, NaN) === true)
  assert('函数的比较不抛错', typeof stable(() => {}) === 'string')
  // 对照组：原来的写法在这里是**错的**
  assert('对照：JSON.stringify 键序敏感（所以不能用它做相等）',
    JSON.stringify({ a: 1, b: 2 }) !== JSON.stringify({ b: 2, a: 1 }))
}

console.log('\n=== ⑤ 计数器 / summary / exitCode / failures ===')
{
  const r = run((h) => {
    h.chk('过1', true)
    h.chk('过2', true)
    h.eq('过3', 1, 1)
    h.chk('挂1', false)
    h.eq('挂2', 1, 2)
  })
  assert('pass=3', r.h.pass === 3, 'pass=' + r.h.pass)
  assert('fail=2', r.h.fail === 2, 'fail=' + r.h.fail)
  assert('failures 记录失败项名字', JSON.stringify(r.h.failures) === JSON.stringify(['挂1', '挂2']), JSON.stringify(r.h.failures))
  assert('summary 含 3 通过 / 2 失败', /3 通过 \/ 2 失败/.test(r.h.summary()), r.h.summary())
  assert('有失败 → exitCode=1', r.h.exitCode() === 1)
  const ok = run((h) => h.chk('唯一', true))
  assert('全过 → exitCode=0', ok.h.exitCode() === 0)
  assert('failures 是副本（外部改不动内部）', (() => {
    const rr = run((h) => h.chk('x', false))
    const a = rr.h.failures
    a.push('伪造')
    return rr.h.failures.length === 1
  })())
}

console.log('\n=== ⑥ harness 本身不会误报（正例全部通过）===')
{
  // 用一个**全是真的**断言集，确认没有"该过却判挂"的情况
  const r = run((h) => {
    h.chk('真', true)
    h.eq('空数组', [], [])
    h.eq('空对象', {}, {})
    h.eq('字符串', 'hello', 'hello')
    h.eq('布尔', true, true)
    h.eq('嵌套', { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })
  })
  assert('6 项全过、0 挂', [r.h.pass, r.h.fail].join('/') === '6/0', JSON.stringify([r.h.pass, r.h.fail]))
  assert('没有输出任何 [FAIL]', !r.text.includes('[FAIL]'), r.text)
}

console.log('\n' + '结果：' + P + ' 通过 / ' + F + ' 失败 / 共 ' + (P + F) + ' 项')
process.exit(F === 0 ? 0 : 1)
