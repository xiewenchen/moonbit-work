'use strict'

/**
 * AI Adapter + MockLLM 集成测试（Phase 2.1 / P9B-01 ～ P9B-08）
 *
 * 纯 Node。断言用公共 verify-harness。
 *
 * 这组测试的重点是**组合**：MockLLM + 真实工具注册表 + 真实补丁流程 + 真实预算，
 * 把"LLM 要工具 → 执行 → 回灌 → 再问"这条链真的跑起来 —— 而不是各自单测完就算。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const { createHarness } = require('./verify-harness')
const { createAdapter, normalizeResponse, runToolLoop } = require('./agent-adapter')
const { createMockLlm, scenarios } = require('./mock-llm')
const { createReadOnlyToolRegistry } = require('./agent-tools')
const { createPatch, analyzePatch, renderPatchPreview, applyPatch } = require('./agent-patch')
const { createBudget } = require('./agent-sandbox')
const { createProvider } = require('./ai-provider')

const H = createHarness()
const { chk, eq } = H

const WS = path.join(os.tmpdir(), 'ws-p9b-test')

/** 只读工具注册表（能力全注入，不会真读盘）*/
function readTools(over = {}) {
  return createReadOnlyToolRegistry(Object.assign({
    rootOf: () => WS,
    readFile: async (p) => ({ ok: true, path: p, content: '// ' + p + '\nfn main { }\n', text: 'fn main { }\n' }),
    listDir: async () => ([]),
    search: async ({ query }) => ({ results: [{ file: 'a.mbt', line: 1, text: 'fn ' + query }], scanned: 1 }),
    symbols: null,
    runLog: null,
    diagnostics: null,
    projectInfo: null,
  }, over))
}

/** 一个假的 HTTP 层，用来测真实 adapter（不发真请求）*/
function fakeRequest(responses) {
  const calls = []
  const queue = Array.isArray(responses) ? responses.slice() : [responses]
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    const r = queue.length > 1 ? queue.shift() : queue[0]
    return typeof r === 'function' ? r(url, opts) : r
  }
  fn.calls = calls
  return fn
}

function openaiBody(obj) {
  return { status: 200, body: JSON.stringify(obj) }
}

