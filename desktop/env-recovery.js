// PH3-ENV + PH3-REC：环境自愈与启动恢复深化。
//
// 原有 startup-state.js 已有 ENV_CHECKS / markRunning / markCleanExit / planStartup，
// 并且**已经实现"崩过就不搬现场"**。这一层补清单 §13/§14 缺的：
//   · 环境四态（AVAILABLE / MISSING / BROKEN / UNKNOWN）—— 关键是**别把 MISSING 当 ERROR**
//   · PATH 补全（项目历史上真踩过：Git Bash 里 PATH 对、桌面快捷方式里 PATH 错）
//   · 恢复范围：项目 / 标签 / 当前文件 / **滚动位置** / Agent Session
//   · **异常退出不恢复编辑现场**，并且能被**模拟强杀**验证
//
// 纯逻辑、全依赖注入 —— 可进 CI。

/** PH3-ENV-02：环境四态。 */
const ENV_STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE',   // 在，能用
  MISSING: 'MISSING',       // 没装 —— **不是错误**
  BROKEN: 'BROKEN',         // 装了但跑不起来（版本不对/缺依赖）
  UNKNOWN: 'UNKNOWN',       // 没探测
})
const ALL_ENV = Object.freeze(Object.values(ENV_STATE))

/**
 * 由一次探测的结果判断状态。
 * ⚠️ PH3-ENV-03：`MISSING` **不是** `ERROR`。
 *    "没装"是环境事实，"坏了"才是故障 —— 混在一起会让用户以为程序出 bug 了。
 */
function classifyEnv(probe) {
  const p = probe || {}
  if (p.attempted !== true) return { state: ENV_STATE.UNKNOWN, reason: '还没有探测' }
  if (p.found === false) {
    return /not found|未找到|command not found|无法将.*识别为/i.test(String(p.output || ''))
      ? { state: ENV_STATE.MISSING, reason: '没安装（或不在 PATH 里）' }
      : { state: ENV_STATE.MISSING, reason: '探测不到' }
  }
  if (p.found === true && p.ok === false) {
    return { state: ENV_STATE.BROKEN, reason: '装了但跑不起来：' + String(p.error || p.output || '').slice(0, 120) }
  }
  if (p.found === true && p.ok === true) {
    return { state: ENV_STATE.AVAILABLE, version: p.version || null, reason: null }
  }
  return { state: ENV_STATE.UNKNOWN, reason: '探测结果无法判断' }
}

function describeEnv(list) {
  const zh = { AVAILABLE: '可用', MISSING: '未安装', BROKEN: '异常', UNKNOWN: '未探测' }
  const rows = (Array.isArray(list) ? list : []).map((x) => {
    const c = classifyEnv(x.probe)
    return { id: x.id, name: x.name, state: c.state, label: zh[c.state] || c.state, reason: c.reason, version: c.version || null }
  })
  const missing = rows.filter((r) => r.state === ENV_STATE.MISSING)
  const broken = rows.filter((r) => r.state === ENV_STATE.BROKEN)
  return {
    rows,
    // ★ 只有 BROKEN 才是"需要修的环境故障"；MISSING 是"按需安装"
    blocking: broken,
    optional: missing,
    summary: broken.length
      ? ('有 ' + broken.length + ' 项环境异常：' + broken.map((r) => r.name).join('、'))
      : (missing.length ? ('没有环境故障；' + missing.length + ' 项未安装（按需）') : '环境齐备'),
  }
}

/**
 * PH3-ENV-04：PATH 补全建议。
 *
 * 项目历史上真踩过：**Git Bash 里 PATH 正确、桌面快捷方式里 PATH 错误**，
 * 表现是"任何项目都跑不起来"。所以这里不假设 PATH 是对的 ——
 * 缺哪一项就给出**它的候选目录**，让调用方显式补上。
 */
const PATH_CANDIDATES = Object.freeze({
  moon: ['~/.moon/bin', '%USERPROFILE%\\.moon\\bin'],
  node: ['/usr/local/bin', '%ProgramFiles%\\nodejs'],
  git: ['%ProgramFiles%\\Git\\cmd', '/usr/bin'],
  docker: ['%ProgramFiles%\\Docker\\Docker\\resources\\bin'],
  // ⚠️ 这里同时给出两个 key：探测项的 id 是 `agent`（见 startup-state 的 ENV_CHECKS），
  //    而工具本身叫 opencode —— 只写 `opencode` 的话，本机缺 agent 时**界面上一条候选都没有**
  //    （接线真跑才发现：漏的是"缺的项 ['agent']、候选表认识的 []"）。
  //    宁可两个 key 都留：写死一个名字，就会在某次改名后静默失效。
  agent: ['%APPDATA%\\npm', '~/.npm-global/bin'],
  opencode: ['%APPDATA%\\npm', '~/.npm-global/bin'],
})

