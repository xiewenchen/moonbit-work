// PH3-UI：信息架构 —— 三层显示 / 入口计数 / 状态摘要（Problem / Quality / Backend）。
//
// 清单 §12 要的不是"加功能"，而是**减少视觉竞争**：
//   核心（用户天天用）／辅助（按需）／工具（少数时候）
// 这一层是**纯逻辑**（分层判定 + 摘要文本），DOM 注入在 renderer 里做 ——
// 这样"分得对不对"可以直接测，不用开窗口。
//
// ⚠️ 整个文件包在 IIFE 里：它会被 index.html 当**全局脚本**加载，
//    顶层 const 污染全局就会与别的脚本撞名（workspace.js 刚栽过这个）。
(function () {
'use strict'

/**
 * PH3-UI-03/04/05：三层定义。
 * ⚠️ `tier` 是**谁**：core=每天用；support=按需；tool=偶尔。
 *    排序与视觉都要按它来 —— 现在的问题不是"功能不够"，是**什么都一样显眼**。
 */
const TIER = Object.freeze({ CORE: 'core', SUPPORT: 'support', TOOL: 'tool' })

const ENTRIES = Object.freeze([
  // ── 核心：清单 §12 点名的五条用户路径
  { id: 'home', label: '首页', tier: TIER.CORE, isTab: true, why: '新项目 / 最近项目（清单：Open Project）' },
  { id: 'project', label: '项目', tier: TIER.CORE, isTab: true, why: '改代码 / 存盘 / 检查（清单：Work）' },
  { id: 'ai', label: 'AI Agent', tier: TIER.CORE, isTab: true, why: '问 Agent / 让它修（清单：Ask Agent）' },
  // 运行与测试在主视觉里，但它们不是"标签"而是**项目页上的动作**，所以不进一级标签
  { id: 'run', label: '运行', tier: TIER.CORE, isTab: false, why: '清单：Run' },
  { id: 'test', label: '测试', tier: TIER.CORE, isTab: false, why: '清单：Test' },

  // ── 辅助：按需打开，平时不该抢视觉
  { id: 'backend', label: '后端', tier: TIER.SUPPORT, isTab: false, why: '起停 / 健康 / 日志' },
  { id: 'database', label: '数据库', tier: TIER.SUPPORT, isTab: false, why: '只读查询 / 表结构' },
  { id: 'quality', label: '工程状态', tier: TIER.SUPPORT, isTab: false, why: '构建/测试/安全的聚合结论' },
  { id: 'workbench', label: '工作台', tier: TIER.SUPPORT, isTab: false, why: '待办 / 便签 / 最近项目' },

  // ── 工具：偶尔用
  { id: 'agent', label: '文件中转站', tier: TIER.TOOL, isTab: true, why: '文件备份 / 预览（清单 §20：Files）' },
  { id: 'tools', label: '工具', tier: TIER.TOOL, isTab: true, why: '其余面板的入口' },
])

function tabsOf() { return ENTRIES.filter((e) => e.isTab) }
function byTier(t) { return ENTRIES.filter((e) => e.tier === t) }

/**
 * PH3-UI-05：按三层排出显示顺序与建议的视觉权重。
 * ⚠️ 权重是**给界面用的数字**（0 最显眼），不是"重要性评分"。
 */
function layout() {
  const order = [TIER.CORE, TIER.SUPPORT, TIER.TOOL]
  const weight = { core: 0, support: 1, tool: 2 }
  return order.map((t) => ({
    tier: t, weight: weight[t],
    entries: ENTRIES.filter((e) => e.tier === t),
  }))
}

/** PH3-UI-02：一级入口统计（只有 isTab 的才是"一级"）。 */
function summarizeStructure() {
  const tabs = tabsOf()
  return {
    tabs: tabs.map((e) => e.id),
    tabCount: tabs.length,
    coreCount: byTier(TIER.CORE).length,
    supportCount: byTier(TIER.SUPPORT).length,
    toolCount: byTier(TIER.TOOL).length,
    // 清单要求一级核心是"Open Project / Work / Ask Agent / Run / Test" —— 这里核对
    coreIds: byTier(TIER.CORE).map((e) => e.id),
    note: '一级标签是 home/project/ai/agent/tools；Run 与 Test 放在项目页的动作里，不占标签栏',
  }
}

/**
 * PH3-UI-08：Problem 入口的计数文本。
 * ⚠️ 没有问题时**不显示 "0"** —— 那个红点数字天天挂着反而是噪音。
 *    返回 null 表示"不该显示徽标"。
 */
function problemBadge(problems) {
  const list = Array.isArray(problems) ? problems.filter(Boolean) : []
  if (!list.length) return null
  const errors = list.filter((p) => p.severity === 'error').length
  const warns = list.filter((p) => p.severity === 'warning' || p.severity === 'warn').length
  const other = list.length - errors - warns
  const text = String(list.length)
  return {
    count: list.length, errors, warns, other, text,
    // 有 error 才算"要处理"；只有 warning 时不该用同一个红点
    level: errors > 0 ? 'error' : (warns > 0 ? 'warn' : 'info'),
    title: list.length + ' 个问题（错误 ' + errors + ' / 警告 ' + warns + (other ? ' / 其它 ' + other : '') + '）',
  }
}

/**
 * PH3-UI-09：Quality 状态摘要（一行字）。
 * ⚠️ 复用事实层的三态语义：**没跑过 ≠ 失败**，"过期"也要说清。
 */
function qualityBadge(fact) {
  const f = fact || {}
  const zh = { PASS: '通过', FAIL: '失败', WARN: '警告', SKIP: '跳过', NOT_RUN: '未运行', STALE: '已过期' }
  if (!f.overall) return { level: 'unknown', text: '状态未知', title: '还没有工程状态数据' }
  const level = f.overall === 'PASS' ? 'ok' : (f.overall === 'FAIL' ? 'error' : (f.overall === 'STALE' ? 'warn' : 'info'))
  return {
    level, overall: f.overall, staleCount: f.staleCount || 0,
    text: zh[f.overall] || f.overall,
    title: '工程状态：' + (zh[f.overall] || f.overall) +
      (f.staleCount ? '（' + f.staleCount + ' 项已过期）' : '') +
      (f.canProceed ? ('　｜ ' + (f.canProceed.ok ? '可以继续' : String(f.canProceed.reason))) : ''),
  }
}

/**
 * PH3-UI-10：Backend 状态摘要。
 * ⚠️ `DEGRADED`（进程在但不健康）要有自己的说法，不能混进 RUNNING 或 FAILED。
 */
function backendBadge(health, state) {
  const h = health || {}
  const zh = { STOPPED: '未启动', STARTING: '启动中', RUNNING: '运行中', DEGRADED: '不健康', FAILED: '失败' }
  const st = state || (h.ok === true ? 'RUNNING' : (h.probed === false ? 'STOPPED' : (h.url ? 'DEGRADED' : 'STOPPED')))
  const level = st === 'RUNNING' ? 'ok' : (st === 'FAILED' || st === 'DEGRADED' ? 'warn' : 'info')
  return {
    state: st, level,
    text: zh[st] || st,
    title: '后端：' + (zh[st] || st) + (h.port ? ('（端口 ' + h.port + '）') : '') + (h.error ? ('　｜ ' + String(h.error).slice(0, 80)) : ''),
  }
}

/** PH3-UI-11：工作台入口不该抢主视觉 —— 给出它的建议权重（与工具层同级）。 */
function workbenchPlacement() {
  const e = ENTRIES.find((x) => x.id === 'workbench')
  return { tier: e ? e.tier : TIER.SUPPORT, weight: e && e.tier === TIER.SUPPORT ? 1 : 2, reason: '工作台是辅助面板，不该占一级标签' }
}

const API = {
  TIER, ENTRIES, tabsOf, byTier, layout, summarizeStructure,
  problemBadge, qualityBadge, backendBadge, workbenchPlacement,
}

if (typeof module !== 'undefined' && module.exports) module.exports = API
if (typeof window !== 'undefined') window.moonbitUiHierarchy = API
})()
