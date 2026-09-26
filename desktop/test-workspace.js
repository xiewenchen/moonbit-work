// PH3-WS 的验证：工作空间身份 / 一致性 / 删除只删元数据。
//
// 纯逻辑，可进 CI。
const { createHarness } = require('./verify-harness')
const {
  SUBSYSTEMS, normalizeRoot, workspaceIdOf, isSameWorkspace,
  checkBinding, metadataPaths, deletePlan, describeWorkspace,
} = require('./workspace')

const H = createHarness()
const { chk, eq } = H

// 测试统一用 Windows 语义（注入平台）—— 这样在任何 CI 上行为一致，
// 也顺带证明"平台可注入"是这层的设计而不是 assume。
const WIN = { caseInsensitive: true }

console.log('=== ① PH3-WS-01 规范化：同一目录不能算出两个身份 ===')
{
  // 这是本层存在的最主要理由：Windows 上这些写法指向**同一个目录**
  const win = 'C:\\Users\\me\\Proj'
  const variants = [
    'C:\\Users\\me\\Proj\\',
    'c:\\users\\me\\proj',
    'C:/Users/me/Proj',
    'C:/Users/me/Proj/',
    'c:/Users/me/Proj',
  ]
  for (const v of variants) {
    chk('★ ' + JSON.stringify(v) + ' 与基准同身份', isSameWorkspace(win, v, WIN), normalizeRoot(v))
  }
  chk('★ id 也一致（不是只有比较函数对）', workspaceIdOf(win, WIN) === workspaceIdOf('c:/users/me/proj', WIN), workspaceIdOf(win))

  // 不同目录当然不能同身份
  chk('不同目录 → 不同身份', isSameWorkspace('C:/a/b', 'C:/a/bc', WIN) === false)
  chk('  （前缀相同但不是同一层，不能误判）', isSameWorkspace('C:/a/b', 'C:/a/b/c', WIN) === false)

  // 盘符大小写只影响盘符本身
  eq('已规范化（Windows：整条小写）', normalizeRoot('C:\\A\\.\\B\\', WIN), 'c:/a/b')
  // ★ 平台是**注入**的：换成大小写敏感的语义，`A` 与 `a` 就是两个不同目录 ——
  //   一刀切（永远小写）在 Linux 上会把两个真不同的目录当成同一个。
  eq('★ 大小写敏感语义下保留原样（只小写盘符）', normalizeRoot('C:/A/B', { caseInsensitive: false }), 'c:/A/B')
  chk('★ 于是 Linux 上 A 与 a 是不同工作空间',
    isSameWorkspace('/home/me/Proj', '/home/me/proj', { caseInsensitive: false }) === false)
  chk('  而 Windows 上是同一个',
    isSameWorkspace('/home/me/Proj', '/home/me/proj', WIN) === true)
  eq('空输入 → 空', normalizeRoot('', WIN), '')
  eq('null → 空（不炸）', normalizeRoot(null, WIN), '')
  eq('没有 root → 没有 id（不编一个）', workspaceIdOf('', WIN), null)
}

console.log('\n=== ② PH3-WS-02 各子系统绑定表 ===')
{
  chk('列出了子系统', SUBSYSTEMS.length >= 6, String(SUBSYSTEMS.length))
  chk('  每个都标了它用的键名', SUBSYSTEMS.every((s) => s.key && s.name))
  chk('  workbench 用的是 projectRoot（现状）', SUBSYSTEMS.find((s) => /workbench/.test(s.name)).key === 'projectRoot')
}

