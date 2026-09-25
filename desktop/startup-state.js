'use strict'

/**
 * 产品化基础：启动恢复 / 异常退出恢复 / 环境检查（Phase 2.1 / P20-07、P20-08、P20-09）
 *
 * 三件事，都是"应用启动那一下"要用的东西：
 *
 *   P20-07 启动恢复    上次打开的 project / 标签 / 当前文件 —— 存下来，下次恢复
 *   P20-08 异常退出恢复 正常退出会清掉"运行中"标记；如果启动时发现标记还在，
 *                      说明上次是**异常退出**（崩溃/强杀），这时不该盲目恢复，而要告诉用户
 *   P20-09 环境检查    Moon / Node / Git / Docker / Agent 各自在不在 —— **只报事实**
 *
 * 设计原则：
 *   · 恢复的是"位置"，不是"内容"（当前文件、打开的标签、项目根路径）；
 *   · **异常退出时降级**：只恢复项目，不恢复一堆标签 —— 崩过一次就不要把现场原样搬回来；
 *   · 环境检查**绝不假装**：探不到就是"未检测到"，并给出可执行建议（而不是一句"环境异常"）。
 *
 * 纯逻辑、零依赖（探测能力注入），可直接进 CI。
 */

const STARTUP_LIMITS = Object.freeze({
  maxTabs: 20,
  maxFileChars: 400,
})

function nowDefault() { return Date.now() }
function s(v) { const x = String(v == null ? '' : v).trim(); return x || null }

/** P20-07：一次"运行快照"（应用关闭/定期保存时写，启动时读）*/
function createSnapshot(input = {}) {
  const tabs = (Array.isArray(input.tabs) ? input.tabs : [])
    .map((t) => s(t))
    .filter(Boolean)
    .slice(0, STARTUP_LIMITS.maxTabs)
  return Object.freeze({
    version: 1,
    projectRoot: s(input.projectRoot),
    projectType: s(input.projectType),
    tabs: Object.freeze(tabs),
    activeFile: s(input.activeFile),
    // ★ 运行中标记：正常退出会清掉它（见 clearRunning）。启动时它还在 = 上次异常退出。
    running: input.running === true,
    cleanExit: input.cleanExit === true,
    at: Number.isFinite(input.at) ? input.at : nowDefault(),
  })
}

/** 归一（读回磁盘时用；损坏不抛）*/
function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return createSnapshot({})
  return createSnapshot({
    projectRoot: raw.projectRoot, projectType: raw.projectType,
    tabs: raw.tabs, activeFile: raw.activeFile,
    running: raw.running, cleanExit: raw.cleanExit, at: raw.at,
  })
}

/** 应用启动时调：标记"我正在运行"（这样下次若看到它还在，就知道是异常退出）*/
function markRunning(snap, opts = {}) {
  return Object.freeze(Object.assign({}, sanitizeSnapshot(snap), { running: true, cleanExit: false, at: Number.isFinite(opts.now) ? opts.now : nowDefault() }))
}

/** 正常退出时调：清掉运行中标记 —— 这一步没做，就会被判成"异常退出"*/
function markCleanExit(snap, opts = {}) {
  return Object.freeze(Object.assign({}, sanitizeSnapshot(snap), { running: false, cleanExit: true, at: Number.isFinite(opts.now) ? opts.now : nowDefault() }))
}

/** 更新"位置"（打开/切换项目、标签、当前文件时调）*/
function updateSnapshot(snap, patch = {}, opts = {}) {
  const cur = sanitizeSnapshot(snap)
  return createSnapshot(Object.assign({}, cur, patch, {
    running: cur.running,           // 运行标记不由这里改
    cleanExit: cur.cleanExit,
    at: Number.isFinite(opts.now) ? opts.now : nowDefault(),
  }))
}

/**
 * P20-07/08：决定"启动时该怎么恢复"。
 *
 * 三种情况分开处理（这是这段代码唯一真正重要的地方）：
 *   · 没有快照        → 全新启动，什么都不恢复
 *   · 上次正常退出    → 完整恢复（项目 + 标签 + 当前文件）
 *   · **上次异常退出** → 只恢复项目，**标签与当前文件丢掉**，并明确告诉用户为什么
 */
