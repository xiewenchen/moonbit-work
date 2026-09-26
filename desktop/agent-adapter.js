'use strict'

/**
 * AI Adapter —— Agent 与"具体模型厂商"之间唯一的接口（Phase 2.1 / P9B-01、P9B-02）
 *
 * 两条设计约束（都为了"解耦"是**结构性**的，而不是嘴上说说）：
 *
 *   ① Agent 只认这个接口：
 *        generate(messages, opts)          → { ok, text, toolCalls, usage, error }
 *        stream(messages, opts, onDelta)   → 同上（边流边回调）
 *        toolCall(messages, tools, opts)   = generate 的带工具变体
 *   ② **本文件里不出现任何厂商名**（不 import ai-provider，也没有 deepseek/ollama 分支）。
 *      它只接受一个"能发 HTTP 请求的东西"（注入的 `request` / `requestStream`）
 *      和一份 `{ baseUrl, model, apiKey }`。
 *
 *      → 所以"换模型"永远不会变成"改 Agent 代码"。这条可以被静态断言（见 test）。
 *
 * 端点上按 OpenAI 兼容协议走（`POST {baseUrl}/chat/completions`）—— 这也是 ollama /
 * dashscope / moonshot 等的通用形态。
 */

const DEFAULT_TIMEOUT_MS = 60000

/**
 * 默认脱敏：**内置**一道底线，不依赖调用方是否记得注入。
 *
 * 为什么必须有：很多注入的 request 实现会把 opts/headers 拼进错误信息，
 * 那样 `Authorization: Bearer sk-...` 会随 error 一路冒到日志/界面。
 * （P12 的 ai-provider 里已有 redactText，但本文件**不应** import 它——否则又耦合回去了。）
 */
function defaultRedact(s) {
  return String(s == null ? '' : s)
    .replace(/\bsk-[A-Za-z0-9_\-]{6,}/g, 'sk-****')
    .replace(/\bBearer\s+[A-Za-z0-9_\-.=]{6,}/gi, 'Bearer ****')
    .replace(/"(apiKey|api_key|authorization|Authorization)"\s*:\s*"[^"]*"/g, '"$1":"****"')
}

function joinUrl(baseUrl, path) {
  const b = String(baseUrl || '').replace(/\/+$/, '')
  const p = String(path || '').replace(/^\/+/, '')
  return b + '/' + p
}

/** 把 OpenAI 风格的返回体归一成统一形状 */
function normalizeResponse(raw) {
  const j = raw && typeof raw === 'object' ? raw : {}
  const choice = (j.choices && j.choices[0]) || null
  const msg = (choice && choice.message) || {}
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((t) => {
    const fn = (t && t.function) || {}
    let args = {}
    const a = fn.arguments
    if (typeof a === 'string' && a.trim()) {
      try { args = JSON.parse(a) } catch (e) { args = { __raw: a } }      // 解析不了也不抛，原样留着
    } else if (a && typeof a === 'object') {
      args = a
    }
    return { name: String(fn.name || ''), args }
  })
  return {
    text: typeof msg.content === 'string' ? msg.content : '',
    toolCalls,
    usage: j.usage || null,
    model: j.model || null,
  }
}

/** 构造发请求用的 body（OpenAI 兼容）*/
function buildBody(provider, messages, opts = {}) {
  const body = { model: provider.model, messages: Array.isArray(messages) ? messages : [] }
  if (Array.isArray(opts.tools) && opts.tools.length) { body.tools = opts.tools; body.tool_choice = opts.toolChoice || 'auto' }
  if (Number.isFinite(opts.temperature)) body.temperature = opts.temperature
  if (opts.json != null) body.response_format = { type: 'json_object' }
  return body
}

