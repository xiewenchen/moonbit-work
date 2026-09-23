// AI Agent（第 5 个标签）—— 把 opencode 的流式输出画成对话界面。
//
// 后端已在 agent.js 就绪，这里**只做界面**。约定（见 agent.js / preload.js）：
//   agentStatus()                     -> { installed, bin, version, model, configPath }
//   agentRun({ prompt, cwd, model })  -> { ok, pid } | { ok:false, error }
//   onAgentStart() / onAgentData({ type, text }) / onAgentEnd({ ok, code })
//
// 刻意不做的边界（用户明确要求卡死）：多轮上下文、模型切换、token 统计。
// 一次发送 = 一次独立的 `opencode run`，不保留上文。
(function () {
  const $ = (id) => document.getElementById(id)
  const api = window.moonAPI
  if (!api || !api.agentRun || !api.agentStatus) return

  const logEl = $('agLog')
  const inputEl = $('agInput')
  const sendBtn = $('agSend')
  const stopBtn = $('agStop')
  const statusEl = $('agStatus')
  const cfgBtn = $('agConfig')
  const newBtn = $('agNew')
  if (!logEl || !inputEl) return

  let busy = false    // 是否有任务在跑
  let bubble = null   // 当前正在流式填充的助手气泡
  let lastErr = ''    // 去重：同一条错误短时间内只显示一次
  let lastErrAt = 0
  // ★ 多轮：记住当前会话 id —— 有它就续接，没有就是新会话
  //   opencode 的会话存在它自己那边，我们只要记 id 就行。
  let currentSession = ''
  try { currentSession = localStorage.getItem('moonbit-agent-session') || '' } catch (_) {}

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }

  // 开一段新对话：清空界面与记住的会话 id（下次发送就是新会话）
  function newChat() {
    if (busy) { addErr('正在运行中，先点「停止」再开新对话'); return }
    currentSession = ''
    try { localStorage.removeItem('moonbit-agent-session') } catch (_) {}
    bubble = null
    logEl.textContent = ''
    showEmpty()
  }
  function showEmpty() {
    logEl.appendChild(el('div', 'ag-empty',
      '用自然语言描述你要做的事。\nCtrl+Enter 发送；同一个对话会记住上文（多轮），点「新对话」重新开始。'))
  }
  const atBottom = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48
  const stick = () => { logEl.scrollTop = logEl.scrollHeight }
  const cwdOf = () => { const c = $('cwd'); return c && c.value ? c.value : '' }
  const clearEmpty = () => { const e = logEl.querySelector('.ag-empty'); if (e) e.remove() }

  function addUser(text) { clearEmpty(); logEl.appendChild(el('div', 'ag-msg user', text)); stick() }
  function addTool(text) { clearEmpty(); logEl.appendChild(el('div', 'ag-tool', '调用工具：' + text)); if (atBottom()) stick() }
  function addAi() { clearEmpty(); bubble = el('div', 'ag-msg ai', ''); logEl.appendChild(bubble); stick(); return bubble }
  function addErr(text) {
    const now = Date.now()
    if (text === lastErr && now - lastErrAt < 1500) return
    lastErr = text; lastErrAt = now
    clearEmpty(); logEl.appendChild(el('div', 'ag-msg err', text)); stick()
  }

  function setBusy(v) {
    busy = v
    if (sendBtn) sendBtn.disabled = v
    if (stopBtn) stopBtn.disabled = !v
    if (inputEl) inputEl.disabled = v
  }

  async function refreshStatus() {
    if (!statusEl) return
    try {
      const st = await api.agentStatus()
      if (st && st.installed) {
        statusEl.className = 'ag-status ok'
        statusEl.textContent = '已就绪' + (st.version ? ' · opencode ' + st.version : '') + (st.model ? ' · 模型 ' + st.model : '')
      } else {
        statusEl.className = 'ag-status bad'
        statusEl.textContent = '未找到 opencode —— npm i -g opencode-ai 安装后重启 IDE'
      }
    } catch (e) {
      statusEl.className = 'ag-status bad'
      statusEl.textContent = '状态检查失败：' + e.message
    }
  }

  async function send() {
    if (busy) return
    const prompt = String(inputEl.value || '').trim()
    if (!prompt) return
    addUser(prompt)
    inputEl.value = ''
    setBusy(true)
    addAi() // 先建一个空气泡，流式内容往里填
    try {
      const r = await api.agentRun({ prompt, cwd: cwdOf(), sessionId: currentSession || undefined })
      // 「未安装 opencode」这类失败路径不会发 agent:end，所以这里必须兜底
      if (r && r.ok === false) {
        if (bubble) { bubble.remove(); bubble = null }
        addErr(r.error || '无法启动 opencode')
        setBusy(false)
      }
    } catch (e) {
      if (bubble) { bubble.remove(); bubble = null }
      addErr('调用失败：' + e.message)
      setBusy(false)
    }
  }

  function stop() { if (busy && api.agentStop) api.agentStop() }

  // ── 后端事件 ────────────────────────────────────────────────────
  if (api.onAgentData) api.onAgentData((d) => {
    if (!d || !d.type) return
    if (d.type === 'text') {
      if (!bubble) addAi()
      bubble.textContent += d.text || ''
      if (atBottom()) stick()
    } else if (d.type === 'tool') {
      addTool(d.text || 'tool')
    } else if (d.type === 'error') {
      addErr(d.text || '运行出错')
    }
    // 'raw'（未解析成 JSON 的行）与 'meta'（tokens/cost）刻意不显示：
    // 前者会刷屏，后者属于「token 统计」—— 本项目边界不做。
  })
  if (api.onAgentEnd) api.onAgentEnd((d) => {
    // 记下会话 id（opencode 在事件里回的）—— 下一轮带上它就能续上文
    if (d && d.sessionId) {
      currentSession = d.sessionId
      try { localStorage.setItem('moonbit-agent-session', currentSession) } catch (_) {}
    }
    setBusy(false)
    if (d && d.ok === false && bubble && !bubble.textContent) {
      bubble.remove(); bubble = null
      addErr('本次任务未成功结束' + (d.code != null ? '（退出码 ' + d.code + '）' : ''))
    }
    bubble = null
    if (inputEl) inputEl.focus()
  })

  // ── 交互 ────────────────────────────────────────────────────────
  if (sendBtn) sendBtn.onclick = send
  if (stopBtn) stopBtn.onclick = stop
  if (newBtn) newBtn.onclick = newChat
  if (cfgBtn) cfgBtn.onclick = () => { if (api.agentOpenConfig) api.agentOpenConfig() }
  if (inputEl) inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
  })

  // renderer.js 的 VIEW_HOOKS 在切到本标签时调用（惰性初始化）
  window.moonbitAgent = { start: refreshStatus }
})()