console.log('\n=== ③ 一致性检查：谁没绑在同一个工作空间上 ===')
{
  const root = 'C:/proj'
  // 全部一致（注意大小写/斜杠不同也算一致 —— 这正是规范化的意义）
  const good = checkBinding(root, {
    'workbench(todo/notes)': 'C:\\proj\\',
    'agent-session': 'c:/proj',
    'project-memory': 'C:/proj',
    backend: 'C:/proj',
    database: 'C:/proj',
    quality: 'c:/PROJ',
  }, WIN)
  eq('★ 全一致', good.consistent, true)
  chk('  摘要如实说一致', /同一个工作空间/.test(good.summary), good.summary)
  eq('  工作空间 id', good.workspaceId, 'ws:c:/proj')

  // 有一个绑到别处 → 必须报出来
  const bad = checkBinding(root, {
    'workbench(todo/notes)': 'C:/proj',
    'agent-session': 'C:/other-project',
    'project-memory': 'C:/proj',
  }, WIN)
  eq('★ 不一致被抓到', bad.consistent, false)
  chk('  点出是哪个子系统', /agent-session/.test(bad.summary), bad.summary)
  eq('  且给出它实际绑到了哪', bad.mismatched[0].got, 'C:/other-project')

  // 没给值的记 missing（不是 mismatch —— "没接线"与"接错了"是两回事）
  chk('缺的记 missing', bad.missing.length > 0, JSON.stringify(bad.missing))
  chk('  missing 不算 mismatch', bad.mismatched.length === 1, String(bad.mismatched.length))

  // file-relay 天生按文件记，不算不一致
  const relay = checkBinding(root, { 'file-relay': 'C:/some/file.docx' }, WIN)
  eq('★ file-relay 不当成不一致', relay.mismatched.length, 0)
  chk('  但也如实标注它是按文件记的', relay.ok.some((o) => /按文件/.test(o.note || '')), JSON.stringify(relay.ok))
}

console.log('\n=== ④ PH3-WS-11 删除计划：只删元数据（最关键的一条）===')
{
  const plan = deletePlan('C:/proj', 'C:/Users/me', WIN)
  eq('能生成计划', plan.ok, true)
  chk('有若干条元数据', plan.count >= 4, String(plan.count))
  chk('★ 明确声明不碰源码', /项目源码/.test(plan.neverTouches), plan.neverTouches)

  // ★ 硬断言：计划里**任何一条都不等于**项目根，也不包含源码文件
  for (const it of plan.items) {
    chk('★ 不是项目根本身：' + it.what, normalizeRoot(it.p, WIN) !== 'c:/proj', it.p)
    chk('  不是源码文件（.mbt/.json 之类）', !/\.mbt$/.test(it.p), it.p)
  }
  // 项目内的那条只能是 .moonbit-work
  const inProj = plan.items.filter((i) => i.kind === 'in-project')
  eq('项目内只允许一条', inProj.length, 1)
  chk('★ 且必须就是 .moonbit-work', /[\\/]\.moonbit-work$/.test(inProj[0].p), inProj[0].p)

  // 元数据位置表本身也要过一遍同样的断言
  for (const m of metadataPaths('C:/proj', 'C:/Users/me')) {
    const n = normalizeRoot(m.p)
    if (m.kind === 'user-dir') chk('用户目录的条目不在项目里：' + m.what, !n.startsWith('c:/proj/'), n)
  }
}

console.log('\n=== ⑤ PH3-WS-11 危险输入必须拒绝（否则会变成"删整个盘"）===')
{
  eq('空 root → 拒绝', deletePlan('', 'C:/u', WIN).ok, false)
  eq('null → 拒绝', deletePlan(null, 'C:/u', WIN).ok, false)
  const drive = deletePlan('C:/', 'C:/u', WIN)
  eq('★ 盘符根 → 拒绝', drive.ok, false)
  chk('  说明为什么', /盘/.test(String(drive.error)), String(drive.error))
  const unixRoot = deletePlan('/', '/home/me')
  eq('★ 文件系统根 → 拒绝', unixRoot.ok, false)

  // 用户目录放到项目里 → 可疑，拒绝
  const weird = deletePlan('C:/proj', 'C:/proj', WIN)
  eq('★ 用户目录 = 项目目录 → 拒绝（位置异常）', weird.ok, false)
  chk('  说明原因', /位置异常|源码目录/.test(String(weird.error)), String(weird.error))
}

console.log('\n=== ⑥ describeWorkspace 可读 ===')
{
  eq('没项目 → 明确说（不编一个）', describeWorkspace('', null, WIN), '（没有打开项目）')
  const d = describeWorkspace('C:/proj', { 'workbench(todo/notes)': 'C:/proj', 'agent-session': 'C:/nope' }, WIN)
  chk('带工作空间 id', /ws:c:\/proj/.test(d), d)
  chk('说不一致的地方', /agent-session/.test(d), d)
  const d2 = describeWorkspace('C:/proj', { 'workbench(todo/notes)': 'C:/proj' }, WIN)
  chk('一致时如实说一致', /各子系统一致/.test(d2), d2)
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