function planStartup(snap, opts = {}) {
  const cur = sanitizeSnapshot(snap)
  if (!cur.projectRoot) {
    return { restore: false, reason: 'first-run', projectRoot: null, tabs: [], activeFile: null, crashed: false, message: '首次启动 —— 没有可恢复的现场。' }
  }
  if (cur.running === true) {
    return {
      restore: true,
      reason: 'after-crash',
      crashed: true,
      projectRoot: cur.projectRoot,
      projectType: cur.projectType,
      tabs: [],                    // ★ 崩过一次，不把现场原样搬回来
      activeFile: null,
      message: '上次没有正常退出（可能是崩溃或被强制结束）。只恢复项目，不恢复打开的标签与文件 —— 免得把不确定的现场再搬回来。',
    }
  }
  return {
    restore: true,
    reason: 'clean-exit',
    crashed: false,
    projectRoot: cur.projectRoot,
    projectType: cur.projectType,
    tabs: cur.tabs.slice(0, STARTUP_LIMITS.maxTabs),
    activeFile: cur.activeFile,
    message: '已恢复上次的工作现场（' + cur.tabs.length + ' 个标签）。',
  }
}

// ── P20-09 环境检查 ─────────────────────────────────────────────────────────
/** 每一项"要检查谁、为什么、缺了怎么办" */
const ENV_CHECKS = Object.freeze([
  { id: 'moon', name: 'MoonBit 工具链', why: '构建/检查/测试 MoonBit 项目', hint: '装 moon 并确保它在 PATH 里；桌面版会自动带上 ~/.moon/bin' },
  { id: 'node', name: 'Node.js', why: '跑 Node 项目、以及 IDE 自己的验证脚本', hint: '装 Node LTS' },
  { id: 'git', name: 'Git', why: '版本控制', hint: '装 Git（Windows 上推荐 Git for Windows）' },
  { id: 'docker', name: 'Docker', why: '后端的 PostgreSQL / Redis 依赖', hint: '装 Docker Desktop；没有它后端一键跑不起来（但不影响读代码）' },
  { id: 'agent', name: 'AI Agent（opencode）', why: '让 Agent 真正执行任务', hint: '在「AI Agent → 配置」里填 Provider 与 Key；或先只装 opencode CLI' },
])

/**
 * 跑一遍环境检查。
 *
 * @param {(id:string) => Promise<{found:boolean, version?:string}>} probe 注入的探测函数
 */
async function checkEnvironment(probe) {
  if (typeof probe !== 'function') throw new Error('checkEnvironment 需要注入 probe')
  const items = []
  for (const c of ENV_CHECKS) {
    let r = null
    try { r = await probe(c.id) } catch (e) { r = { found: false, error: String((e && e.message) || e) } }
    const found = !!(r && r.found === true)
    items.push(Object.freeze({
      id: c.id,
      name: c.name,
      why: c.why,
      found,
      version: (r && r.version) ? String(r.version).slice(0, 80) : null,
      // 探测本身出错 ≠ 没装：要分开说
      error: (r && r.error) ? String(r.error).slice(0, 120) : null,
      hint: found ? null : c.hint,
    }))
  }
  const missing = items.filter((x) => !x.found)
  const errored = items.filter((x) => x.error)
  return Object.freeze({
    ok: missing.length === 0,
    items: Object.freeze(items),
    missingCount: missing.length,
    errorCount: errored.length,
    summary: missing.length === 0
      ? '环境检查通过（' + items.length + ' 项都在）'
      : ('有 ' + missing.length + ' 项没检测到：' + missing.map((x) => x.name).join('、')
        + (errored.length ? '；另有 ' + errored.length + ' 项探测时报了错（与"没装"不是一回事）' : '')),
  })
}

/** 一行摘要（给日志/启动提示用）*/
function describeStartup(plan, env) {
  const p = plan ? ('启动：' + plan.reason + (plan.projectRoot ? '｜项目=' + plan.projectRoot : '')) : '启动：未知'
  const e = env ? ('｜环境：' + (env.ok ? '齐' : ('缺 ' + env.missingCount))) : ''
  return p + e
}

module.exports = {
  STARTUP_LIMITS,
  ENV_CHECKS,
  createSnapshot,
  sanitizeSnapshot,
  markRunning,
  markCleanExit,
  updateSnapshot,
  planStartup,
  checkEnvironment,
  describeStartup,
}