/**
 * 建一个 adapter。
 *
 * @param {object} deps
 * @param {{baseUrl:string, model:string, apiKey?:string, name?:string}} deps.provider 只当数据用，不做任何分支
 * @param {(url:string, opts:object) => Promise<{status:number, body:string, error?:string}>} deps.request
 * @param {(url:string, opts:object, onDelta:(s:string)=>void) => Promise<{status:number, error?:string}>} [deps.requestStream]
 * @param {(ms:number) => Promise<any>} [deps.sleep]
 */
const { runOpencodeOnce } = require('./opencode-transport')

/** 从消息列表里取最后一条 user 文本（opencode CLI 只收一个 prompt 字符串）。 */
function lastUserText(messages) {
  const arr = Array.isArray(messages) ? messages : []
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i]
    if (!m || m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      const parts = m.content.filter((p) => p && p.type === 'text').map((p) => p.text)
      if (parts.length) return parts.join('\n')
    }
  }
  return ''
}

function createAdapter(deps = {}) {
  const provider = deps.provider || {}
  const request = deps.request
  const requestStream = deps.requestStream
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS
  // 调用方可注入更严格的脱敏；不注入也有内置底线（见 defaultRedact）
  const redact = typeof deps.redact === 'function' ? deps.redact : defaultRedact
  // PH3-AI-03：adapter 成为**唯一出口**，底层有两种传输实现。
  //   'http'     —— 自己发 POST {baseUrl}/chat/completions（默认，行为与以前完全一致）
  //   'opencode'  —— 交给 opencode CLI（opencode-transport.js）
  // 这样 UI 与 Agent Runtime 只需认 adapter，不再自己 spawn。
  const transport = deps.transport === 'opencode' ? 'opencode' : 'http'

  if (transport === 'http' && typeof request !== 'function') throw new Error('createAdapter 需要注入 request')
  if (transport === 'http' && (!provider.baseUrl || !provider.model)) throw new Error('provider 缺少 baseUrl 或 model')
  if (transport === 'opencode' && !deps.opencode) throw new Error("transport:'opencode' 需要注入 opencode 依赖")

  // ⚠️ opencode transport 不一定要 baseUrl（它读自己的配置）—— 所以这里不能无条件算。
  const endpoint = (provider.baseUrl ? joinUrl(provider.baseUrl, 'chat/completions') : null)
  const headers = () => {
    const h = { 'Content-Type': 'application/json' }
    if (provider.apiKey) h.Authorization = 'Bearer ' + provider.apiKey
    return h
  }

  /**
   * transport:'opencode' —— 把一次"对话"交给 opencode CLI，收齐文本后返回。
   * 返回结构与 http transport **保持一致**，所以调用方（Agent Runtime / UI）无需分支。
   *
   * ⚠️ opencode 是**流式**的：这里把 text 事件累积起来，等 end 再 resolve。
   *    - `opts.onDelta`  只收增量文本（与 http transport 的 stream 一致）
   *    - `opts.onEvent`  收**原始事件**（tool / meta / error …）—— UI 要显示"agent 干了什么"
   *      （PH3-AI-03 第 3 步：agent:run 改成经 adapter 后，这些事件必须仍能到达界面）
   */
  async function callViaOpencode(messages, opts = {}) {
    const oc = deps.opencode || {}
    const prompt = lastUserText(messages)
    const texts = []
    const done = await new Promise((resolve) => {
      const r = runOpencodeOnce(
        { spawn: oc.spawn, resolveSpawn: oc.resolveSpawn, findBin: oc.findBin },
        {
          prompt,
          model: provider.model,
          sessionId: oc.sessionId,
          cwd: oc.cwd,
          onEvent: (ev) => {
            if (typeof opts.onEvent === 'function') opts.onEvent(ev)
            if (ev.type === 'text') {
              texts.push(ev.text)
              if (typeof opts.onDelta === 'function') opts.onDelta(ev.text)
            } else if (ev.type === 'end') {
              resolve(ev)
            }
          },
        },
      )
      // 启动就失败（没装 opencode / spawn 抛错）→ 直接 resolve，不能一直等
      // ⚠️ 也在这里把 child 同步交给调用方：IPC 的 agent:run 必须**立即**返回 pid
      //    （agent:stop 靠它），不能等 generate() 的 Promise resolve。
      if (r.ok !== true) resolve({ ok: false, error: r.error, missing: r.missing })
      else if (typeof oc.onSpawn === 'function') oc.onSpawn(r.child, r.pid)
    })
    if (done && done.ok === false) return { ok: false, error: redact(String(done.error || 'opencode 执行失败')) }
    return {
      ok: true,
      text: texts.join(''),
      toolCalls: [],
      usage: null,
      model: provider.model,
      via: 'opencode',
      sessionId: (done && done.sessionId) || null,
    }
  }

  async function callOnce(messages, opts) {
    if (transport === 'opencode') return callViaOpencode(messages, opts)
    const r = await request(endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(buildBody(provider, messages, opts)),
      timeoutMs,
    })
    if (!r) return { ok: false, error: '请求没有返回' }
    // ⚠️ 注入的 request 实现可能把 headers（含 Authorization）拼进 error —— 必须过脱敏
    if (r.error) return { ok: false, error: redact(String(r.error)) }
    if (r.status !== 200) {
      // 错误体里可能回显 key：先解密再截断
      return { ok: false, error: 'HTTP ' + r.status + '：' + redact(String(r.body || '')).slice(0, 300), status: r.status }
    }
    let parsed = null
    try { parsed = JSON.parse(String(r.body || '')) } catch (e) {
      return { ok: false, error: '返回不是合法 JSON：' + redact(String((e && e.message) || e)) }
    }
    const n = normalizeResponse(parsed)
    return { ok: true, text: n.text, toolCalls: n.toolCalls, usage: n.usage, model: n.model }
  }

  return Object.freeze({
    /** 谁（仅用于日志/展示，adapter 内部不做任何分支）*/
    describe: () => ({ name: provider.name || null, model: provider.model, endpoint }),

    async generate(messages, opts = {}) {
      return callOnce(messages, opts)
    },

    /** 带工具的调用（语义上等价于 generate(opts.tools)，单独开个名字让调用点更清楚）*/
    async toolCall(messages, tools, opts = {}) {
      return callOnce(messages, Object.assign({}, opts, { tools }))
    },

    async stream(messages, opts = {}, onDelta) {
      if (typeof requestStream !== 'function') {
        // 没有流式能力就退化成一次性 —— 但**如实说明**，不假装在流
        const r = await callOnce(messages, opts)
        if (r.ok && typeof onDelta === 'function' && r.text) onDelta(r.text)
        return Object.assign({}, r, { streamed: false })
      }
      const r = await requestStream(endpoint, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(buildBody(provider, messages, Object.assign({}, opts, { stream: true }))),
        timeoutMs,
      }, onDelta)
      if (!r || r.error) return { ok: false, error: redact(String((r && r.error) || '流式请求失败')), streamed: true }
      if (r.status !== 200) return { ok: false, error: 'HTTP ' + r.status, status: r.status, streamed: true }
      return { ok: true, streamed: true, text: typeof r.text === 'string' ? r.text : '' }
    },
  })
}

