// PH3-WS：项目工作空间 —— 让 IDE / Agent / Session / Memory / Backend / Database / Quality
// 围绕**同一个** Workspace 运作（Gate G2）。
//
// 这一层要解决的具体问题：
//   · 各子系统现在各自用 `rootDir` / `projectRoot` / `path.resolve(dir,'..')` 当键 ——
//     **同一个项目如果规范化方式不同，就会算出两个身份**，于是"按项目隔离"在某些写法下失效。
//   · 用户/Agent 需要能问"这个工作空间里都有什么"。
//   · 删除必须**只删元数据**，绝不碰源码（WS-11，这是最危险的一条）。
//
// 纯逻辑、全依赖注入 —— 可进 CI。

const path = require('path')

/**
 * PH3-WS-01：工作空间的稳定身份。
 *
 * ⚠️ 规范化是这一层的**核心价值**，不是小事：
 *   Windows 上 `C:\Proj` 与 `c:/proj` 是同一个目录，但字符串不同；
 *   末尾斜杠、`..`、混合分隔符也会造成差异。
 *   如果不统一，`workbench` 与 `session` 可能对**同一个项目**用**两个键**，
 *   表现就是"待办还在、会话没了"这种说不清的 bug。
 */
function normalizeRoot(root, opts = {}) {
  const s = String(root == null ? '' : root).trim()
  if (!s) return ''
  let p = s.replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows 盘符统一成小写
  const isWin = opts.caseInsensitive === undefined
    ? process.platform === 'win32'
    : opts.caseInsensitive === true
  if (/^[A-Za-z]:/.test(p)) p = p[0].toLowerCase() + p.slice(1)
  // ★ 大小写：Windows 不敏感（`C:\Users\me\Proj` 与 `c:\users\me\proj` **是同一个目录**），
  //   Linux/Mac 敏感。所以整条路径是否小写要**按平台**定 ——
  //   一刀切会要么在 Windows 上算成两个身份、要么在 Linux 上把两个真不同的目录当成一个。
  if (isWin) p = p.toLowerCase()
  // 去掉 `./` 与折叠 `a/./b`；不做 realpath（要它就得碰磁盘，交给调用方）
  p = p.replace(/\/\.\//g, '/').replace(/\/\.$/, '')
  return p
}

/** 工作空间 id：可读、稳定、可比较。不掺时间/随机数（否则每次算出来都不一样就没意义了）。 */
function workspaceIdOf(root, opts) {
  const n = normalizeRoot(root, opts)
  if (!n) return null
  // 人可读 + 稳定：取规范化路径本身。用它比哈希更利于排查（日志里能看出是哪个项目）。
  return 'ws:' + n
}

/** 两个 root 是不是同一个工作空间（用规范化后的结果比，而不是原字符串）。 */
function isSameWorkspace(a, b, opts) {
  const na = normalizeRoot(a, opts); const nb = normalizeRoot(b, opts)
  if (!na || !nb) return false
  return na === nb
}

/**
 * PH3-WS-02：各子系统的绑定表 —— 它们**应该**都挂在同一个 workspace 上。
 * 这里的 `key` 就是各子系统实际使用的字段名（现状，不是理想）。
 */
const SUBSYSTEMS = Object.freeze([
  { name: 'workbench(todo/notes)', key: 'projectRoot', scope: 'user-dir' },
  { name: 'agent-session', key: 'projectRoot', scope: 'user-dir' },
  { name: 'project-memory', key: 'projectRoot', scope: 'in-project' },
  { name: 'backend', key: 'root', scope: 'runtime' },
  { name: 'database', key: 'root', scope: 'runtime' },
  { name: 'quality', key: 'project', scope: 'derived' },
  { name: 'file-relay', key: 'src', scope: 'per-file' },
])

/**
 * PH3-WS：一致性检查 —— 把"各子系统给的键"与"当前工作空间"比一遍。
 * ⚠️ 它**不修**任何东西，只回答"谁没绑在同一个工作空间上"。
 *    file-relay 天生是按文件记的（一个文件属于哪个项目是另一回事），单列出来不当作不一致。
 */
function checkBinding(root, given, opts) {
  const id = workspaceIdOf(root, opts)
  // ⚠️ 默认参数 `given = {}` 对 **null** 不生效（只有 undefined 才触发）—— 与
  //    agent-task.js 的 recoverInterrupted(null) 是**同一个坑**，那里也已经栽过一次。
  const g = (given && typeof given === 'object') ? given : {}
  const ok = []; const mismatched = []; const missing = []
  for (const sub of SUBSYSTEMS) {
    const v = g[sub.name]
    if (v == null || v === '') { missing.push(sub.name); continue }
    if (sub.scope === 'per-file') { ok.push({ name: sub.name, note: '按文件记录（不经工作空间键）' }); continue }
    if (isSameWorkspace(root, v, opts)) ok.push({ name: sub.name, key: sub.key })
    else mismatched.push({ name: sub.name, key: sub.key, got: String(v), want: String(root) })
  }
  return {
    workspaceId: id,
    ok, mismatched, missing,
    consistent: mismatched.length === 0,
    summary: mismatched.length
      ? (mismatched.length + ' 个子系统绑到了别的工作空间：' + mismatched.map((m) => m.name).join('、'))
      : '所有子系统都绑在同一个工作空间上',
  }
}

/**
 * PH3-WS-10/11：工作空间的**元数据**位置。
 * 一条铁律：**元数据在用户目录或项目的 .moonbit-work/ 里，源码在项目根**。
 * 所以删除计划里**永远不出现**源码路径 —— 见 deletePlan 的断言。
 */
function metadataPaths(root, userDir) {
  const proj = String(root || '')
  const home = String(userDir || '')
  return [
    { p: path.join(proj, '.moonbit-work'), kind: 'in-project', what: '项目记忆 / Agent 规则 / 上下文' },
    { p: path.join(home, 'workbench.json'), kind: 'user-dir', what: '最近项目 / 待办 / 便签' },
    { p: path.join(home, 'startup.json'), kind: 'user-dir', what: '启动快照' },
    { p: path.join(home, 'office-links.json'), kind: 'user-dir', what: '办公文件关联' },
    { p: path.join(home, 'providers.json'), kind: 'user-dir', what: 'Provider（含 Key）' },
  ]
}

/**
 * PH3-WS-11：删除计划 —— **只删元数据**。
 *
 * ⚠️ 三道保险，缺一不可：
 *   ① 只列上面那张表里的路径（白名单，不是"扫出来的"）；
 *   ② 逐条断言"它不在项目源码里"（除非是 `.moonbit-work`）；
 *   ③ 拒绝 root 为空 / 是根目录 / 是盘符根 —— 那会变成"删整个盘"。
 */
function deletePlan(root, userDir, opts) {
  const proj = normalizeRoot(root, opts)
  if (!proj) return { ok: false, error: '没有工作空间，拒绝生成删除计划' }
  if (/^[a-z]:$/.test(proj) || proj === '/' || proj === '') {
    return { ok: false, error: '拒绝：root 是盘符根/文件系统根，删除它等于删整块盘' }
  }
  const items = metadataPaths(root, userDir).map((m) => Object.assign({}, m, { keepSource: true }))
  // ② 断言：除了 `.moonbit-work`，其余都不许落在项目目录内
  const offenders = items.filter((m) => {
    const n = normalizeRoot(m.p, opts)
    if (m.kind === 'in-project') return !n.startsWith(proj + '/')
    return n.startsWith(proj + '/')   // 用户目录的条目落在项目里 → 可疑
  })
  if (offenders.length) {
    return { ok: false, error: '拒绝：有元数据路径落在项目源码目录内或位置异常：' + offenders.map((o) => o.p).join(', ') }
  }
  return {
    ok: true,
    workspaceId: workspaceIdOf(root, opts),
    items,
    neverTouches: '项目源码、git 仓库、构建产物 —— 都不在删除计划里',
    count: items.length,
  }
}

/** 可读描述。 */
function describeWorkspace(root, given, opts) {
  const c = checkBinding(root, given, opts)
  const id = workspaceIdOf(root, opts)
  if (!id) return '（没有打开项目）'
  return '工作空间 ' + id + '　｜ ' + (c.consistent ? '各子系统一致' : c.summary)
}

module.exports = {
  SUBSYSTEMS, normalizeRoot, workspaceIdOf, isSameWorkspace,
  checkBinding, metadataPaths, deletePlan, describeWorkspace,
}