function pathFixups(envRows) {
  const out = []
  for (const r of Array.isArray(envRows) ? envRows : []) {
    if (!r) continue
    // ⚠️ 两个来源的字段名不一样，这里必须两种都认：
    //    · classifyEnv() 的输出用 { state: ENV_STATE.* }
    //    · checkEnvironment() 的输出用 { found: boolean }（没有 state）
    //    只认 state 的话，把 checkEnvironment 的结果喂进来会**永远返回空**
    //    —— 看起来"没有建议"，实际是判据根本没匹配上（接线时才暴露）。
    const isMissing = (r.state !== undefined)
      ? r.state === ENV_STATE.MISSING
      : (r.found === false && !r.error)   // 探测出错 ≠ 没装，不给 PATH 建议
    if (!isMissing) continue
    const cands = PATH_CANDIDATES[r.id]
    if (cands && cands.length) out.push({ id: r.id, name: r.name, candidates: cands.slice(), note: '先确认这些目录里确实有可执行文件，再加进 PATH' })
  }
  return out
}

// ── PH3-REC：启动恢复深化 ──────────────────────────────────────────────────────

/** PH3-REC-02/03/04/05：要恢复的**现场**有哪些。 */
function captureScene(input = {}) {
  const i = (input && typeof input === 'object') ? input : {}
  const tabs = (Array.isArray(i.tabs) ? i.tabs : []).filter((t) => t && t.path).map((t) => ({
    path: String(t.path),
    // PH3-REC-04：滚动位置也要记（不然恢复完还要自己滚回去）
    scrollTop: Number.isFinite(t.scrollTop) ? t.scrollTop : null,
    cursorLine: Number.isFinite(t.cursorLine) ? t.cursorLine : null,
  }))
  return {
    projectRoot: i.projectRoot || null,
    tabs,
    activeFile: i.activeFile || null,
    // PH3-REC-05：Agent Session 也在恢复范围里（但属于"现场"，崩过不恢复）
    sessionId: i.sessionId || null,
    capturedAt: Number.isFinite(i.at) ? i.at : null,
  }
}

/**
 * PH3-REC-06/07/08/09：由快照决定恢复什么。
 *
 * ★ 这里是整个 Phase 3 里"降级"最要紧的一处：
 *   正常退出 → 恢复完整现场；
 *   异常退出（崩了 / 被强杀）→ **只恢复项目，不搬现场**。
 *
 *   为什么？崩溃往往与被打开的文件内容有关（比如某个文件让语法高亮炸了）。
 *   把现场原样搬回来 = **把崩溃原因一起搬回来**，用户会陷入"一开就崩"。
 *   所以宁可让用户自己再打开一次文件。
 */
function planStartup(snapshot, opts = {}) {
  const s = snapshot || {}
  const crashed = s.cleanExit === false
  const hasScene = !!(s.scene && (s.scene.projectRoot || (s.scene.tabs || []).length))
  if (!s.projectRoot && !hasScene) {
    return { restore: false, reason: 'first-run', projectRoot: null, tabs: [], activeFile: null, scroll: null, sessionId: null, crashed: false, message: '首次启动 —— 没有可恢复的现场。' }
  }
  if (crashed) {
    return {
      restore: true, reason: 'crash-degraded',
      projectRoot: s.projectRoot || (s.scene && s.scene.projectRoot) || null,
      tabs: [], activeFile: null, scroll: null, sessionId: null,
      crashed: true,
      // ★ 明确告诉用户"上次是异常退出，所以没搬现场"，而不是悄悄少恢复几样
      message: '上次异常退出 —— 只恢复项目，**不恢复编辑现场**（避免把崩溃原因一起带回来）。',
    }
  }
  const sc = s.scene || {}
  return {
    restore: true, reason: 'clean',
    projectRoot: sc.projectRoot || s.projectRoot || null,
    tabs: (sc.tabs || []).slice(0, Number.isFinite(opts.maxTabs) ? opts.maxTabs : 20),
    activeFile: sc.activeFile || null,
    scroll: (sc.tabs || []).find((t) => t.path === sc.activeFile) || null,
    sessionId: sc.sessionId || null,
    crashed: false,
    message: '已恢复上次的工作现场（' + (sc.tabs || []).length + ' 个标签）。',
  }
}

/**
 * PH3-REC-07：模拟"被强杀"。
 * 记录成 running 之后**不给** cleanExit —— 下次启动就应当判为异常退出。
 * 这是"异常退出降级"能被**验证**而不是只写在文档里的关键。
 */
function markRunning(snapshot, now) {
  const s = (snapshot && typeof snapshot === 'object') ? snapshot : {}
  return Object.assign({}, s, { running: true, cleanExit: false, startedAt: Number.isFinite(now) ? now : Date.now() })
}

function markCleanExit(snapshot, now) {
  const s = (snapshot && typeof snapshot === 'object') ? snapshot : {}
  return Object.assign({}, s, { running: false, cleanExit: true, endedAt: Number.isFinite(now) ? now : Date.now() })
}

/** 强杀：进程没了，但快照里仍是 running（cleanExit 还是 false）。 */
function simulateKill(snapshot, now) {
  const s = markRunning(snapshot, now)
  return Object.assign({}, s, { killed: true, killedAt: Number.isFinite(now) ? now : Date.now() })
}

module.exports = {
  ENV_STATE, ALL_ENV, PATH_CANDIDATES,
  classifyEnv, describeEnv, pathFixups,
  captureScene, planStartup, markRunning, markCleanExit, simulateKill,
}