/**
 * 最小的「工具循环」—— LLM 要工具 → 执行 → 结果回灌 → 再问，直到：
 *   模型不再要工具 / **预算耗尽** / 步数用尽。
 *
 * 它**不是** P9C 那个完整 Agent（那个还要接 Context / Patch / Verify）；
 * 这里只做"多轮 + 截断"这一件事，好让 P9B 能独立验证 ——
 * 尤其是"**无限规划必须被预算截断**"（清单 P9B-08 点名的场景）。
 *
 * @param {object} deps
 * @param {object} deps.llm            任何实现了 generate/stream 的东西（真 adapter 或 MockLLM）
 * @param {{call:(n:string,a:object)=>Promise<object>}} deps.tools 工具注册表（P6）
 * @param {object} [deps.budget]       agent-sandbox 的 createBudget()
 * @param {number} [deps.maxSteps]
 * @param {Array}  [deps.messages]     初始消息（默认就一句用户话）
 * @param {object} [deps.toolSpecs]    传给模型的工具声明
 */
async function runToolLoop(deps = {}) {
  const llm = deps.llm
  // ⚠️ runToolLoop 是**另一个函数**，拿不到 createAdapter 里那个 redact。
  //    原来这里的 e.message 直接透出（未脱敏）—— 本轮补上，并允许调用方注入。
  const redact = typeof deps.redact === 'function' ? deps.redact : defaultRedact
  const tools = deps.tools
  const budget = deps.budget || null
  const maxSteps = Number.isFinite(deps.maxSteps) ? deps.maxSteps : 8
  if (!llm || typeof llm.generate !== 'function') throw new Error('runToolLoop 需要 llm.generate')
  if (!tools || typeof tools.call !== 'function') throw new Error('runToolLoop 需要 tools.call')

  const messages = Array.isArray(deps.messages) ? deps.messages.slice() : [{ role: 'user', content: String(deps.prompt || '') }]
  const steps = []
  let modelCalls = 0

  for (let round = 0; round < maxSteps; round++) {
    modelCalls++
    let r
    try {
      r = await llm.generate(messages, { tools: deps.toolSpecs })
    } catch (e) {
      return { ok: false, error: '模型调用失败：' + redact(String((e && e.message) || e)), steps, modelCalls, stopped: 'llm-error' }
    }
    if (!r || r.ok === false) {
      return { ok: false, error: (r && r.error) || '模型返回失败', steps, modelCalls, stopped: 'llm-error' }
    }
    if (!r.toolCalls || !r.toolCalls.length) {
      return { ok: true, text: r.text || '', steps, modelCalls, stopped: 'done' }
    }

    // 同一轮的多个工具调用：**合并成 1 条 assistant + N 条 tool**。
    // （逐个 push assistant 的话，严格的 OpenAI 兼容上游可能不认这种形态。）
    const batch = []
    for (const tc of r.toolCalls) {
      // ★ 预算检查在**执行之前** —— 无限规划就是在这里被截断的。
      //   一轮返回 N 个调用就会扣 N 次额度，所以"一次多要几个"也绕不过去。
      if (budget) {
        let b
        try { b = budget.tryConsume() } catch (e) { b = { ok: false, error: '预算检查异常：' + String((e && e.message) || e) } }
        if (!b || b.ok !== true) {
          return { ok: false, error: (b && b.error) || '预算不足', steps, modelCalls, stopped: 'budget' }
        }
      }
      let res
      try {
        res = await tools.call(tc.name, tc.args || {})
      } catch (e) {
        res = { ok: false, error: redact(String((e && e.message) || e)) }
      }
      steps.push({ name: tc.name, ok: !!(res && res.ok === true), error: (res && res.error) || null })
      batch.push({ tc, res, id: 'c' + steps.length })
    }
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: batch.map((x) => ({
        id: x.id,
        type: 'function',
        function: { name: x.tc.name, arguments: JSON.stringify(x.tc.args || {}) },
      })),
    })
    for (const x of batch) {
      const payload = x.res && x.res.data != null
        ? { ok: x.res.ok, data: x.res.data }
        : { ok: !!(x.res && x.res.ok), error: (x.res && x.res.error) || null }
      messages.push({ role: 'tool', tool_call_id: x.id, content: JSON.stringify(payload).slice(0, 800) })
    }
  }

  return { ok: false, error: '达到最大步数（' + maxSteps + '）', steps, modelCalls, stopped: 'maxSteps' }
}

module.exports = { createAdapter, normalizeResponse, buildBody, joinUrl, DEFAULT_TIMEOUT_MS, runToolLoop, defaultRedact, lastUserText }
