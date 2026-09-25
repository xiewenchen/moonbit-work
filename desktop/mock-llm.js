'use strict'

/**
 * MockLLM —— 让 Agent 的测试**不依赖真实 API 额度**（Phase 2.1 / P9B-04）
 *
 * 清单把这条单列出来是有道理的：只要测试依赖真实额度，它就会变成"偶尔能跑"，
 * 然后就没人跑了 —— 失败场景、无限循环、Patch 这些**最需要被测**的路径首当其冲。
 *
 * 所以 MockLLM 的接口与 `agent-adapter.js` 的 adapter **完全一致**
 * （generate / stream / toolCall / describe）—— 才能被真正替换进去，而不是"另开一套假接口"。
 * 它还带一个 `isMock: true` 标记，让测试能断言"这轮确实没连真网"。
 *
 * 脚本里每一步支持：
 *   { text }                             普通回复
 *   { toolCalls: [{ name, args }] }      要求调工具
 *   { error }                            返回错误（ok:false）
 *   { reject }                           直接抛（模拟网络炸/超时）
 *   { repeat: n }                        这一步重复 n 次
 *   { repeat: 'infinite' }               无限重复 —— 用来测"无限规划必须被预算截断"
 */

function normalizeStep(s) {
  if (s == null) return { text: '' }
  if (typeof s === 'string') return { text: s }
  return s
}

/**
 * @param {Array<object|string>} script 第 n 次调用返回什么
 * @param {{fallback?: object, delayMs?: number, sleep?: (ms:number)=>Promise<any>}} [opts]
 */
function createMockLlm(script = [], opts = {}) {
  const steps = (Array.isArray(script) ? script : []).map(normalizeStep)
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 0
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms))
  const calls = []
  let idx = 0
  let sticky = null            // repeat:'infinite' 的那一步
  const leftMap = new Map()    // 步骤 → 剩余次数（不写在脚本对象上，免得复用脚本时串味）

  function pick() {
    if (sticky) return sticky
    if (idx >= steps.length) return normalizeStep(opts.fallback || { text: '（mock 脚本已用完）' })
    const s = steps[idx]
    if (s.repeat === 'infinite') { sticky = s; return s }
    // repeat: n —— 必须**用满 n 次**才前进。
    // （原来是无条件 idx++，所以 repeat:2 实际只重复了 1 次 —— review 抓到）
    if (Number.isFinite(s.repeat) && s.repeat > 0) {
      const left = leftMap.has(s) ? leftMap.get(s) : s.repeat
      if (left > 1) { leftMap.set(s, left - 1); return s }
      leftMap.delete(s)
      idx += 1
      return s
    }
    idx += 1
    return s
  }

  async function once(messages, toolSpecs) {
    calls.push({ messages: Array.isArray(messages) ? messages.slice() : messages, tools: toolSpecs || null })
    if (delayMs > 0) await sleep(delayMs)
    const s = pick()
    if (s.reject) throw new Error(String(s.reject))
    if (s.error) return { ok: false, error: String(s.error) }
    return {
      ok: true,
      text: typeof s.text === 'string' ? s.text : '',
      toolCalls: Array.isArray(s.toolCalls) ? s.toolCalls.map((t) => ({ name: String(t && t.name || ''), args: (t && t.args) || {} })) : [],
      usage: s.usage || null,
      model: 'mock',
    }
  }

  return Object.freeze({
    isMock: true,
    describe: () => ({ name: 'mock', model: 'mock', endpoint: 'mock://local' }),
    /** 到目前为止被调了几次、每次带了什么（断言"Agent 到底喂了什么"用）*/
    calls: () => calls.slice(),
    callCount: () => calls.length,
    scriptLeft: () => (sticky ? Infinity : Math.max(0, steps.length - idx)),

    async generate(messages, o = {}) { return once(messages, o.tools) },
    async toolCall(messages, tools) { return once(messages, tools) },
    async stream(messages, o = {}, onDelta) {
      const r = await once(messages, o.tools)
      if (r.ok && typeof onDelta === 'function' && r.text) {
        for (const ch of String(r.text)) onDelta(ch)          // 逐字符，模拟真实流
      }
      return Object.assign({}, r, { streamed: false })
    },
  })
}

/** 常用脚本的快捷构造（让测试读起来像场景，而不是一堆对象字面量）*/
const scenarios = Object.freeze({
  /** 一次 toolCall，然后收尾 */
  singleToolCall: (name, args, done = '完成') => [
    { toolCalls: [{ name, args: args || {} }] },
    { text: done },
  ],
  /** 要求生成补丁，然后收尾 */
  patchThenDone: (file, oldText, newText) => [
    { toolCalls: [{ name: 'proposePatch', args: { file, old: oldText, new: newText, summary: 'mock 补丁' } }] },
    { text: '已提出补丁（等你确认）' },
  ],
  /** 各种错误 */
  invalidTool: () => [{ toolCalls: [{ name: 'noSuchTool', args: {} }] }, { text: '（本不该走到这里）' }],
  malformed: () => [{ text: '这不是 JSON：{"a":' }],
  timeout: () => [{ reject: 'timeout' }],
  /** 无限规划：一直要求 run —— 必须被预算截断 */
  infiniteRun: () => [{ repeat: 'infinite', toolCalls: [{ name: 'run', args: {} }] }],
})

module.exports = { createMockLlm, scenarios }
