// 自研轻量 Agent 的**引擎**（纯 Node，零依赖）
//
// 职责：多轮循环 —— 调模型 → 若有 tool_calls 就执行并把结果回灌 → 直到模型给出最终回答。
//
// 与 provider 解耦：默认走 OpenAI 兼容的 /chat/completions（流式 SSE），
// 但 `chat` 可以注入（测试时用假的，见 agent-core.test.js），所以**不接真实 API 也能验证引擎**。
const https = require('https')
const http = require('http')
const { URL } = require('url')
const { TOOLS, byName, toOpenAITools } = require('./agent-tools')

const SYSTEM_PROMPT = `你是嵌入在 MoonBit IDE 里的编码助手。当前工作目录就是用户打开的项目根目录，你只能在这个目录内操作。

可用工具：list_dir / read_file / grep / write_file / edit_file / run_command。

工作原则：
- 先看清再动手：不确定就先 list_dir / grep / read_file，不要凭空猜结构。
- 改动要小：优先用 edit_file 做精确替换；只有新建文件才用 write_file 整写。
- 改完要验证：能跑就跑一下（编译/测试），把结果如实告诉用户，失败就说失败。
- 不做用户没让你做的事（不顺手重构、不删除文件）。
- 用中文回答；代码、路径、命令保持原样。`

// ── 最小的 OpenAI 兼容客户端（流式 SSE）──────────────────────────────
// 返回 { content, toolCalls:[{id,name,args}] }；文本增量通过 onDelta 实时回调。
function sseChat(cfg, messages, tools, onDelta, signal) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL('chat/completions', cfg.baseURL.replace(/\/?$/, '/')) } catch (e) { return reject(new Error('baseURL 不合法：' + cfg.baseURL)) }
    const payload = JSON.stringify({
      model: cfg.model, messages, temperature: cfg.temperature == null ? 0.2 : cfg.temperature,
      tools, tool_choice: 'auto', stream: true,
    })
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (cfg.apiKey || ''),
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      if (res.statusCode >= 400) {
        let b = ''
        res.on('data', (d) => { b += d })
        res.on('end', () => reject(new Error('HTTP ' + res.statusCode + '：' + b.slice(0, 300))))
        return
      }
      let buf = ''
      const content = []
      const calls = []           // 按 index 累积（流式下 arguments 是分片来的）
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let ev
          try { ev = JSON.parse(data) } catch (_) { continue }
          const d = ev.choices && ev.choices[0] && ev.choices[0].delta
          if (!d) continue
          if (typeof d.content === 'string' && d.content) { content.push(d.content); if (onDelta) onDelta({ type: 'text', text: d.content }) }
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              const i = tc.index == null ? 0 : tc.index
              if (!calls[i]) calls[i] = { id: '', name: '', args: '' }
              if (tc.id) calls[i].id = tc.id
              if (tc.function && tc.function.name) calls[i].name = tc.function.name
              if (tc.function && tc.function.arguments) calls[i].args += tc.function.arguments
            }
          }
        }
      })
      res.on('end', () => resolve({ content: content.join(''), toolCalls: calls.filter(Boolean) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (signal) {
      const onAbort = () => { try { req.destroy(new Error('已取消')) } catch (_) {} }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    req.write(payload)
    req.end()
  })
}

// ── 多轮主循环 ──────────────────────────────────────────────────────
// opts: { messages, root, config, onEvent, confirm, chat }
//   onEvent({type}) : text | tool_call | tool_result | round | final | error
//   confirm({name,args,tool}) -> Promise<boolean>   危险操作前的用户确认
//   chat   : 注入点（默认 sseChat），签名 (messages, tools, onDelta, signal) -> {content,toolCalls}
async function runLoop(opts) {
  const cfg = opts.config || {}
  const root = opts.root
  const onEvent = opts.onEvent || (() => {})
  const confirm = opts.confirm || (async () => true)
  const chat = opts.chat || ((msgs, tools, onDelta, signal) => sseChat(cfg, msgs, tools, onDelta, signal))
  const tools = toOpenAITools(TOOLS)
  const msgs = [...(opts.messages || [])]
  const maxRounds = cfg.maxToolRounds || 25

  for (let round = 1; round <= maxRounds; round++) {
    onEvent({ type: 'round', round })
    let res
    try {
      res = await chat(msgs, tools, (d) => onEvent(d), opts.signal)
    } catch (e) {
      onEvent({ type: 'error', error: '调用模型失败：' + (e && e.message || e) })
      return { content: '', messages: msgs, error: String(e && e.message || e) }
    }

    if (res.toolCalls && res.toolCalls.length) {
      // 把模型的"要调工具"这条消息原样放回历史（OpenAI 协议要求）
      msgs.push({
        role: 'assistant',
        content: res.content || null,
        tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })),
      })
      for (const tc of res.toolCalls) {
        const tool = byName(tc.name)
        let args = {}
        try { args = JSON.parse(tc.args || '{}') } catch (_) { args = {} }
        onEvent({ type: 'tool_call', name: tc.name, args })
        let out
        if (!tool) {
          out = '未知工具：' + tc.name
        } else {
          const needConfirm = tool.requiresConfirm && cfg.confirmWrites !== false
          let ok = true
          if (needConfirm) { try { ok = await confirm({ name: tc.name, args, tool }) } catch (_) { ok = false } }
          if (!ok) {
            out = '用户拒绝了这次操作。不要原样重试；如需继续，换一种方式或先问用户。'
          } else {
            try { out = await tool.run(args, { root }) } catch (e) { out = '工具执行出错：' + (e && e.message || e) }
          }
        }
        onEvent({ type: 'tool_result', name: tc.name, result: String(out) })
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(out) })
      }
      continue                                    // 继续下一轮，让模型看到工具结果
    }

    onEvent({ type: 'final', content: res.content || '' })
    return { content: res.content || '', messages: msgs }
  }

  const err = '工具调用轮数超过上限（' + maxRounds + ' 轮），已停止'
  onEvent({ type: 'error', error: err })
  return { content: '', messages: msgs, error: err }
}

module.exports = { runLoop, sseChat, SYSTEM_PROMPT, toOpenAITools }
