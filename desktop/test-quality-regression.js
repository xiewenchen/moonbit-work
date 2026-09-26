// PH3-Q-10/11 的验证：退化检测（与上次比）真的接进去了。
//
// ⚠️ 用**临时 userDir**（不碰真实 ~/.moonbit-work）—— 这个测试会写基线文件。
const { createHarness } = require('./verify-harness')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { compareWithLast, lastSnapshotFile } = require('./quality-main')

const H = createHarness()
const { chk, eq } = H

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ph3q-regression-'))
const r = (name, state, passed, failed) => ({ name, state, passed, failed })

console.log('=== ① 边界：null / 空 / 没有基线 ===')
{
  const a = compareWithLast(null, { userDir: TMP })
  chk('null 输入不炸', !!a)
  eq('★ 没有上次记录 → first=true（**不是"无退化"**）', a.first, true)
  eq('  且 hasRegression 为 false', a.hasRegression, false)
  chk('  说明是第一次', /第一次/.test(String(a.summary)), a.summary)
  eq('  默认不写基线（saved 不应为 true）', a.saved, undefined)

  const b = compareWithLast([], { userDir: TMP })
  eq('空数组也当成第一次', b.first, true)
}

console.log('\n=== ② ★ 通过数下降就是退化（清单点名的 Test 156 → 154）===')
{
  // 先存一个基线：156 通过
  const base = [r('单元测试', 'PASS', 156, 0), r('构建', 'PASS', 0, 0)]
  const s = compareWithLast(base, { userDir: TMP, save: true, now: 1000 })
  eq('★ 显式 save 才写基线', s.saved, true)
  chk('  基线文件真的落盘了', fs.existsSync(lastSnapshotFile(TMP)), lastSnapshotFile(TMP))

  // 再比一次：154 通过
  const now = [r('单元测试', 'PASS', 154, 0), r('构建', 'PASS', 0, 0)]
  const c = compareWithLast(now, { userDir: TMP })
  eq('★★ 通过数 156 → 154 被判为退化', c.hasRegression, true)
  const reg = (c.regressions || []).find((x) => x.kind === 'fewer-passed')
  chk('  带上了数字', !!reg && reg.from === 156 && reg.to === 154, JSON.stringify(reg))
  chk('  摘要可读', /通过数下降/.test(String(c.summary)), c.summary)
  eq('  并记下"上次是什么时候"', c.since, 1000)

  // ★ 默认不推进基线：再比一次结论应当**一样**
  const c2 = compareWithLast(now, { userDir: TMP })
  eq('★★ 不显式 save 时基线不动（结论可复现）', c2.hasRegression, true)
  eq('  仍是同一条退化', (c2.regressions || [])[0].kind, 'fewer-passed')
}

console.log('\n=== ③ 状态变差 / 变好 / 新增失败 ===')
{
  const T2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ph3q-r2-'))
  compareWithLast([r('构建', 'PASS', 1, 0)], { userDir: T2, save: true })
  const worse = compareWithLast([r('构建', 'FAIL', 0, 1)], { userDir: T2 })
  chk('★ PASS → FAIL 判为退化', worse.hasRegression === true, JSON.stringify(worse.regressions))
  chk('  且给出方向', /PASS → FAIL/.test(JSON.stringify(worse.regressions)), JSON.stringify(worse.regressions))

  const better = compareWithLast([r('构建', 'PASS', 5, 0)], { userDir: T2 })
  eq('FAIL → PASS 不算退化', better.hasRegression, false)
  chk('  而且算改进', (better.improvements || []).length >= 1, String((better.improvements || []).length))

  const T3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ph3q-r3-'))
  compareWithLast([r('构建', 'PASS', 1, 0)], { userDir: T3, save: true })
  const added = compareWithLast([r('构建', 'PASS', 1, 0), r('新测试', 'FAIL', 0, 3)], { userDir: T3 })
  chk('★ 新出现的失败项也算退化', added.hasRegression === true, JSON.stringify(added.regressions))
  chk('  标明是新增项即失败', /新增项即失败/.test(JSON.stringify(added.regressions)), JSON.stringify(added.regressions))
}

console.log('\n=== ④ 只存"可比的最小集合"（不把 detail 全文写进用户目录）===')
{
  const T4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ph3q-r4-'))
  compareWithLast([
    { name: 'x', state: 'PASS', passed: 1, failed: 0, detail: '很长的细节'.repeat(200), file: 'C:/a/b.mbt' },
  ], { userDir: T4, save: true })
  const raw = fs.readFileSync(lastSnapshotFile(T4), 'utf8')
  chk('★ 落盘里没有 detail 全文', raw.indexOf('很长的细节') < 0, String(raw.length))
  chk('  也没有 file 路径', raw.indexOf('b.mbt') < 0)
  chk('  只留 name/state/passed/failed', /"name":"x"/.test(raw) && /"state":"PASS"/.test(raw) && /"passed":1/.test(raw), raw.slice(0, 160))
  chk('★ 落盘很小（没被 detail 撑大）', raw.length < 300, String(raw.length))
}

console.log('\n=== ⑤ 存不下来也不能影响结论（如实报）===')
{
  // 用一个不可能写入的路径当 userDir
  const bad = compareWithLast([r('a', 'PASS', 1, 0)], { userDir: '\\\\?\\invalid\\nope', save: true })
  chk('★ 依然给出结论', typeof bad.hasRegression === 'boolean', JSON.stringify(bad).slice(0, 80))
  eq('  saved 如实为 false', bad.saved, false)
  chk('  且带出失败原因', !!bad.saveError, String(bad.saveError).slice(0, 60))
  eq('  没有基线时仍是 first', bad.first, true)
}

console.log('\n=== ⑥ 清理（不留临时目录）===')
{
  let ok = true
  for (const d of [TMP]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) { ok = false } }
  chk('临时目录已清理', ok && !fs.existsSync(TMP))
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
