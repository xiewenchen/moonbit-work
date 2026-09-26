// PH3-AI-03 第一步：把 opencode 的"启动 + JSON 事件解析"抽成**纯逻辑**模块。
//
// 为什么先抽这一步（而不是直接改 agent.js）：
//   agent.js 里的 agent:run 是**生产路径**（UI 现在就走它），直接改风险高。
//   RULE-04 的渐进迁移是"旧逻辑保住能跑 → 建新接口 → 迁移一个调用点 → 验证"。
//   这里做的是"建新接口 + 等价抽取"：解析与启动参数从 agent.js 搬过来，
//   行为一字不改，但**可以单测**了 —— 而 agent.js 里那段一直无法测（要真起 opencode）。
//
// 抽出来之后，adapter 的 opencode transport 就能复用它。
//
// 依赖全部注入：
//   spawn(bin, args, opts) → child
//   resolveSpawn(bin, args) → { bin, args, shell }   （Windows 上 .cmd/.bat 要走 cmd.exe）
//   findBin() → 可执行文件路径 | null

/** opencode 的事件 → 我们要显示的东西。返回 null 表示"这个过程事件不显示"。 */
function parseOpencodeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null
  const part = ev.part || {}
  // ⚠️ sessionID 要**跟着事件一起带出去** —— 原 agent.js 靠它做多轮续接（--session），
  //    抽出来时差点丢了这个副作用（那样行为就不等价了）。
  const sid = (typeof ev.sessionID === 'string' && ev.sessionID) ? ev.sessionID : null
  const withSid = (o) => (sid ? Object.assign({}, o, { sessionId: sid }) : o)
  if (ev.type === 'text' && typeof part.text === 'string') return withSid({ type: 'text', text: part.text })
  if (ev.type === 'tool' || part.type === 'tool') {
    const name = part.tool || (part.state && part.state.name) || 'tool'
    return withSid({ type: 'tool', name: String(name), state: part.state || null })
  }
  if (ev.type === 'step_finish' && part.tokens) return withSid({ type: 'meta', tokens: part.tokens, cost: part.cost })
  if (ev.type === 'error' || ev.error) return withSid({ type: 'error', error: ev.error })
  // step_start 之类的过程事件不发，避免刷屏；但**只带 sessionID 的事件**仍要传出去
  return sid ? { type: 'session', sessionId: sid } : null
}

/** 把一段 stdout/stderr 文本切成事件。非 JSON 行原样给出（type:'raw'）。 */
function parseOpencodeChunk(text) {
  const out = []
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    if (!line.trim()) continue
    let ev = null
    try { ev = JSON.parse(line) } catch (_) { ev = null }
    if (!ev || typeof ev !== 'object') { out.push({ type: 'raw', text: line }); continue }
    const p = parseOpencodeEvent(ev)
    if (p) out.push(p)
  }
  return out
}

/** 从事件里捡会话 id（多轮续接用）。找不到就返回原值。 */
function sessionIdFrom(ev, fallback) {
  if (ev && typeof ev.sessionID === 'string' && ev.sessionID) return ev.sessionID
  return fallback || ''
}

/**
 * 组装 opencode 命令行。
 * ⚠️ `--format json` 是**必须**的：不加它 opencode 输出人类可读文本，
 *    事件解析会全部落空 → 界面上只有空气泡（实测踩过）。
 */
function buildOpencodeArgs({ prompt, sessionId, model } = {}) {
  const args = ['run', String(prompt || ''), '--format', 'json']
  if (sessionId) args.push('--session', String(sessionId))
  if (model) args.push('--model', String(model))
  return args
}

/**
 * 把 opencode 的一次 run 包装成一个"事件流"。
 *
 * 返回 { ok, pid } 或 { ok:false, error }；事件通过 onEvent 回调推出去。
 * ⚠️ stdin 置 ignore：spawn 默认给子进程一个 stdin 管道，
 *    opencode 这类 CLI 会等它 → 非交互场景下一直不退出（实测 90 秒仍挂着）。
 */
function runOpencodeOnce(deps = {}, opts = {}) {
  const { spawn, resolveSpawn, findBin } = deps
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {}
  if (typeof spawn !== 'function') return { ok: false, error: 'runOpencodeOnce 需要注入 spawn' }
  if (typeof findBin !== 'function') return { ok: false, error: 'runOpencodeOnce 需要注入 findBin' }

  const bin = findBin()
  if (!bin) {
    return {
      ok: false,
      error: '未找到 opencode 可执行文件（npm i -g opencode-ai 安装后重启 IDE）',
      missing: 'opencode',
    }
  }

  const args = buildOpencodeArgs(opts)
  let child
  try {
    const sp = typeof resolveSpawn === 'function' ? resolveSpawn(bin, args) : { bin, args, shell: false }
    child = spawn(sp.bin, sp.args, {
      cwd: opts.cwd || process.cwd(),
      shell: sp.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return { ok: false, error: '启动失败：' + String((e && e.message) || e) }
  }

  let sid = opts.sessionId || ''
  const onData = (buf) => {
    for (const p of parseOpencodeChunk(buf && buf.toString ? buf.toString('utf8') : String(buf == null ? '' : buf))) {
      if (p.sessionId) sid = p.sessionId            // ★ 续接用：记住会话 id（与原 agent.js 等价）
      if (p.type !== 'session') onEvent(p)          // 'session' 只是携带 id 的载体，不显示
    }
  }
  if (child.stdout && child.stdout.on) child.stdout.on('data', onData)
  if (child.stderr && child.stderr.on) child.stderr.on('data', onData)
  if (child.on) {
    child.on('error', (e) => onEvent({ type: 'end', ok: false, error: '无法执行 opencode：' + String((e && e.message) || e) }))
    child.on('close', (code) => onEvent({ type: 'end', ok: code === 0, code, sessionId: sid }))
  }
  return { ok: true, pid: child.pid, child, args, bin }
}

module.exports = {
  parseOpencodeEvent,
  parseOpencodeChunk,
  sessionIdFrom,
  buildOpencodeArgs,
  runOpencodeOnce,
}
