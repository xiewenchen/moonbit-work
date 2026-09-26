// ⚠️ 整个文件包在 IIFE 里：本文件会被 index.html 用 <script> 当**全局脚本**加载，
//    顶层的 const（SUBSYSTEMS / normalizeRoot / joinPath …）会污染全局作用域，
//    与 renderer.js 等其它脚本撞名就会**静默改变行为**（当年 project-context.js 就是这样才改成 IIFE 的）。
//    所以：对外只留 window.moonbitWorkspace（浏览器）与 module.exports（Node）。
(function () {
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

// ⚠️ 双环境：Node（主进程/测试）与浏览器（renderer 走 <script> 注入）。
// renderer 不能 require 本地文件，所以导出必须挂到 window（与 project-context.js 同法）。
// 也**不能 require('path')** —— 浏览器里没有它，所以下面手写一个 join。
const joinPath = (a, b) => {
  const x = String(a == null ? '' : a).replace(/[\\/]+$/, '')
  const y = String(b == null ? '' : b).replace(/^[\\/]+/, '')
  return x ? (x + '/' + y) : y
}

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
  // ★ 大小写：Windows 不敏感（`C:\Users\me\Proj` 与 `c:\users\me\proj` **是同一个目录**），
  //   Linux/Mac 敏感。所以整条路径是否小写要**按平台**定 ——
  //   一刀切会要么在 Windows 上算成两个身份、要么在 Linux 上把两个真不同的目录当成一个。
  //
  // ⚠️ 也**不能直接读 `process.platform`**：renderer 是浏览器环境，没有 process
  //   （与"不能直接写 module.exports"是同一类宿主对象问题）。
  //   ★ 更严重的是：如果浏览器里 fallback 到"大小写敏感"，**同一台机器上主进程与 renderer
  //     会给同一个目录算出两个身份** —— 那"按项目隔离"就彻底失效了。所以必须把平台推出来：
  //     先看 process，再看 navigator（浏览器里它一定在）。
  const isWin = opts.caseInsensitive === undefined
    ? (typeof process !== 'undefined'
        ? process.platform === 'win32'
        : /Windows|Win32|Win64/i.test(String((typeof navigator !== 'undefined' && (navigator.userAgent || navigator.platform)) || '')))
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
 * PH3-WS-02/03～10：各子系统的绑定表 —— 它们**应该**都挂在同一个 workspace 上。
 *
 * ⚠️ `key` 是**各子系统实际使用的字段名**（从真实存储里核过，不是猜的）：
 *    建这一层时我先按印象写了 projectRoot，实际 `workbench.json` 用的是 **`root`** ——
 *    键名写错会让一致性检查永远报 missing，等于没检查。
 *    `path` 是读取该字段的点号路径；`scope` 说明它存在哪里。
 */
const SUBSYSTEMS = Object.freeze([
  // workbench.json: { recent:[{root}], todos:{[root]:[]}, notes:{[root]:''} }
  { name: 'workbench(todo/notes)', key: 'root', path: 'workbench.recent', scope: 'user-dir' },
  // sessions: { id, projectRoot, ... }
  { name: 'agent-session', key: 'projectRoot', path: 'session.projectRoot', scope: 'user-dir' },
  // 项目内的 .moonbit-work/（存在项目里，与上面几个相反）
  { name: 'project-memory', key: '.moonbit-work', path: 'memory.layout', scope: 'in-project' },
  // office-links.json: { [projectRoot]: [...] }
  { name: 'office-links', key: 'projectRoot', path: 'office.projectRoot', scope: 'user-dir' },
  // 以下三者是**运行时**的（不持久化“属于哪个项目”，而是从当前 root 推出）
  { name: 'backend', key: 'root', path: '(runtime)', scope: 'runtime' },
  { name: 'database', key: 'root', path: '(runtime)', scope: 'runtime' },
  { name: 'quality', key: 'project', path: '(derived)', scope: 'derived' },
  { name: 'file-relay', key: 'src', path: '(per-file)', scope: 'per-file' },
])

/**
 * 从**真实存储数据**里抽出各子系统绑的项目。
 *
 * 用途：一致性自检不能只看“有没有传参”，要看**磁盘上真的记了什么**。
 * ⚠️ 每个子系统只取一个代表（如最近项目 / 最近会话），因为“哪个是当前”本来就由调用方决定。
 */
function bindingsFrom(data = {}) {
  const d = data || {}
  const out = {}
  const wb = d.workbench
  if (wb && Array.isArray(wb.recent) && wb.recent.length) out['workbench(todo/notes)'] = wb.recent[0].root || wb.recent[0].projectRoot || null
  const se = d.session
  if (se && (se.projectRoot || se.root)) out['agent-session'] = se.projectRoot || se.root
  const of = d.office
  if (of && of.projectRoot) out['office-links'] = of.projectRoot
  // memory / backend / database / quality 是“从 root 推”的，不单独记源
  return out
}

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
    { p: joinPath(proj, '.moonbit-work'), kind: 'in-project', what: '项目记忆 / Agent 规则 / 上下文' },
    { p: joinPath(home, 'workbench.json'), kind: 'user-dir', what: '最近项目 / 待办 / 便签' },
    { p: joinPath(home, 'startup.json'), kind: 'user-dir', what: '启动快照' },
    { p: joinPath(home, 'office-links.json'), kind: 'user-dir', what: '办公文件关联' },
    { p: joinPath(home, 'providers.json'), kind: 'user-dir', what: 'Provider（含 Key）' },
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

// ⚠️ 双环境导出必须**条件化**：浏览器里没有 `module`，直接写 `module.exports = {…}`
// 会抛 "module is not defined"，**整个文件加载失败**（于是 window.moonbitWorkspace 是 undefined）。
// project-context.js 当年也是栽在这里才改成 IIFE/条件导出的。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUBSYSTEMS, normalizeRoot, workspaceIdOf, isSameWorkspace,
    checkBinding, bindingsFrom, metadataPaths, deletePlan, describeWorkspace,
  }
}

// 浏览器：挂全局（renderer 用 <script src="./workspace.js"> 注入，拿 window.moonbitWorkspace）
if (typeof window !== 'undefined') {
  window.moonbitWorkspace = {
    SUBSYSTEMS, normalizeRoot, workspaceIdOf, isSameWorkspace,
    checkBinding, bindingsFrom, metadataPaths, deletePlan, describeWorkspace,
  }
}
})()