async function main() {
  console.log('\n=== ① P9B-01 Adapter：generate / toolCall / stream 三个接口 ===')
  {
    const req = fakeRequest(openaiBody({
      model: 'm',
      choices: [{ message: { content: '你好', tool_calls: [{ id: 't1', type: 'function', function: { name: 'readFile', arguments: '{"path":"a.mbt"}' } }] } }],
      usage: { total_tokens: 12 },
    }))
    const a = createAdapter({ provider: { name: 'p', baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' }, request: req })
    chk('adapter 上有 generate', typeof a.generate === 'function')
    chk('adapter 上有 toolCall', typeof a.toolCall === 'function')
    chk('adapter 上有 stream', typeof a.stream === 'function')
    chk('adapter 被冻结', Object.isFrozen(a))

    const r = await a.generate([{ role: 'user', content: 'hi' }])
    eq('文本归一化', r.text, '你好')
    eq('tool_calls 被解析成 {name,args}', r.toolCalls, [{ name: 'readFile', args: { path: 'a.mbt' } }])
    eq('usage 透传', r.usage, { total_tokens: 12 })
    eq('端点拼接正确', req.calls[0].url, 'https://x/v1/chat/completions')
    eq('带上 Authorization', req.calls[0].opts.headers.Authorization, 'Bearer k')
    eq('请求体里有 model 与 messages', JSON.parse(req.calls[0].opts.body).model, 'm')

    // 工具参数不是合法 JSON 时不能抛，要原样留着
    const bad = normalizeResponse({ choices: [{ message: { tool_calls: [{ function: { name: 'x', arguments: '{不是 JSON' } }] } }] })
    chk('参数解析失败也不抛（原样留）', bad.toolCalls[0].args.__raw === '{不是 JSON', JSON.stringify(bad.toolCalls[0].args))

    const noStream = await a.stream([{ role: 'user', content: 'hi' }], {}, () => {})
    eq('没注入 requestStream 时如实标 streamed:false（不假装在流）', noStream.streamed, false)
  }

  console.log('\n=== ② P9B-02 解耦：adapter 文本里不出现厂商名、也不 require 具体 provider ===')
  {
    // ⚠️ 口径说明：这条断言的是**文本口径**（源码里没有厂商名、没有 require 具体 provider 模块），
    // 不等于"架构上不可能被破坏"。更强的检查要看 import 图。
    // 去注释只处理 /* */ 与整行 //（行尾注释里的厂商名会误报，因此只统计"去注释后的代码"）。
    const src = fs.readFileSync(path.join(__dirname, 'agent-adapter.js'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const vendor of ['deepseek', 'ollama', 'openai', 'moonshot', 'dashscope', 'anthropic']) {
      chk('源码（去注释）不含厂商名：' + vendor, code.toLowerCase().indexOf(vendor) < 0)
    }
    chk('也没有 require/import 具体的 provider 模块',
      !/require\(\s*['"]\.\/ai-provider(\.js)?['"]\s*\)/.test(code) && !/from\s+['"]\.\/ai-provider/.test(code))
  }

  console.log('\n=== ③ P9B-03 激活哪个 provider，adapter 就用哪个（activate → agent）===')
  {
    const p = createProvider({ name: 'my-deepseek', type: 'deepseek', apiKey: 'sk-x' })
    let seen = null
    const a = createAdapter({ provider: p, request: async (url, opts) => { seen = url; return openaiBody({ choices: [{ message: { content: 'ok' } }] }) } })
    await a.generate([{ role: 'user', content: 'hi' }])
    chk('用的就是该 provider 的 baseUrl', String(seen).indexOf('api.deepseek.com') >= 0, seen)
    eq('describe 里 model 一致', a.describe().model, p.model)
    eq('describe 里 name 一致', a.describe().name, 'my-deepseek')
  }

  console.log('\n=== ④ P9B-04 MockLLM：接口与 adapter 一致，能被真正替换 ===')
  {
    const m = createMockLlm(['hi'])
    chk('有 isMock 标记（测试可断言"没连真网"）', m.isMock === true)
    for (const fn of ['generate', 'stream', 'toolCall', 'describe']) chk('mock 上有 ' + fn, typeof m[fn] === 'function')
    const r = await m.generate([{ role: 'user', content: 'x' }])
    eq('返回结构一致', [r.ok, r.text], [true, 'hi'])
    eq('记录了被调用几次', m.callCount(), 1)
    chk('记录了喂进来的 messages（可断言 Agent 传了什么）', Array.isArray(m.calls()[0].messages))
    const exhausted = createMockLlm([])
    const e = await exhausted.generate([])
    chk('脚本用完也不崩（给兜底回复）', e.ok === true && typeof e.text === 'string')

    // repeat: n 必须**用满 n 次**才前进。
    // （review 抓到：原来 pick() 无条件 idx++，repeat:2 实际只重复 1 次；
    //   而这条当时**零覆盖**，所以没暴露。）
    const rep = createMockLlm([{ text: 'A', repeat: 2 }, { text: 'B' }])
    const got = []
    for (let i = 0; i < 3; i++) got.push((await rep.generate([])).text)
    eq('repeat:2 真的重复两次再前进', got, ['A', 'A', 'B'])
    const inf = createMockLlm([{ text: 'X', repeat: 'infinite' }])
    const g2 = []
    for (let i = 0; i < 3; i++) g2.push((await inf.generate([])).text)
    eq('repeat:infinite 一直停在同一步', g2, ['X', 'X', 'X'])
    eq('  无限步的 scriptLeft 报 Infinity', inf.scriptLeft(), Infinity)
  }

  console.log('\n=== ⑤ P9B-05 单次 Tool Call：LLM → readFile → 结果回灌 ===')
  {
    const tools = readTools()
    chk('只读注册表有 call', typeof tools.call === 'function')
    const llm = createMockLlm(scenarios.singleToolCall('readFile', { path: 'hello.mbt' }, '读完了'))
    const r = await runToolLoop({ llm, tools, prompt: '看看 hello.mbt' })
    eq('循环正常结束', [r.ok, r.stopped], [true, 'done'])
    eq('真的执行了 readFile', r.steps.map((s) => s.name), ['readFile'])
    eq('工具执行成功', r.steps[0].ok, true)
    eq('模型被调了两次（要工具 + 收尾）', r.modelCalls, 2)
    const msgs = llm.calls()[1].messages
    chk('第二轮把工具结果回灌给了模型', msgs.some((x) => x.role === 'tool' && /ok/.test(String(x.content))), JSON.stringify(msgs.map((x) => x.role)))
  }

  console.log('\n=== ⑥ P9B-06 模型给出 Patch：走真实补丁流程，且**未经确认不写** ===')
  {
    const target = 'demo.mbt'
    const cur = 'fn main { println("hi") }\n'
    // 先用真实 createPatch/analyzePatch 处理模型给的那份"补丁意图"
    const patch = createPatch({ file: target, old: 'println("hi")', new: 'println("APPLIED")', summary: 'mock 补丁' })
    const an = analyzePatch(patch, { fileContent: cur })
    chk('补丁分析通过（old 能精确匹配）', an.ok === true, JSON.stringify(an).slice(0, 120))
    chk('分析给出改动行数', an.oldLines >= 1 && an.newLines >= 1, JSON.stringify(an))
    const preview = renderPatchPreview(patch)
    chk('预览里能看到新内容', String(preview).indexOf('APPLIED') >= 0, String(preview).slice(0, 100))

    const llm = createMockLlm(scenarios.patchThenDone(target, 'println("hi")', 'println("APPLIED")'))
    const tools = readTools()
    const r = await runToolLoop({ llm, tools, prompt: '把输出改成 APPLIED' })
    // 只读表**没有** proposePatch，所以这条工具调用会被拒 —— 这正是"Agent 不能自己写"的保证
    eq('模型要求 proposePatch → 只读表拒绝', r.steps[0], { name: 'proposePatch', ok: false, error: '未知或不允许的工具：proposePatch' })

    // 真要走写路径，必须用户确认（Gate P8）—— 这里确认函数返回 false，必须被拒
    let wrote = false
    const res = await applyPatch({ file: target, old: 'println("hi")', new: 'println("APPLIED")' }, {
      root: WS,
      readFile: async () => cur,
      writeFile: async () => { wrote = true },
      confirm: () => false,
    })
    eq('未经确认 → 不写盘', [res.ok, wrote], [false, false])
    chk('  拒绝原因明确（cancelled / 需确认）', /cancel|confirm|确认/i.test(String(res.reason || res.error || '')), JSON.stringify(res).slice(0, 120))
  }

  console.log('\n=== ⑦ P9B-07 错误路径：非法工具 / 畸形响应 / 超时 ===')
  {
    // 非法工具名 → 工具表拒绝（不抛、不重试）
    const r1 = await runToolLoop({ llm: createMockLlm(scenarios.invalidTool()), tools: readTools(), prompt: 'x' })
    eq('非法工具被拒且循环继续到模型收尾', [r1.ok, r1.steps[0].ok], [true, false])
    chk('  错误信息说明"未知或不允许"', /未知|不允许/.test(String(r1.steps[0].error)), String(r1.steps[0].error))

    // 畸形响应（工具参数不是 JSON）→ adapter 不抛，原样保留
    const reqBad = fakeRequest(openaiBody({ choices: [{ message: { tool_calls: [{ function: { name: 'readFile', arguments: '{"path":' } }] } }] }))
    const a = createAdapter({ provider: { baseUrl: 'https://x/v1', model: 'm' }, request: reqBad })
    const rb = await a.generate([])
    eq('畸形参数不抛、ok 仍为 true', rb.ok, true)
    chk('  原样放在 __raw 里', !!rb.toolCalls[0].args.__raw)

    // 返回体根本不是 JSON
    const reqNotJson = fakeRequest({ status: 200, body: 'oops-not-json' })
    const a2 = createAdapter({ provider: { baseUrl: 'https://x/v1', model: 'm' }, request: reqNotJson })
    const rn = await a2.generate([])
    eq('非 JSON 返回 → ok:false', rn.ok, false)
    chk('  错误信息可读', /JSON/.test(String(rn.error)), String(rn.error))

    // HTTP 错误
    const req500 = fakeRequest({ status: 500, body: 'boom' })
    const a3 = createAdapter({ provider: { baseUrl: 'https://x/v1', model: 'm' }, request: req500 })
    const r5 = await a3.generate([])
    eq('HTTP 500 → ok:false', [r5.ok, r5.status], [false, 500])

    // 超时 / 网络炸 → adapter 报 error；循环把它变成可读失败（不抛出去）
    const reqThrow = fakeRequest({ error: 'timeout' })
    const a4 = createAdapter({ provider: { baseUrl: 'https://x/v1', model: 'm' }, request: reqThrow })
    eq('网络层错误 → ok:false', (await a4.generate([])).ok, false)

    const llmReject = createMockLlm(scenarios.timeout())
    const rt = await runToolLoop({ llm: llmReject, tools: readTools(), prompt: 'x' })
    eq('模型直接抛 → 循环捕获并标 llm-error（不把异常漏出去）', [rt.ok, rt.stopped], [false, 'llm-error'])
    chk('  错误信息带原文', /timeout/.test(String(rt.error)), String(rt.error))

    // ★ review 抓到的泄漏路径：注入的 request 常把 headers 拼进 error（含 Authorization），
    //   错误体也可能回显 key —— 内置脱敏必须兜住，不能只靠"上层会处理"。
    const KEY = 'sk-live-abcdef123456'
    const leaky = fakeRequest({ error: 'connect failed: Authorization: Bearer ' + KEY + ' for https://x' })
    const aLeak = createAdapter({ provider: { baseUrl: 'https://x/v1', model: 'm', apiKey: KEY }, request: leaky })
    const rl = await aLeak.generate([])
    chk('网络错误的 error 里 key 被遮住', !new RegExp(KEY).test(String(rl.error)), String(rl.error))
    chk('  但保留了可读部分（没把整句毁掉）', /connect failed/.test(String(rl.error)), String(rl.error))

    const bodyLeak = fakeRequest({ status: 401, body: '{"error":"bad key","apiKey":"' + KEY + '"}' })
    const aLeak2 = createAdapter({ provider: { baseUrl: 'https://x/v1', model: 'm' }, request: bodyLeak })
    const rl2 = await aLeak2.generate([])
    chk('错误体里回显的 key 也被遮住', !new RegExp(KEY).test(String(rl2.error)), String(rl2.error))
    chk('  且标了 HTTP 状态', /401/.test(String(rl2.error)), String(rl2.error))

    // 调用方可以注入更严格的脱敏
    const custom = createAdapter({
      provider: { baseUrl: 'https://x/v1', model: 'm' }, request: fakeRequest({ error: 'e ' + KEY }),
      redact: (s) => String(s).replace(new RegExp(KEY, 'g'), '[CUSTOM]'),
    })
    chk('可注入自定义 redact', /\[CUSTOM\]/.test(String((await custom.generate([])).error)))

    // ★ AI-05/06：**异常路径**也必须脱敏。
    //   ⚠️ 分工：createAdapter().generate() 遇 request 抛错是**向上抛**的；
    //   真正把它兜住并交给上层的是 runToolLoop —— 所以这里测这条路径。
    const throwKey = 'sk-throw-abcdef123456'
    const tr = await runToolLoop({
      llm: { generate: async () => { throw new Error('connect failed: Authorization: Bearer ' + throwKey) } },
      tools: { call: async () => ({ ok: true }) },
      messages: [{ role: 'user', content: 'x' }],
      maxSteps: 2,
    })
    chk('★ runToolLoop 异常 message 里的 Key 被脱敏', tr.ok === false && !String(tr.error).includes(throwKey), String(tr.error).slice(0, 120))
    chk('  且错误本身没被吞（仍可读）', /connect failed|模型调用失败/.test(String(tr.error)), String(tr.error).slice(0, 120))

    // 非 JSON 响应体带 Key（这条走 createAdapter，它是**返回**而非抛）
    const badJson = createAdapter({
      provider: { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'sk-whatever-1234567' },
      request: async () => ({ status: 200, body: 'not json but has sk-json-abcdef123456 inside' }),
    })
    const bj = await badJson.generate([])
    chk('★ 非 JSON 响应里的 Key 也被脱敏', bj.ok === false && !String(bj.error).includes('sk-json-abcdef123456'), String(bj.error).slice(0, 120))
  }

  console.log('\n=== ⑧ P9B-08 无限规划必须被**预算**截断 ===')
  {
    const llm = createMockLlm(scenarios.infiniteRun())
    const budget = createBudget({ maxCalls: 3 })
    const r = await runToolLoop({ llm, tools: readTools(), budget, prompt: 'x', maxSteps: 100 })
    eq('被预算拦下（不是靠 maxSteps 兜）', r.stopped, 'budget')
    eq('恰好消费了 3 次', r.steps.length, 3)
    chk('错误信息说明原因', /最大调用次数|预算|3/.test(String(r.error)), String(r.error))
    eq('预算统计对得上', budget.stats().calls, 3)
    chk('模型也没有被无限调用（预算在执行前拦住）', llm.callCount() === 4, String(llm.callCount()))

    // 没有预算时，靠 maxSteps 兜底 —— 但结果必须是"明确失败"，而不是"看起来成功了"
    const r2 = await runToolLoop({ llm: createMockLlm(scenarios.infiniteRun()), tools: readTools(), prompt: 'x', maxSteps: 4 })
    eq('无预算时由 maxSteps 兜底', r2.stopped, 'maxSteps')
    eq('  且 ok=false（不伪装成功）', r2.ok, false)

    // 时间预算
    let fake = 0
    const b2 = createBudget({ maxCalls: 100, maxTotalMs: 10, now: () => fake })
    fake = 20
    eq('时间预算也能拦住', b2.tryConsume().ok, false)
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
