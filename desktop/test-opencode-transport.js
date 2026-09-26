// PH3-AI-03 第一步的验证：opencode transport 的纯逻辑。
//
// 这些样本**取自 agent.js 里的实测注释**（不是我想象的格式）——
// 先验真实输入再写断言，否则断言只是在测我的假设。
require('./verify-harness')   // 仅确保 harness 存在（本文件用自带断言，保持纯 Node）
const {
  parseOpencodeEvent, parseOpencodeChunk, sessionIdFrom, buildOpencodeArgs, runOpencodeOnce,
} = require('./opencode-transport')

let pass = 0, fail = 0
const chk = (name, ok, detail) => {
  if (typeof ok !== 'boolean') { fail++; console.log('  [FAIL] ' + name + '   chk 只接受布尔：' + JSON.stringify(ok)); return }
  if (ok) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

console.log('=== ① 事件解析：四种真实事件 ===')
{
  const text = parseOpencodeEvent({ type: 'text', part: { type: 'text', text: 'Hi!' } })
  chk('text 事件取出正文', text.type === 'text' && text.text === 'Hi!', JSON.stringify(text))

  const tool = parseOpencodeEvent({ type: 'tool', part: { tool: 'readFile', state: { name: 'readFile' } } })
  chk('tool 事件取出工具名', tool.type === 'tool' && tool.name === 'readFile', JSON.stringify(tool))

  const meta = parseOpencodeEvent({ type: 'step_finish', part: { tokens: { input: 10, output: 3 }, cost: 0 } })
  chk('step_finish 带 tokens/cost', meta.type === 'meta' && meta.tokens.output === 3 && meta.cost === 0, JSON.stringify(meta))

  const err = parseOpencodeEvent({ type: 'error', error: { name: 'APIError', data: { status: 429 } } })
  chk('error 事件取出 error', err.type === 'error' && err.error.name === 'APIError', JSON.stringify(err))

  chk('step_start 这类过程事件不显示（避免刷屏）', parseOpencodeEvent({ type: 'step_start' }) === null)
  chk('非对象输入不炸', parseOpencodeEvent(null) === null && parseOpencodeEvent('x') === null)
}

console.log('\n=== ② ★ sessionID 必须跟着事件带出去（多轮续接）===')
{
  // 这是抽取时差点丢掉的副作用：原 agent.js 靠事件里的 sessionID 续接会话
  const ev = parseOpencodeEvent({ type: 'text', part: { text: 'x' }, sessionID: 'ses_abc123' })
  chk('★ 事件里带了 sessionId', ev.sessionId === 'ses_abc123', JSON.stringify(ev))

  // 只有 id、没有可显示内容的事件，也不能丢
  const only = parseOpencodeEvent({ type: 'step_start', sessionID: 'ses_zzz' })
  chk('★ 只有 sessionID 的事件也要传出去', only && only.type === 'session' && only.sessionId === 'ses_zzz', JSON.stringify(only))

  const none = parseOpencodeEvent({ type: 'step_start' })
  chk('既无内容又无 id → null（不刷屏）', none === null)

  chk('sessionIdFrom 取值', sessionIdFrom({ sessionID: 'a' }, 'old') === 'a')
  chk('sessionIdFrom 取不到时保留原值', sessionIdFrom({}, 'old') === 'old')
}

console.log('\n=== ③ 按行切分：JSON 行 vs 非 JSON 行 ===')
{
  const lines = parseOpencodeChunk([
    '{"type":"step_start"}',
    '{"type":"text","part":{"type":"text","text":"你好"},"sessionID":"s1"}',
    'not json at all',
    '{"type":"step_finish","part":{"tokens":{"input":1}}}',
    '',
    '   ',
  ].join('\n'))
  chk('step_start 不产出事件', lines.filter((x) => x.type !== 'session' && x.type !== 'raw').length === 2, JSON.stringify(lines.map((x) => x.type)))
  chk('★ 非 JSON 行原样给出（type:raw，不丢信息）', lines.some((x) => x.type === 'raw' && x.text === 'not json at all'))
  chk('★ 带 sessionID 的行把 id 带出来了（不管哪种事件）', lines.some((x) => x.sessionId === 's1'), JSON.stringify(lines))
  chk('空行被忽略', lines.filter((x) => x.type === 'raw').length === 1)
  chk('空输入不炸', parseOpencodeChunk(null).length === 0 && parseOpencodeChunk(undefined).length === 0)
  chk('\\r\\n 也能切（Windows）', parseOpencodeChunk('{"type":"step_start"}\r\n{"type":"step_start"}').length === 0)
}

console.log('\n=== ④ 命令行组装：--format json 是硬要求 ===')
{
  const a = buildOpencodeArgs({ prompt: 'hi' })
  chk('★ 必须带 --format json（不带它输出人类文本，解析全落空）', a.includes('--format') && a[a.indexOf('--format') + 1] === 'json', JSON.stringify(a))
  chk('prompt 放在 run 之后', a[0] === 'run' && a[1] === 'hi', JSON.stringify(a))
  chk('无 sessionId 时不带 --session', !a.includes('--session'))
  const b = buildOpencodeArgs({ prompt: 'x', sessionId: 's1', model: 'm1' })
  chk('有 sessionId 时带上', b.includes('--session') && b[b.indexOf('--session') + 1] === 's1', JSON.stringify(b))
  chk('有 model 时带上', b.includes('--model') && b[b.indexOf('--model') + 1] === 'm1')
  chk('空 prompt 不炸', buildOpencodeArgs({})[1] === '')
}

console.log('\n=== ⑤ runOpencodeOnce：注入依赖，不起真进程 ===')
{
  const noBin = runOpencodeOnce({ spawn: () => {}, findBin: () => null }, { prompt: 'x' })
  chk('★ 找不到 opencode → 明确错误（与 agent.js 原文案一致）',
    noBin.ok === false && /未找到 opencode/.test(noBin.error) && noBin.missing === 'opencode', JSON.stringify(noBin))
  chk('  且不抛', true)

  chk('缺注入 → 明确报错而不是崩', runOpencodeOnce({}, {}).ok === false)
  chk('缺 findBin → 明确报错', runOpencodeOnce({ spawn: () => {} }, {}).ok === false)

  // 注入一个假的 child，验证事件真的推进来了
  const events = []
  const fakeChild = {
    pid: 4242,
    stdout: { on: (n, cb) => { if (n === 'data') fakeChild._out = cb } },
    stderr: { on: (n, cb) => { if (n === 'data') fakeChild._err = cb } },
    on: (n, cb) => { if (n === 'close') fakeChild._close = cb },
  }
  const r = runOpencodeOnce(
    { spawn: () => fakeChild, resolveSpawn: (b, a) => ({ bin: b, args: a, shell: false }), findBin: () => 'C:/fake/opencode.cmd' },
    { prompt: '你好', sessionId: 's0', cwd: 'C:/proj', onEvent: (e) => events.push(e) },
  )
  chk('成功启动并返回 pid', r.ok === true && r.pid === 4242, JSON.stringify({ ok: r.ok, pid: r.pid }))
  chk('  spawn 收到了 --format json', r.args.includes('--format'))

  fakeChild._out(Buffer.from('{"type":"text","part":{"type":"text","text":"答"},"sessionID":"ses_9"}\n'))
  chk('★ 输出真的被解析并推出来', events.some((e) => e.type === 'text' && e.text === '答'), JSON.stringify(events))

  // 收尾：close 事件要带上**最后记住的** sessionId（续接用）
  fakeChild._close(0)
  const end = events.find((e) => e.type === 'end')
  chk('★ close 事件带回 sessionId（原实现靠它续接）', !!end && end.sessionId === 'ses_9' && end.ok === true, JSON.stringify(end))

  // 非 0 退出 → ok:false
  const events2 = []
  const child2 = {
    pid: 1,
    stdout: { on: (n, cb) => { if (n === 'data') child2._o = cb } },
    stderr: { on: (n, cb) => { if (n === 'data') child2._e = cb } },
    on: (n, cb) => { if (n === 'close') child2._c = cb },
  }
  runOpencodeOnce({ spawn: () => child2, findBin: () => '/x/opencode' }, { prompt: 'p', onEvent: (e) => events2.push(e) })
  child2._c(1)
  chk('非 0 退出 → ok:false 且带 code', events2.some((e) => e.type === 'end' && e.ok === false && e.code === 1))
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
process.exit(fail === 0 ? 0 : 1)
