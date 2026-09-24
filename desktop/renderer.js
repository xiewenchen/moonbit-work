// 渲染进程：文件树 + 多标签编辑器 + 打开/保存 + 命令面板 + 状态栏 + 输出面板。

const $ = (id) => document.getElementById(id)
// ---------------------------------------------------------------------------
// 活动栏：5 个主标签（主菜单 / 项目 / 文件中转站 / AI Agent / 工具）
//
// 为什么放在 initCore 而不是 wireUI：wireUI 只在 Monaco 加载成功后才跑，
// Monaco 一挂活动栏就没了 —— 之前踩过这个坑（整个 UI 失效）。
const VIEW_META = {
  home: ['主菜单', '时钟 / 日历 / 日程 / 待办 / 便签'],
  project: ['资源管理器', '文件树 / 搜索 / 大纲'],
  agent: ['文件中转站', 'Office 文档备份与版本还原'],
  ai: ['AI Agent', 'opencode 驱动的对话式编码助手'],
  tools: ['工具', '后端控制 / 接口调试 / 终端'],
}
const VIEW_ORDER = ['home', 'project', 'agent', 'ai', 'tools']

// 各标签内容填好后挂在这里，切过去时惰性初始化一次
const VIEW_HOOKS = {
  // 主菜单 = 办公组件（时钟/日历/日程/待办/便签），实现在 dash.js
  home: () => { if (window.moonbitDash) window.moonbitDash.start() },
  // 文件中转站（第三个标签），实现在 relay.js
  agent: () => { if (window.moonbitRelay) window.moonbitRelay.refresh() },
  // AI Agent（第五个标签），实现在 aiagent.js
  ai: () => { if (window.moonbitAgent) window.moonbitAgent.start() },
}

function switchView(name, remember) {
  if (!VIEW_ORDER.includes(name)) name = 'project'
  // 导航项是 Strapi 外壳里的 <a data-view>（转译后不再有 #activitybar）
  for (const el of document.querySelectorAll('a[data-view]')) {
    el.classList.toggle('active', el.dataset.view === name)
  }
  for (const el of document.querySelectorAll('#sidebar .view')) {
    el.classList.toggle('active', el.id === 'view-' + name)
  }
  // 主内容区也要跟着切 —— 否则「主菜单」里也会显示编辑器（转译后 main 下有 4 个 .mainview）
  for (const el of document.querySelectorAll('.mainview')) {
    el.classList.toggle('active', el.id === 'mainview-' + name)
  }
  // 记录当前所在标签。无项目态的样式只作用于「项目」标签
  // （见 CSS：body.no-project[data-view="project"]），
  // 主菜单/文件中转站/工具等标签在未打开项目时照常可用。
  document.body.dataset.view = name
  if (remember !== false) {
    try { localStorage.setItem('moonbit-view', name) } catch (_) {}
  }
  const hook = VIEW_HOOKS[name]
  if (hook) {
    try { hook() } catch (e) { logLine('视图初始化失败 [' + name + ']：' + e.message, 'err') }
  }
}

function initActivityBar() {
  // 转译后：左侧导航来自 Strapi 外壳，导航项是 <a data-view="...">
  const items = document.querySelectorAll('a[data-view]')
  if (!items.length) {
    logLine('未找到导航项（a[data-view]）', 'err')
    return
  }
  for (const el of items) {
    el.onclick = (e) => {
      e.preventDefault()
      switchView(el.dataset.view)
    }
  }
  // 空视图先给一句说明，否则切过去是白屏，像坏了一样
  for (const name of VIEW_ORDER) {
    const el = $('view-' + name)
    if (el && el.childNodes.length === 0 && !VIEW_HOOKS[name]) {
      emptyState(el, VIEW_META[name][0], VIEW_META[name][1] + '（待填充）')
    }
  }
  let saved = null
  try { saved = localStorage.getItem('moonbit-view') } catch (_) {}
  // 默认落在「主菜单」—— 主页是办公台，不是代码编辑器。
  // 另外：**未打开项目时忽略上次记忆的标签**。否则上次退出在「项目」标签的话，
  // 启动就直接落在只有「打开/新建」的欢迎页上，用户会以为整个 IDE 不可用。
  // 用权威状态判定，**不要**读 body 的 no-project 类：
  // initActivityBar 在 showWelcome()（由它添加 no-project 类）之前执行，
  // 直接读类名会得到 false —— 「无项目时强制落主菜单」就会失效（实测踩过）。
  // P2-06 / P2-15：判据已是 ProjectContext（旧变量 rootDir 已删）
  const noProject = !window.moonbitProjectContext.hasProject(projectCtx)
  const pick = (noProject || !saved || !VIEW_ORDER.includes(saved)) ? 'home' : saved
  switchView(pick, false)
}

const outEl = $('output')

// 输出面板初始为空时给一句说明 —— 否则用户点进去是一片空白，
// 不知道是"没开始跑"还是"坏了"（GUI 实测就卡在这里）。
function initOutputEmptyState() {
  if (outEl.childNodes.length === 0) {
    emptyState(outEl, '暂无输出', '运行一次 check / build / test 就会有内容')
  }
}
const tabsEl = $('tabs')
const treeEl = $('tree')
const cwdInput = $('cwd')

let monaco = null
let editor = null
// 单一工程上下文（ProjectContext）—— 全 IDE 唯一的「当前项目」（见 project-context.js）。
// P2-15：旧变量 rootDir 已删除（它此后只剩「写」没有「读」）；
// projectInfoCache / lspRoot 仍在用，按 RULE-04 逐个处理（一次删一个 + 回归）。
let projectCtx = null

// 传给主进程的「根」：优先用单一工程上下文（P2），但**必须与地址栏一致**才认 ——
// 否则可能拿一个过期上下文去调 IPC（例如用户手改了地址栏、还没重新打开项目）。
// 不一致（或还没打开项目）时退回地址栏的值，行为与迁移前完全一致。
function projectRootInput() {
  const root = (cwdInput.value || '').trim()
  if (projectCtx && projectCtx.rootDir === root) return projectCtx
  return root
}

// 需要「字符串路径」的场合（如 LSP 的 lspRoot 比较）
function projectRootPath() {
  return window.moonbitProjectContext.rootOfInput(projectRootInput())
}
const tabs = [] // { path, model }
let active = -1

// --------------------------------------------------------------------------- 输出
const MAX_LOG_NODES = 2000
// ---------------------------------------------------------------------------
// 运行时堆栈解析（手册 3.4 / 5.3）
//
// MoonBit 后端在程序崩溃时会打印调用栈，形如 `at foo.mbt:12:5`；
// 我们把其中的 文件:行:列 抠出来，做成「可点击跳转 + 行高亮」，
// 这样「跑起来报错 → 点一下到出错那行」是通的，而不只是把堆栈打印在终端里。
// 注意两点，都是被真实堆栈教出来的：
//  ① 字符类里**必须包含 `:`**。少了它，遇到 Windows 盘符 `C:\proj\app\guard.mbt:49:28` 时——
//     `C` 能匹配但紧跟的 `:` 不能，正则回溯后从 `proj` 开始，盘符 `C:/` 就被吃掉了。
//  ② **列号是可选的**。实测 MoonBit native 后端的崩溃堆栈长这样：
//         at @mbp/.../crashprobe.crash_probe (...\crashprobe\main.mbt:7)
//         at main (...\crashprobe\main.mbt:14)
//     只有 `文件.mbt:行`，**没有列**。早先写成 `:(\d+):(\d+)` 会把整条堆栈漏掉。
const STACK_LOC_RE = /([A-Za-z0-9_\-.\\/:]+\.mbt):(\d+)(?::(\d+))?/g
// 只有这些上下文里的位置才算"运行时错误位置"，避免把普通日志里的路径也当成错误
const RUNTIME_HINT_RE = /panic|Panic|Error|error:|FAILED|abort|unreachable|assert/i

let runtimeLocs = []
// 「错误上下文」的有效窗口。
// 必要性：scanRuntimeStack 是**逐块**被调用的，stdout 的分块位置不由我们决定 ——
// `PanicError` 可能在一个数据块里，而 `at ... main.mbt:7` 在下一个数据块里。
// 若要求"同一块里必须同时有提示词和位置"，堆栈就会被整条漏掉。
// 所以改成：见到提示词后开一个时间窗，窗口内的位置都算运行时错误位置。
let runtimeHintUntil = 0
const RUNTIME_HINT_WINDOW_MS = 3000

function scanRuntimeStack(text) {
  if (RUNTIME_HINT_RE.test(text)) runtimeHintUntil = Date.now() + RUNTIME_HINT_WINDOW_MS
  if (Date.now() > runtimeHintUntil) return
  let m
  STACK_LOC_RE.lastIndex = 0
  const hits = []
  while ((m = STACK_LOC_RE.exec(text)) !== null) {
    // 第 3 组（列）可能不存在 —— MoonBit native 堆栈只给到行号
    hits.push({
      file: m[1],
      line: parseInt(m[2], 10),
      col: m[3] ? parseInt(m[3], 10) : 1,
    })
  }
  if (!hits.length) return
  // 去重（同一个位置反复打印时只留一条）
  for (const h of hits) {
    if (!runtimeLocs.some((x) => x.file === h.file && x.line === h.line)) {
      runtimeLocs.push(h)
    }
  }
  // 最多留 50 条，防止长时间运行把面板撑爆
  if (runtimeLocs.length > 50) runtimeLocs = runtimeLocs.slice(-50)
  refreshProblemPanel()
  highlightErrorLines()
}

function log(text, cls) {
  // 首次写入前先把空状态提示清掉（否则日志会接在提示下面）
  if (outEl.querySelector('.empty-state')) outEl.innerHTML = ''
  const span = document.createElement('span')
  if (cls) span.className = cls
  span.textContent = text
  outEl.appendChild(span)
  // 顺带扫一遍运行时堆栈（成本很低：一次正则命中判定）
  try { scanRuntimeStack(text) } catch (_) {}
  // 裁剪：长时间运行（如反复跑 moon test）会让 DOM 节点无限增长 → 界面卡顿。
  // 只保留最近 MAX_LOG_NODES 个节点。
  while (outEl.childElementCount > MAX_LOG_NODES) {
    outEl.removeChild(outEl.firstChild)
  }
  outEl.scrollTop = outEl.scrollHeight
}
function logLine(text, cls) {
  log(text + '\n', cls)
}
function setMsg(msg) {
  $('stMsg').textContent = msg
}

// --------------------------------------------------------------------------- 标签
function renderTabs() {
  tabsEl.innerHTML = ''
  tabs.forEach((t, i) => {
    const el = document.createElement('div')
    el.className = 'tab' + (i === active ? ' active' : '')
    const name = document.createElement('span')
    name.textContent = t.path.split(/[\\/]/).pop()
    el.appendChild(name)
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '×'
    x.onclick = (e) => {
      e.stopPropagation()
      closeTab(i)
    }
    el.appendChild(x)
    el.onclick = () => setActive(i)
    tabsEl.appendChild(el)
  })
}

function setActive(i) {
  active = i
  if (i >= 0) {
    editor.setModel(tabs[i].model)
    $('stFile').textContent = tabs[i].path
  } else {
    editor.setModel(null)
    $('stFile').textContent = '—'
  }
  renderTabs()
  // 切文件后刷新大纲（异步，不阻塞）
  setTimeout(() => {
    refreshOutline().catch(() => {})
  }, 0)
}

function closeTab(i) {
  const t = tabs[i]
  tabs.splice(i, 1)
  if (t) t.model.dispose()
  if (active >= tabs.length) active = tabs.length - 1
  setActive(active)
}

async function openFile(filePath) {
  // 上报给「文件中转站」：IDE 里打开过的文件属于它要跟踪的范围之一
  try { if (window.moonAPI.relayTouch) window.moonAPI.relayTouch(filePath) } catch (_) {}
  const idx = tabs.findIndex((t) => t.path === filePath)
  if (idx >= 0) {
    setActive(idx)
    return
  }
  const res = await window.moonAPI.readFile(filePath)
  if (!res.ok) {
    logLine(res.error, 'err')
    return
  }
  const uri = monaco.Uri.file(filePath)
  let model = monaco.editor.getModel(uri)
  if (!model) model = monaco.editor.createModel(res.content, res.language, uri)
  tabs.push({ path: filePath, model })
  setActive(tabs.length - 1)
  setMsg('打开 ' + filePath)
}

// 保存时是否自动跑 moon fmt（默认开；可用命令面板切换，记在 localStorage）
let fmtOnSave = (() => {
  try {
    const v = localStorage.getItem('moonbitIde.fmtOnSave')
    return v === null ? true : v === '1'
  } catch (_) {
    return true
  }
})()

function setFmtOnSave(on) {
  fmtOnSave = on
  try {
    localStorage.setItem('moonbitIde.fmtOnSave', on ? '1' : '0')
  } catch (_) {}
  logLine('保存时格式化：' + (on ? '已开启' : '已关闭'))
  setMsg('保存时格式化：' + (on ? '开' : '关'))
}

async function saveActive() {
  const t = tabs[active]
  if (!t) return
  const res = await window.moonAPI.writeFile(t.path, editor.getValue())
  if (!res.ok) {
    logLine(res.error, 'err')
    return
  }
  logLine(`已保存 ${t.path}（${res.bytes} 字节）`, 'ok')
  toast('已保存 ' + t.path.split(/[\\/]/).pop(), 'ok')

  // 保存后格式化：moon fmt <file> 会格式化「包含该文件的那个包」，
  // 因此它可能改写磁盘内容 → 之后必须**回读**并把新内容同步进编辑器，
  // 否则编辑器里显示的和磁盘上的就分叉了（下次保存会把旧内容写回去）。
  if (fmtOnSave) {
    try {
      const f = await window.moonAPI.formatFile(projectRootInput(), t.path)
      if (f.ok) {
        const after = await window.moonAPI.readFile(t.path)
        if (after.ok && typeof after.content === 'string' && after.content !== editor.getValue()) {
          const pos = editor.getPosition()
          editor.setValue(after.content)
          if (pos) editor.setPosition(pos)
          logLine('已按 moon fmt 重新排版', 'ok')
        }      } else {
        // 语法错误时 fmt 会失败 —— 不影响保存本身，只提示一句
        logLine('跳过格式化（moon fmt 未成功，通常是语法未通过）', 'err')
      }
    } catch (e) {
      logLine('格式化异常：' + e, 'err')
    }
  }

  setMsg('已保存')
  // 保存后自动做一次语义检查（诊断）+ 刷新大纲
  runDiagnostics().catch(() => {})
  refreshOutline().catch(() => {})
}

// --------------------------------------------------------------------------- 文件树
async function renderTree(dir, container, depth) {
  const res = await window.moonAPI.listDir(dir)
  if (!res.ok) {
    logLine(res.error, 'err')
    emptyState(container, '无法读取目录', res.error)
    return
  }
  // 只在根目录为空时给提示（递归里的空子目录不提示，否则到处是空状态）
  if (res.entries.length === 0 && depth === 0) {
    emptyState(container, '这个文件夹是空的', '里面还没有任何文件')
    return
  }
  for (const e of res.entries) {
    const node = document.createElement('div')
    node.className = 'node'
    node.style.paddingLeft = 8 + depth * 14 + 'px'
    const mark = document.createElement('span')
    mark.className = 'ico'
    // 目录用 SVG 小箭头，不用 ▸/▾ 这类字符图标
    if (e.dir) {
      if (window.MBIcons) window.MBIcons.into(mark, 'chevronRight', 12)
      else mark.textContent = '>'
      mark.classList.add('dir-i')
    } else {
      mark.textContent = '·'
    }
    node.appendChild(mark)
    node.appendChild(document.createTextNode(e.name))
    container.appendChild(node)

    if (e.dir) {
      let childBox = null
      node.onclick = async () => {
        if (childBox) {
          childBox.remove()
          childBox = null
          mark.classList.remove('open')   // SVG 箭头靠 CSS 旋转表示展开态
          return
        }
        mark.classList.add('open')
        childBox = document.createElement('div')
        node.after(childBox)
        await renderTree(e.path, childBox, depth + 1)
      }
    } else {
      node.onclick = () => {
        for (const n of treeEl.querySelectorAll('.node.active')) n.classList.remove('active')
        node.classList.add('active')
        openFile(e.path)
      }
    }
  }
}

async function loadTree(dir) {
  treeEl.innerHTML = ''
  await renderTree(dir, treeEl, 0)
}

// --------------------------------------------------------------------------- moon
// ---------------------------------------------------------------------------
// 任务执行（流式，手册 3.1）
//
// 早先是 `runMoonCapture`：等进程结束才一次性拿到全部输出 ——
// 跑 `moon build` 时界面看着像卡死，完了才刷一大坨。
// 现在改成流式：输出边跑边追加，长任务的进度与报错都能立刻看到。
let moonStreamActive = false

// 订阅只做一次（放在 initCore 里调用）——
// 若放在 runMoon 里，每跑一次任务都会多挂一个监听器，输出会被重复打印。
function initMoonStream() {
  window.moonAPI.onMoonStreamData(({ stream, data }) => {
    log(data, stream === 'stderr' ? 'err' : '')
  })
  window.moonAPI.onMoonStreamEnd(({ code, error }) => {
    moonStreamActive = false
    logLine(
      '(exit ' + code + ')' + (error ? '  ' + error : ''),
      code === 0 ? 'ok' : 'err',
    )
    setMsg(code === 0 ? '完成' : '失败（exit ' + code + '）')
    // 任务结束的反馈：Toast 比状态栏一行小字更容易被看到
    toast(code === 0 ? 'moon 任务完成' : 'moon 任务失败（exit ' + code + '）', code === 0 ? 'ok' : 'err')
    // 跑完顺手刷一次诊断与大纲
    runDiagnostics().catch(() => {})
    refreshOutline().catch(() => {})
  })
}

// ---------------------------------------------------------------------------
// Toast：操作反馈（Strapi 的 Toast 同思路 —— 轻量、自动消失、按语义着色）
//
// 为什么不只用状态栏：状态栏文字小、容易被忽略；保存/编译这种"动作完成"的反馈
// 应该是**看得见但不用点掉**的浮层。
const TOAST_KEEP = 2600
function toast(message, kind) {
  const box = document.getElementById('toast')
  if (!box) return
  const el = document.createElement('div')
  el.className = 't' + (kind ? ' ' + kind : '')
  el.textContent = message
  box.appendChild(el)
  // 下一帧再加 show，让 transition 生效
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 220)
  }, TOAST_KEEP)
  // 上限：连续操作时不要把屏幕堆满
  while (box.childNodes.length > 4) box.removeChild(box.firstChild)
}

// EmptyState：给空白区域一句说明（空目录 / 无搜索结果）
function emptyState(container, title, hint) {
  container.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'empty-state'
  const t = document.createElement('span')
  t.className = 't'
  t.textContent = title
  box.appendChild(t)
  if (hint) box.appendChild(document.createTextNode(hint))
  container.appendChild(box)
}

async function runMoon(args) {
  if (moonStreamActive) {
    logLine('已有任务在运行，请先执行「任务: 停止当前任务」', 'err')
    setMsg('已有任务在运行')
    return
  }
  logLine('$ moon ' + args.join(' '), 'cmd')
  setMsg('运行 moon ' + args[0] + '…')
  moonStreamActive = true
  try {
    const res = await window.moonAPI.runMoonStream(args, projectRootInput())
    // 正常结束由 onMoonStreamEnd 收尾；这里只处理"根本没跑起来"
    if (!res.ok && res.error) {
      moonStreamActive = false
      logLine(res.error, 'err')
      setMsg(res.error)
    }
  } catch (e) {
    moonStreamActive = false
    logLine(String(e), 'err')
  }
}

function stopMoon() {
  if (!moonStreamActive) {
    setMsg('当前没有正在运行的任务')
    return
  }
  window.moonAPI.stopMoonStream()
  logLine('已请求停止当前任务…', 'err')
}

// --------------------------------------------------------------------------- 命令面板
let lastDiags = []

function commands() {
  return [
    { label: 'MoonBit: check', run: () => runMoon(['check']) },
    { label: 'MoonBit: build (native)', run: () => runMoon(['build', '--target', 'native']) },
    { label: 'MoonBit: test (native)', run: () => runMoon(['test', '--target', 'native']) },
    { label: 'MoonBit: fmt', run: () => runMoon(['fmt']) },
    { label: 'MoonBit: 运行当前项目', run: () => runProject() },
    { label: 'MoonBit: info', run: () => runMoon(['info']) },
    // 依赖管理
    { label: 'MoonBit: 查看依赖树 (moon tree)', run: () => runMoon(['tree']) },
    { label: 'MoonBit: 更新依赖 (moon update)', run: () => runMoon(['update']) },
    {
      label: 'MoonBit: 添加依赖 (moon add…)',
      needsArg: '包名，例如 moonbitlang/x',
      runWithArg: (pkg) => runMoon(['add', pkg]),
    },
    {
      label: 'MoonBit: 移除依赖 (moon remove…)',
      needsArg: '包名',
      runWithArg: (pkg) => runMoon(['remove', pkg]),
    },
    // 新建项目模板
    { label: '文件: 新建 MoonBit 项目…', run: () => createNewProject() },
    // 任务控制
    { label: '任务: 停止当前任务', run: () => stopMoon() },
    { label: '文件: 保存 (Ctrl+S)', run: () => saveActive() },
    { label: '文件: 关闭当前标签', run: () => closeTab(active) },
    { label: '文件: 打开文件夹', run: () => chooseFolder() },
    // 保存时格式化开关
    {
      label: `设置: 保存时格式化（当前${fmtOnSave ? '开' : '关'}）`,
      run: () => setFmtOnSave(!fmtOnSave),
    },
    { label: '视图: 清空输出', run: () => (outEl.innerHTML = '') },
    { label: '视图: 刷新符号索引（补全/跳转）', run: () => window.__refreshSymbols && window.__refreshSymbols() },
  ]
}

let paletteIndex = 0
let paletteItems = []
// 处于「等待参数」状态时，存着那条待执行的命令（如 moon add 需要包名）
let paletteArgMode = null

function openPalette() {
  paletteArgMode = null
  $('palette').classList.add('open')
  const input = $('paletteInput')
  input.value = ''
  input.placeholder = '输入命令…'
  input.focus()
  filterPalette('')
}
function closePalette() {
  paletteArgMode = null
  $('palette').classList.remove('open')
}

// 执行一条命令。
// 需要参数的命令（如 `moon add <包名>`）**不关面板**，而是就地切到「参数输入」状态，
// 这样命令面板就能承载“命令 + 参数”两步操作，不必再单做一个输入弹窗。
function activateCommand(c) {
  if (!c) return
  if (c.needsArg) {
    paletteArgMode = c
    const input = $('paletteInput')
    input.value = ''
    input.placeholder = c.needsArg
    input.focus()
    const list = $('paletteList')
    list.innerHTML = ''
    const hint = document.createElement('div')
    hint.className = 'cmd sel'
    hint.textContent = `↳ ${c.label}  ——  输入${c.needsArg}后回车执行，Esc 取消`
    list.appendChild(hint)
    return
  }
  closePalette()
  c.run()
}

function submitArg(value) {
  const c = paletteArgMode
  paletteArgMode = null
  closePalette()
  const v = (value || '').trim()
  if (!c || !v) return
  if (typeof c.runWithArg === 'function') c.runWithArg(v)
}
function filterPalette(q) {
  // 参数输入阶段：不要用过滤结果覆盖掉提示
  if (paletteArgMode) return
  const all = commands()
  paletteItems = all.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()))
  paletteIndex = 0
  const list = $('paletteList')
  list.innerHTML = ''
  paletteItems.forEach((c, i) => {
    const el = document.createElement('div')
    el.className = 'cmd' + (i === paletteIndex ? ' sel' : '')
    el.textContent = c.label
    el.onclick = () => activateCommand(c)
    list.appendChild(el)
  })
}
function runPaletteSelection() {
  activateCommand(paletteItems[paletteIndex])
}

async function chooseFolder() {
  const dir = await window.moonAPI.pickDir()
  if (!dir) return
  cwdInput.value = dir
  await boot(dir)
}

// 新建 MoonBit 项目：选父目录 → 输入项目名（保存对话框）→ moon new → 直接打开
async function createNewProject() {
  const parent = (await window.moonAPI.pickDir()) || cwdInput.value
  if (!parent) return
  const dir = await window.moonAPI.pickProjectPath(parent, 'my_project')
  if (!dir) return
  setMsg('正在创建项目…')
  const res = await window.moonAPI.newProject(dir)
  if (!res.ok) {
    logLine('创建失败：' + (res.error || res.stderr || '未知错误'), 'err')
    setMsg('创建失败')
    return
  }
  logLine('已创建 MoonBit 项目：' + dir, 'ok')
  // 直接切到新项目并加载文件树
  cwdInput.value = dir
  await boot(dir)
  setMsg('新项目已就绪')
}

// --------------------------------------------------------------------------- 启动
// ── 欢迎页 ────────────────────────────────────────────────────────────
// 初始化不打开任何项目时显示（成熟 IDE 的做法），而不是偷偷打开一个目录。
// 用户自己选项目 —— 这也是他明确要求的验收点之一。
// 有项目 / 无项目两种界面状态。无项目时由 CSS（body.no-project）只留欢迎页，
// 把编译/运行按钮、命令面板、编辑器、底部面板全部收起 ——
// 不让用户对着一堆点了没反应的控件猜。
function setProjectOpen(open) {
  document.body.classList.toggle('no-project', !open)
}

// 欢迎页两个动作：打开项目 / 新建项目。
// 注意（已知瑕疵）：createProject 用原生 prompt 问项目名 —— 它会**同步阻塞**渲染，
// 和之前 confirm 的“鼠标看不见”是同一类问题。列在待办里，先保证功能可用。
async function createProject() {
  const parent = await window.moonAPI.pickDir()
  if (!parent) return
  const name = window.prompt('新项目名称（只能用字母、数字、下划线，不能以数字开头）：')
  if (!name) return
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    setMsg('项目名不合法')
    return
  }
  setMsg('正在新建 ' + name + '…')
  try {
    await window.moonAPI.runMoon(['new', name], parent)
  } catch (_) {}
  // 建好后直接打开它（`moon new` 成功即目录已存在，不再额外探测 —— 避免依赖
  // 一个可能不存在的 IPC 而静默失败）。
  const target = parent.replace(/[\\/]+$/, '') + '/' + name
  cwdInput.value = target
  await boot(target)
}

function initWelcome() {
  const o = document.getElementById('wsOpen')
  const n = document.getElementById('wsNew')
  if (o) o.onclick = () => chooseFolder()
  if (n) n.onclick = () => createProject()
}

async function showWelcome() {
  const tree = $('tree')
  if (!tree) return
  tree.textContent = ''
  const box = document.createElement('div')
  box.className = 'welcome'
  const t = document.createElement('div')
  t.className = 'w-t'
  t.textContent = '未打开项目'
  const h = document.createElement('div')
  h.className = 'w-h'
  h.textContent = '选择一个文件夹开始；也可以直接把文件夹拖到窗口里。'
  const b = document.createElement('button')
  b.textContent = '打开文件夹…'
  b.onclick = async () => {
    const dir = await window.moonAPI.pickDir()
    if (!dir) return
    cwdInput.value = dir
    await boot(dir)
  }
  box.appendChild(t)
  box.appendChild(h)
  box.appendChild(b)
  tree.appendChild(box)
  setProjectOpen(false)
  setMsg('未打开项目')
}

// ── 运行项目 ────────────────────────────────────────────────────────
// 自动识别可执行入口（MoonBit 的 cmd/*、Node 的 scripts、Python 的 main.py…），
// 单个直接跑，多个弹出来让用户选；运行时不写死 moon。
async function runProject() {
  // P2-08：优先把单一工程上下文交给 Runner（由它自己取 rootDir）；旧的字符串路径仍兼容
  const r = await window.moonAPI.runnerList(projectRootInput())
  if (!r || !r.ok) {
    logLine('入口识别失败：' + (r && r.error ? r.error : '未知错误'), 'err')
    return
  }
  if (!r.runners.length) {
    const dir = cwdInput.value || ''
    // 这类提示最常见的原因是「目录不对」（地址栏为空时，会回落到 IDE 自己的目录去扫）。
    // 所以要把**找的是哪个目录**、**支持哪些类型**都写出来，让用户能自己判断。
    logLine(
      `在「${dir || '(地址栏为空 → 用的是 IDE 所在目录)'}」里没找到可执行的入口。\n` +
      `识别到的项目类型：${r.kind}\n` +
      `支持的类型：MoonBit（moon.mod）、Node（package.json）、Rust（Cargo.toml）、` +
      `Go（go.mod）、Python（main.py / app.py / manage.py 等）\n` +
      (dir ? '' : '→ 地址栏「模块根目录」是空的：请先「打开文件夹」（或把项目文件夹拖进窗口）再点运行。\n'),
      'err')
    setMsg('没找到可执行入口')
    return
  }
  setMsg(`识别到 ${r.runners.length} 个入口`)
  if (r.runners.length === 1) return startRunner(r.runners[0])
  showRunnerPicker(r.runners)
}

function showRunnerPicker(list) {
  const old = document.getElementById('runPicker')
  if (old) old.remove()
  const m = document.createElement('div')
  m.id = 'runPicker'
  m.className = 'fm-ctx'
  const h = document.createElement('div')
  h.className = 'hdr'
  h.textContent = '选择要运行的目标'
  m.appendChild(h)
  for (const x of list) {
    const b = document.createElement('button')
    // 主标题用人话（"运行 hello"），小字给实际命令 —— 给懂的人核对
    const t = document.createElement('span')
    t.className = 'rl'
    t.textContent = x.label
    b.appendChild(t)
    if (x.hint) {
      const hh = document.createElement('span')
      hh.className = 'rh'
      hh.textContent = x.hint
      b.appendChild(hh)
    }
    b.onclick = () => { m.remove(); startRunner(x) }
    m.appendChild(b)
  }
  document.body.appendChild(m)
  const rr = m.getBoundingClientRect()
  m.style.left = Math.max(8, window.innerWidth - rr.width - 24) + 'px'
  m.style.top = '62px'
  setTimeout(() => {
    const off = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', off) } }
    document.addEventListener('mousedown', off)
  }, 0)
}

async function startRunner(spec) {
  outEl.textContent = ''
  logLine(`> ${spec.label}\n`, 'ok')
  const r = await window.moonAPI.runnerRun(spec)
  if (r && r.ok === false) {
    logLine('启动失败：' + r.error, 'err')
    setMsg('启动失败')
    return
  }
  setMsg(`已启动（PID ${r && r.pid ? r.pid : '-'}）`)
  // 服务类程序常启动后不打印日志。若 3.5 秒仍无输出，给出可操作的说明，
  // 而不是让用户对着一片空白猜「是不是没跑起来」。
  setTimeout(() => {
    const txt = (outEl.textContent || '').trim()
    if (txt === '' || txt === '> ' + spec.label) {
      logLine('\n（该进程暂无输出。服务类程序常启动后不打印日志；可访问它监听的端口确认是否已在运行。）\n')
    }
  }, 3500)
}

async function boot(dir) {
  setProjectOpen(true)
  // 注册 Monaco 的补全 / 跳转定义（基于符号索引）
  try {
    registerSymbolProviders()
  } catch (_) {}
  const target = dir || cwdInput.value
  cwdInput.value = target

  // 先识别**这个**项目、再建上下文 —— 不能用 projectInfoCache 里的 kind：
  // 那是上一个项目的识别结果（实测踩过：目录已经换了，projectType 还是旧的）。
  const info = target ? await window.moonAPI.projectInfo(target) : null
  if (info && info.ok) renderProjectKind(info)

  projectCtx = target
    ? window.moonbitProjectContext.create(
        Object.assign({}, (info && info.ok) ? info : {}, { root: target }),
        { entry: projectCtx ? projectCtx.entry : null, activeFile: projectCtx ? projectCtx.activeFile : null },
      )
    : null
  const res = await window.moonAPI.findModule(target)
  if (res.ok && res.module) {
    $('stModule').textContent = `模块：${res.module.name || '—'}@${res.module.version}`
    await loadTree(res.module.dir)
  } else {
    $('stModule').textContent = '模块：—'
    await loadTree(target)
  }
}

/** 关闭当前项目：清掉上下文与依赖它的缓存，回到「无项目态」（P2-18）*/
async function closeProject() {
  projectCtx = null
  projectInfoCache = null
  symbolsList = null
  cwdInput.value = ''
  await showWelcome()
  setMsg('已关闭项目')
  return { ok: true }
}

// 对外的 IDE 入口。
// 存在的理由（P2-17）：自动化点不到系统文件夹对话框，需要一个**显式可调用**的「打开项目」；
// 它同时是 P3（Command Registry）的雏形 —— 同一个动作既给 UI，也给脚本与未来的 Agent。
window.moonbitIDE = {
  openProject: (dir) => boot(dir),      // 等价于用户「打开文件夹」之后走的那条路
  closeProject,
  getContext: () => projectCtx,         // 冻结对象，只读
  hasProject: () => window.moonbitProjectContext.hasProject(projectCtx),
  describe: () => window.moonbitProjectContext.describeContext(projectCtx),
}

// 顶栏按钮的中文名（给提示语用）
const CMD_CN = { check: '检查代码', build: '编译', test: '跑测试', fmt: '格式化', run: '运行项目' }

// Node 项目：把顶栏那几个按钮映射到 npm 脚本上（没有就明确说没有，别硬跑 moon）
const NPM_TASK = {
  build: ['build'],
  test: ['test'],
  fmt: ['format', 'fmt', 'lint'],
  check: ['typecheck', 'lint'],
}
async function runNpmTask(c, cwd) {
  const dir = String(cwd || '').replace(/[\\/]+$/, '')
  let scripts = {}
  // moonAPI.readFile 返回的是对象 { ok, path, content, language } ——
  // 之前写成 JSON.parse(String(res)) 得到 "[object Object]"，解析失败又被 catch 吞掉，
  // 于是「读不到」被当成了「没有 scripts」（静默失败，实测被 verify-run-dispatch 抓到）。
  const res = await window.moonAPI.readFile(dir + '/package.json').catch((e) => ({ ok: false, error: String(e && e.message || e) }))
  if (!res || !res.ok || typeof res.content !== 'string') {
    logLine('读不到 package.json：' + ((res && res.error) || '未知错误') + '\n（要跑 npm 命令，这个项目得先有 package.json）', 'err')
    setMsg('读不到 package.json')
    return
  }
  try { scripts = (JSON.parse(res.content).scripts) || {} }
  catch (e) {
    logLine('package.json 解析失败：' + (e && e.message), 'err')
    setMsg('package.json 格式有误')
    return
  }
  const want = NPM_TASK[c] || []
  const hit = want.find((w) => scripts[w])
  if (!hit) {
    const have = Object.keys(scripts).join('、') || '（没有 scripts）'
    logLine(`这个 Node 项目没有对应「${CMD_CN[c] || c}」的脚本。\n可用脚本：${have}\n想启动项目请点「运行项目」从列表里挑（一般选「开发模式启动」或「启动服务」）。`, 'err')
    setMsg('没有对应的 npm 脚本')
    return
  }
  startRunner({ label: `运行 ${hit}`, bin: 'npm', args: ['run', hit], cwd: dir })
}

function wireUI() {
  for (const btn of document.querySelectorAll('button[data-cmd]')) {
    btn.onclick = async () => {
      const c = btn.dataset.cmd
      // 「运行」不写死 ./cmd/main，而是自动识别项目的可执行入口让用户选
      if (c === 'run') { runProject(); return }

      // 按**项目类型**分派命令。之前一律 `runMoon([c])`，
      // 于是在 Node 项目上点「跑测试」会报 "not in a Moon project"（用户报过）。
      const cwd = projectRootInput()
      let kind = ''
      try { const info = await window.moonAPI.projectInfo(cwd); kind = (info && info.kind) || '' } catch (_) {}
      if (kind === 'node') { runNpmTask(c, cwd); return }
      if (!kind || kind === 'moonbit') { runMoon([c]); return }
      // rust / go / python 之类：给一句明确的话，别硬跑 moon
      logLine(`「${CMD_CN[c] || c}」对应的是 moon 命令，而当前项目类型是 ${kind}。\n请用该语言自己的工具（或在终端里执行）。`, 'err')
      setMsg('该命令不适用于当前项目类型')
    }
  }
  $('openFolder').onclick = chooseFolder
  $('cmdBtn').onclick = openPalette
  $('clearPanel').onclick = () => {
    outEl.innerHTML = ''
    if (term) term.clear()
  }
  // 面板切换：输出 / 终端
  document.querySelectorAll('#panelHead span[data-panel]').forEach((el) => {
    el.onclick = () => showPanel(el.dataset.panel)
  })
  window.addEventListener('resize', () => {
    try {
      if (fitAddon) fitAddon.fit()
    } catch (_) {}
  })
  // 注意：后端面板/接口面板/项目识别的初始化**不在这里** ——
  // 它们被移到文件末尾的 initCore()，因为 wireUI 只在 Monaco 加载成功后才会被调用。
  // 搜索框：输入防抖（250ms），回车立即搜
  const si = $('searchInput')
  if (si) {
    si.oninput = (e) => {
      clearTimeout(searchTimer)
      const q = e.target.value.trim()
      searchTimer = setTimeout(() => {
        doSearch(q).catch(() => {})
      }, 250)
    }
    si.onkeydown = (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchTimer)
        doSearch(si.value.trim()).catch(() => {})
      }
    }
  }

  $('paletteInput').oninput = (e) => {
    if (paletteArgMode) return // 参数输入阶段不过滤命令列表
    filterPalette(e.target.value)
  }
  $('paletteInput').onkeydown = (e) => {
    if (paletteArgMode) {
      if (e.key === 'Enter') {
        submitArg($('paletteInput').value)
      } else if (e.key === 'Escape') {
        openPalette() // 退回命令列表
      }
      return
    }
    if (e.key === 'ArrowDown') {
      paletteIndex = Math.min(paletteIndex + 1, paletteItems.length - 1)
      filterPalette($('paletteInput').value)
    } else if (e.key === 'ArrowUp') {
      paletteIndex = Math.max(paletteIndex - 1, 0)
      filterPalette($('paletteInput').value)
    } else if (e.key === 'Enter') {
      runPaletteSelection()
    } else if (e.key === 'Escape') {
      closePalette()
    }
  }
  $('palette').onclick = (e) => {
    if (e.target.id === 'palette') closePalette()
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault()
      openPalette()
    }
  })
}

// --------------------------------------------------------------------------- Ghost Text 候选
//
// 候选来源 = MoonBit 关键字 + **当前文件里出现过的标识符**（按 model 版本缓存）。
// 刻意不查全量符号索引：那样每次输入都要算，会明显拖慢输入；
// 当前取舍是"够用且不卡"。放在模块级是为了能被直接单测/调试。
const MB_KEYWORDS = [
  'fn', 'let', 'mut', 'const', 'type', 'struct', 'enum', 'trait', 'impl', 'match',
  'if', 'else', 'while', 'for', 'in', 'break', 'continue', 'return', 'pub', 'priv',
  'async', 'await', 'raise', 'try', 'catch', 'noraise', 'true', 'false', 'self',
  'test', 'extern', 'derive', 'guard', 'with', 'init', 'main', 'import', 'package',
]
let inlineCache = { version: -1, words: [] }

function inlineCandidates(model) {
  const ver = model.getVersionId()
  if (inlineCache.version === ver) return inlineCache.words
  const words = new Set(MB_KEYWORDS)
  const text = model.getValue()
  const re = /[a-zA-Z_][a-zA-Z0-9_]{2,}/g
  let m
  // 大文件截断扫描，避免每次输入都跑全文正则
  const scan = text.length > 200000 ? text.slice(0, 200000) : text
  while ((m = re.exec(scan)) !== null) words.add(m[0])
  inlineCache = { version: ver, words: Array.from(words) }
  return inlineCache.words
}

// --------------------------------------------------------------------------- Monaco 引导
//
// 重要：**编辑器只是"锦上添花"，不能是单点故障**。
// 早先把 wireUI() / boot() 全塞进这里的回调，导致 Monaco 一旦没加载成功，
// 文件树、面板、按钮绑定统统失效 —— 界面看起来「只是个空壳子」。
// 现在核心初始化移出回调（见文件末尾的 initCore），这里只管编辑器本身。
require.config({ paths: { vs: './node_modules/monaco-editor/min/vs' } })
require(
  ['vs/editor/editor.main'],
  () => {
    try {
      monaco = window.monaco
      registerMoonBit(monaco)
      // 定义 Monaco 主题：**与外围 UI 用同一套 Strapi token**，
      // 否则编辑器里还是 VS Code 配色，和外面的紫调割裂（用户点名的"编辑器是另一个世界"）。
      // 颜色取值一律对齐 index.html 里的 --s-* 变量（改主题时两边一起改）。
      monaco.editor.defineTheme('strapi-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'keyword', foreground: '7B79FF' },      // --s-primary
          { token: 'string', foreground: '5CB176' },       // --s-success
          { token: 'number', foreground: 'F29D41' },       // --s-warning
          { token: 'comment', foreground: '666687' },      // --s-n600
          { token: 'type', foreground: '66B7F1' },         // --s-info
          { token: 'identifier', foreground: 'EAEAEF' },
          { token: 'delimiter', foreground: 'A5A5BA' },
        ],
        colors: {
          'editor.background': '#181826',                  // --s-bg-deepest
          'editor.foreground': '#EAEAEF',                  // --s-text
          'editorLineNumber.foreground': '#4A4A6A',
          'editorLineNumber.activeForeground': '#A5A5BA',
          'editor.lineHighlightBackground': '#212134',     // --s-bg-panel
          'editor.selectionBackground': '#4945FF66',
          'editorCursor.foreground': '#7B79FF',
          'editorIndentGuide.background1': '#32324D',
          'editorIndentGuide.activeBackground1': '#4A4A6A',
          'editorWidget.background': '#212134',
          'editorWidget.border': '#32324D',
          'editorSuggestWidget.background': '#212134',
          'editorSuggestWidget.selectedBackground': '#37375C',
          'editorSuggestWidget.border': '#32324D',
          'editorHoverWidget.background': '#212134',
          'editorHoverWidget.border': '#32324D',
          'scrollbarSlider.background': '#4A4A6A80',
          'scrollbarSlider.hoverBackground': '#66668790',
          // 诊断色也对齐 Strapi 语义色（否则红黄绿是另一套）
          'editorError.foreground': '#EE5E52',
          'editorWarning.foreground': '#F29D41',
          'editorInfo.foreground': '#66B7F1',
        },
      })
      // 浅色主题：与 :root[data-theme="light"] 的角色一一对应，只换值。
      // 编辑器底色取 #FBFBFD 而不是纯白 —— 按 Solarized 的说法，
      // 纯白底 + 深字在屏幕上等于"直射阳光下看书"，略压一点更耐看。
      monaco.editor.defineTheme('strapi-light', {
        base: 'vs',
        inherit: true,
        rules: [
          { token: 'keyword', foreground: '4945FF' },
          { token: 'string', foreground: '328048' },
          { token: 'number', foreground: 'D9822F' },
          { token: 'comment', foreground: '8E8EA9' },
          { token: 'type', foreground: '0C75AF' },
          { token: 'identifier', foreground: '32324D' },
          { token: 'delimiter', foreground: '666687' },
        ],
        colors: {
          'editor.background': '#FBFBFD',
          'editor.foreground': '#32324D',
          'editorLineNumber.foreground': '#C0C0CF',
          'editorLineNumber.activeForeground': '#666687',
          'editor.lineHighlightBackground': '#F0F0FF',
          'editor.selectionBackground': '#D9D8FF',
          'editorCursor.foreground': '#4945FF',
          'editorIndentGuide.background1': '#EAEAEF',
          'editorIndentGuide.activeBackground1': '#C0C0CF',
          'editorWidget.background': '#FFFFFF',
          'editorWidget.border': '#DCDCE4',
          'editorSuggestWidget.background': '#FFFFFF',
          'editorSuggestWidget.selectedBackground': '#F0F0FF',
          'editorSuggestWidget.border': '#DCDCE4',
          'editorHoverWidget.background': '#FFFFFF',
          'editorHoverWidget.border': '#DCDCE4',
          'scrollbarSlider.background': '#C0C0CF80',
          'scrollbarSlider.hoverBackground': '#A5A5BAA0',
          'editorError.foreground': '#D02B20',
          'editorWarning.foreground': '#D9822F',
          'editorInfo.foreground': '#0C75AF',
        },
      })
      // 主题跟随：读当前生效的主题再创建。
      // 之前这里写死 'strapi-dark'，而 theme.js 的 apply 在 Monaco 加载完成前就跑了
      //（那时 window.monaco 还不存在，setTheme 被跳过），结果开机永远是深色 ——
      // 白天模式下编辑器不跟着变就是这个问题。
      const bootTheme = document.documentElement.dataset.theme === 'light' ? 'strapi-light' : 'strapi-dark'
      editor = monaco.editor.create($('editor'), {
        theme: bootTheme,
        automaticLayout: true,
        fontSize: 13,
        // MoonBit 的 moon fmt 用 **2 空格**（实测项目源码的缩进都是 2），
        // 所以这里固定 2 空格并关掉自动探测，避免打开文件后被猜成 4。
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: false,
        // 内联建议（Ghost Text）：输入 th 时以灰字提示 is
        inlineSuggest: { enabled: true },
        value: '// 用左侧文件树打开文件；Ctrl+Shift+P 打开命令面板；Ctrl+S 保存。\n',
        language: 'moonbit',
      })
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        saveActive,
      )
      setMsg('就绪')
    } catch (e) {
      // 编辑器起不来也不能拖垮别的功能
      setMsg('编辑器初始化失败：' + (e && e.message ? e.message : e))
      logLine('Monaco 初始化失败：' + e, 'err')
    }
  },
  (err) => {
    // 早先这里没有失败回调，加载失败是完全静默的 —— 极难排查
    setMsg('编辑器加载失败（其余功能仍可用）')
    logLine('Monaco 加载失败：' + err, 'err')
  },
)


// --------------------------------------------------------------------------- 集成终端
let term = null
let fitAddon = null
let termId = null

async function ensureTerminal() {
  if (term) return
  const el = $('terminal')
  term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'Consolas, ui-monospace, monospace',
    fontSize: 12,
    theme: { background: '#141414', foreground: '#cccccc' },
  })
  fitAddon = new FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.open(el)
  try {
    fitAddon.fit()
  } catch (_) {}
  const res = await window.moonAPI.termCreate(projectRootInput())
  if (!res || res.error) {
    term.writeln('[无法创建终端] ' + (res ? res.error : '未知错误'))
    return
  }
  termId = res.id
  // 键盘输入 → 主进程
  term.onData((d) => window.moonAPI.termInput(termId, d))
  // 尺寸变化 → 主进程（仅 PTY 模式有效）
  term.onResize(({ cols, rows }) => window.moonAPI.termResize(termId, cols, rows))
  // 主进程输出 → 终端
  window.moonAPI.onTermData(({ id, data }) => {
    if (String(id) === String(termId)) term.write(data)
  })
  window.moonAPI.onTermExit(({ id, code }) => {
    if (String(id) === String(termId))
      term.writeln('[进程已退出，代码 ' + code + ']')
  })
}

// 工具标签：把已有工具收成一个入口页。
// 刻意**不重复实现**面板本身 —— 终端/后端/接口都在「项目」标签底部，
// 这里点击即切到那个标签并激活对应面板，避免两套实现走偏。见 initToolsView。
function initToolsView() {
  const el = document.getElementById('mainview-tools')
  if (!el || el.dataset.built === '1') return
  el.dataset.built = '1'
  const items = [
    { n: '集成终端', d: '真 PTY（node-pty），可运行任意命令', panel: 'terminal' },
    { n: '后端控制', d: '一键启停后端服务、实时日志、就绪探针', panel: 'backend' },
    { n: '接口调试器', d: '从 openapi.yml 解析端点，登录后自动填 token', panel: 'api' },
    { n: '运行输出', d: '编译 / 运行日志，错误堆栈可定位到行', panel: 'output' },
    { n: '问题面板', d: '实时诊断与错误行高亮', panel: 'problems' },
    { n: '文件中转站', d: 'Office 文档备份与版本还原', view: 'agent' },
  ]
  const head = document.createElement('div')
  head.className = 'tv-head'
  head.textContent = '工具'
  el.appendChild(head)
  const grid = document.createElement('div')
  grid.className = 'tv-grid'
  for (const it of items) {
    const card = document.createElement('div')
    card.className = 'tv-card'
    const t = document.createElement('div')
    t.className = 'tv-t'
    t.textContent = it.n
    const d = document.createElement('div')
    d.className = 'tv-d'
    d.textContent = it.d
    card.appendChild(t)
    card.appendChild(d)
    card.onclick = () => {
      // 跨标签的入口（如文件中转站）直接切过去
      if (it.view) { switchView(it.view); return }
      // 这些工具都在「项目」标签的底部面板里，而**未打开项目时那是隐藏的**。
      // 所以先提示，而不是切过去给用户一片空白（那是上一版的错误）。
      if (document.body.classList.contains('no-project')) {
        logLine('「' + it.n + '」需要先打开一个项目。已切到「项目」标签，点「打开项目」即可。', 'err')
        switchView('project')
        return
      }
      switchView('project')
      showPanel(it.panel)
    }
    grid.appendChild(card)
  }
  el.appendChild(grid)
}

function showPanel(which) {
  const panel = $('panel')
  const isTerm = which === 'terminal'
  panel.classList.toggle('mode-term', isTerm)
  panel.classList.toggle('mode-problems', which === 'problems')
  panel.classList.toggle('mode-backend', which === 'backend')
  panel.classList.toggle('mode-api', which === 'api')
  if (which === 'backend') {
    loadBackend().catch(() => {})
  }
  document.querySelectorAll('#panelHead span[data-panel]').forEach((el) => {
    el.classList.toggle('active', el.dataset.panel === which)
  })
  if (isTerm) {
    ensureTerminal().then(() => {
      try {
        fitAddon.fit()
        term.focus()
      } catch (_) {}
    })
  }
}

// --------------------------------------------------------------------------- LSP：诊断 / 大纲
async function runDiagnostics() {
  setMsg('moon check 运行中…')
  const res = await window.moonAPI.runCheck(projectRootInput())
  const diags = (res && res.diagnostics) || []
  if (typeof monaco !== 'undefined') {
    for (const m of monaco.editor.getModels()) {
      monaco.editor.setModelMarkers(m, 'moon', [])
    }
    for (const d of diags) {
      let uri
      try {
        uri = monaco.Uri.file(d.file)
      } catch (_) {
        continue
      }
      const model = monaco.editor.getModel(uri)
      if (!model) continue
      const list = monaco.editor.getModelMarkers({ resource: uri, owner: 'moon' })
      list.push({
        startLineNumber: d.line,
        // 列号可能缺失（MoonBit native 崩溃堆栈只给到行号），
        // Monaco 不接受 undefined/NaN —— d.col + 1 会变成 NaN，必须兜底
        startColumn: d.col || 1,
        endLineNumber: d.line,
        endColumn: (d.col || 1) + 1,
        message: d.message + '  [moonc ' + d.code + ']',
        severity:
          d.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : monaco.MarkerSeverity.Warning,
      })
      monaco.editor.setModelMarkers(model, 'moon', list)
    }
  }
  renderProblems(diags)
  logLine('moon check：' + diags.length + ' 条问题', diags.length ? 'err' : 'ok')
  setMsg(diags.length ? diags.length + ' 条问题' : '检查通过')
}

// 编译诊断与运行时位置合并展示：两者都可能出现，且都需要能点击跳转
function refreshProblemPanel() {
  renderProblems(lastDiags)
}

// 错误行高亮（手册 5.3）。
// 用 new 版 Monaco 的 `createDecorationsCollection`；`deltaDecorations` 在新版已废弃。
// 集合对象缓存在闭包里，后续用 set() 替换内容，避免重复创建。
let errorDecorationCollection = null

function highlightErrorLines() {
  if (!editor || typeof monaco === 'undefined' || !monaco) return
  try {
    const decorations = runtimeLocs.map((loc) => ({
      range: new monaco.Range(loc.line, 1, loc.line, 1),
      options: {
        isWholeLine: true,
        className: 'runtime-error-line',
        glyphMarginClassName: 'runtime-error-glyph',
        overviewRuler: {
          color: '#ff6b6b',
          position: monaco.editor.OverviewRulerLane.Right,
        },
      },
    }))
    if (!errorDecorationCollection) {
      errorDecorationCollection = editor.createDecorationsCollection(decorations)
    } else {
      errorDecorationCollection.set(decorations)
    }
  } catch (_) {
    // 装饰失败不影响别的功能
  }
}

function renderProblems(diags) {
  lastDiags = diags || []
  const el = $('problems')
  el.innerHTML = ''
  const rows = []
  for (const d of lastDiags) rows.push({ ...d, kind: 'compile' })
  for (const r of runtimeLocs) {
    rows.push({
      severity: 'error',
      file: r.file,
      line: r.line,
      col: r.col,
      message: '运行时错误位置（来自崩溃堆栈）',
      kind: 'runtime',
    })
  }
  if (!rows.length) {
    const d = document.createElement('div')
    d.className = 'diag'
    d.textContent = '没有问题'
    el.appendChild(d)
    return
  }
  renderProgressRows(el, rows)
}

function renderProgressRows(el, rows) {
  if (!rows.length) {
    const d = document.createElement('div')
    d.className = 'diag'
    d.textContent = '没有问题'
    el.appendChild(d)
    return
  }
  for (const d of rows) {
    const row = document.createElement('div')
    row.className = 'diag ' + d.severity
    const loc = document.createElement('span')
    loc.className = 'loc'
    loc.textContent =
      d.file.split(/[\/]/).pop() + ':' + d.line + (d.col ? ':' + d.col : '') + '  '
    row.appendChild(loc)
    const mark = d.severity === 'error' ? 'x ' : '! '
    row.appendChild(document.createTextNode(mark + d.message))
    row.onclick = async () => {
      await openFile(d.file)
      jumpToLine(d.line, d.col)
    }
    el.appendChild(row)
  }
}

function jumpToLine(line, col) {
  if (!editor) return
  editor.revealLineInCenter(line)
  editor.setPosition({ lineNumber: line, column: col || 1 })
  editor.focus()
}

async function refreshOutline() {
  const el = $('outline')
  if (!el) return 0
  el.innerHTML = ''
  const tab = tabs[active]
  if (!tab) {
    $('outlineHint').textContent = '(无文件)'
    return 0
  }
  $('outlineHint').textContent = '...'
  // 大纲改用 LSP 的 documentSymbol（Step 4 低复杂度项），替换原来自研的 moon ide outline
  const root = await ensureLsp()
  if (!root) {
    $('outlineHint').textContent = '(LSP 未就绪)'
    return 0
  }
  try {
    const model = monaco.editor.getModel(monaco.Uri.file(tab.path))
    await window.moonAPI.lspOpen({ root, file: tab.path, text: model ? model.getValue() : '' })
  } catch (_) {}
  const r = await window.moonAPI.lspDocumentSymbol({ root, file: tab.path })
  const raw = r && r.ok && Array.isArray(r.result) ? r.result : []
  // documentSymbol 可能是树形（有 children）也可能是扁平 SymbolInformation（有 location）
  const flat = []
  const walk = (arr, depth) => {
    for (const s of arr) {
      let line = 0
      if (s.range) line = s.range.start.line + 1
      else if (s.location && s.location.range) line = s.location.range.start.line + 1
      flat.push({ line, name: s.name || '(未命名)', depth })
      if (Array.isArray(s.children) && s.children.length) walk(s.children, depth + 1)
    }
  }
  walk(raw, 0)
  $('outlineHint').textContent = flat.length ? String(flat.length) : '(空)'
  for (const s of flat) {
    const d = document.createElement('div')
    d.className = 'sym'
    d.style.paddingLeft = 8 + s.depth * 10 + 'px'
    d.textContent = s.line ? s.line + '   ' + s.name : s.name
    d.title = s.name
    d.onclick = () => jumpToLine(s.line)
    el.appendChild(d)
  }
  return flat.length
}

// --------------------------------------------------------------------------- 跨文件搜索
let searchTimer = null

async function doSearch(query) {
  const el = $('searchResults')
  el.innerHTML = ''
  if (!query) return
  const res = await window.moonAPI.searchFiles(
    projectRootInput(),
    query,
    true /* caseInsensitive */,
  )
  const items = (res && res.results) || []
  if (items.length === 0) {
    emptyState(el, '没有匹配结果', '试试更短的关键词，或换一个词')
    return
  }
  const shown = items.slice(0, 200)
  for (const it of shown) {
    const row = document.createElement('div')
    row.className = 'hit'
    const loc = document.createElement('span')
    loc.className = 'loc'
    loc.textContent = it.file.split(/[\/]/).pop() + ':' + it.line + '  '
    row.appendChild(loc)
    row.appendChild(document.createTextNode(it.text.trim().slice(0, 120)))
    row.title = it.file + ':' + it.line + ':' + it.col
    row.onclick = async () => {
      await openFile(it.file)
      jumpToLine(it.line, it.col)
    }
    el.appendChild(row)
  }
  const more = items.length > shown.length ? `（显示前 ${shown.length}）` : ''
  const trunc = res && res.truncated ? '（结果已截断）' : ''
  setMsg(`搜索“${query}”：${items.length} 处${more}${trunc}`)
}

// --------------------------------------------------------------------------- 后端面板（PG / Redis）
function backendLine(parent, text, cls) {
  const d = document.createElement('div')
  d.className = cls || 'item'
  d.textContent = text
  parent.appendChild(d)
  return d
}

async function loadBackend() {
  // 注意：数据视图渲染到 #beData，不能是整个 #backend ——
  // 否则 innerHTML='' 会把工具栏（启动/停止按钮）一起清掉。
  const el = $('beData')
  if (!el) return
  el.innerHTML = ''
  backendLine(el, 'PostgreSQL 表：', 'grp')
  const t = await window.moonAPI.adminGet('/api/pg/tables')
  if (t.status !== 200) {
    backendLine(el, '无法连接管理服务（127.0.0.1:8081）：' + String(t.body).slice(0, 120), 'item')
  } else {
    let tables = []
    try {
      tables = JSON.parse(t.body)
    } catch (_) {}
    for (const name of tables) {
      backendLine(el, '  ' + name).onclick = () => showTable(el, name)
    }
  }
  backendLine(el, 'Redis keys：', 'grp')
  const k = await window.moonAPI.adminGet('/api/redis/keys?pattern=*')
  if (k.status === 200) {
    let data = { total: 0, keys: [] }
    try {
      data = JSON.parse(k.body)
    } catch (_) {}
    for (const key of data.keys) {
      backendLine(el, '  ' + key).onclick = () => showRedisValue(el, key)
    }
    backendLine(el, '  (共 ' + data.total + ' 个)', 'grp')
  } else {
    backendLine(el, '  无法读取 Redis', 'item')
  }
}

async function showTable(el, name) {
  const r = await window.moonAPI.adminGet(
    '/api/pg/rows?table=' + encodeURIComponent(name) + '&limit=20',
  )
  const pre = document.createElement('pre')
  if (r.status !== 200) {
    pre.textContent = '读取失败：' + String(r.body).slice(0, 200)
  } else {
    try {
      const d = JSON.parse(r.body)
      const head = (d.columns || []).join(' | ')
      const rows = (d.rows || []).map((row) =>
        (d.columns || []).map((c) => String(row[c] === null ? 'NULL' : row[c])).join(' | '),
      )
      pre.textContent = head + '\n' + '-'.repeat(Math.min(60, head.length)) + '\n' + rows.join('\n')
    } catch (_) {
      pre.textContent = r.body.slice(0, 500)
    }
  }
  el.appendChild(pre)
}

async function showRedisValue(el, key) {
  const r = await window.moonAPI.adminGet('/api/redis/get?key=' + encodeURIComponent(key))
  const pre = document.createElement('pre')
  if (r.status !== 200) {
    pre.textContent = '读取失败：' + String(r.body).slice(0, 200)
  } else {
    try {
      const d = JSON.parse(r.body)
      pre.textContent = d.key + ' = ' + (d.value === null ? '(nil)' : d.value)
    } catch (_) {
      pre.textContent = r.body.slice(0, 500)
    }
  }
  el.appendChild(pre)
}

// --------------------------------------------------------------------------- 符号补全 / 跳转定义（基于 symbols.jsonl 索引）
let symbolsList = null

async function ensureSymbols(force) {
  if (symbolsList && !force) return symbolsList
  const res = await window.moonAPI.loadSymbols(projectRootInput(), !!force)
  symbolsList = (res && res.symbols) || []
  setMsg('符号索引：' + symbolsList.length + ' 项')
  return symbolsList
}

function registerSymbolProviders() {
  if (typeof monaco === 'undefined') return
  // 补全（工作区符号）
  monaco.languages.registerCompletionItemProvider('moonbit', {
    triggerCharacters: ['.', ':', '@', '>'],
    provideCompletionItems: async (model, position) => {
      const w = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: w.startColumn,
        endColumn: w.endColumn,
      }
      let syms = []
      try {
        syms = await ensureSymbols(false)
      } catch (_) {
        return { suggestions: [] }
      }
      const q = (w.word || '').toLowerCase()
      const hits = (q ? syms.filter((s) => s.name.toLowerCase().includes(q)) : syms).slice(0, 80)
      return {
        suggestions: hits.map((s) => ({
          label: s.name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: s.package,
          insertText: s.name,
          range,
        })),
      }
    },
  })
  // 跳转定义（符号索引里找同名）
  // ── LSP 接入（Step 2）──────────────────────────────────────────────
  // 懒启动：第一次真正需要语言能力时才拉起，避免一打开项目就常驻一个进程。
  let lspRoot = null
  async function ensureLsp() {
    const root = projectRootPath()
    if (!root) return null
    if (lspRoot === root) return root
    const r = await window.moonAPI.lspStart(root)
    if (!r || !r.ok) {
      logLine('LSP 启动失败：' + (r && r.error ? r.error : '未知原因'), 'err')
      return null
    }
    lspRoot = root
    logLine('LSP 已就绪（能力 ' + (r.status && r.status.caps ? r.status.caps.length : 0) + ' 项）', 'ok')
    return root
  }
  // Monaco model → 本地文件路径（与主进程 filePathOf 同一口径，保证 URI 一致）
  function monacoPath(model) {
    try { return model.uri.fsPath } catch (_) { return String(model.uri.path || '') }
  }

  monaco.languages.registerDefinitionProvider('moonbit', {
    provideDefinition: async (model, position) => {
      const root = await ensureLsp()
      if (!root) return null
      const file = monacoPath(model)
      // LSP 必须先知道文件内容（没 didOpen 过就发；主进程侧会去重）
      await window.moonAPI.lspOpen({ root, file, text: model.getValue() })
      const res = await window.moonAPI.lspDefinition({
        root,
        file,
        line: position.lineNumber - 1,      // Monaco 1-based → LSP 0-based
        character: position.column - 1,
      })
      if (!res || !res.ok || !res.result) return null
      const locs = Array.isArray(res.result) ? res.result : [res.result]
      const out = []
      for (const loc of locs) {
        if (!loc || !loc.uri || !loc.range) continue
        out.push({
          uri: monaco.Uri.parse(loc.uri),
          range: {
            startLineNumber: loc.range.start.line + 1,   // LSP 0-based → Monaco 1-based
            startColumn: loc.range.start.character + 1,
            endLineNumber: loc.range.end.line + 1,
            endColumn: loc.range.end.character + 1,
          },
        })
      }
      return out.length ? out : null
    },
  })
  // ---- Ghost Text（内联建议）----
  // 候选来源 = MoonBit 关键字 + **当前文件里出现过的标识符**（按 model 版本缓存）。
  // 不查全量符号索引：那样每次输入都要算，会明显拖慢输入；当前的取舍是"够用且不卡"。
  monaco.languages.registerInlineCompletionsProvider('moonbit', {
    provideInlineCompletions: async (model, position) => {
      const w = model.getWordUntilPosition(position)
      const prefix = w.word
      // 至少 2 个字符才提示，避免输入第一个字母就乱跳
      if (!prefix || prefix.length < 2) return { items: [] }
      const hit = inlineCandidates(model).find(
        (c) => c.length > prefix.length && c.startsWith(prefix),
      )
      if (!hit) return { items: [] }
      return {
        items: [
          {
            // 只补"剩下的部分"：Monaco 会把它作为灰字接在光标后
            insertText: hit.slice(prefix.length),
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
          },
        ],
      }
    },
    freeInlineCompletions: () => {},
  })

  // 悬停：显示「文档注释 + 签名」。
  // 说明：moon-lsp 的 hover 与 `moon ide hover` 在本机都不可用，
  //       这里用符号索引（symbols.jsonl）+ 源码片段做降级实现。
  monaco.languages.registerHoverProvider('moonbit', {
    provideHover: async (model, position) => {
      const root = await ensureLsp()
      if (!root) return null
      const file = monacoPath(model)
      await window.moonAPI.lspOpen({ root, file, text: model.getValue() })   // 主进程侧会去重
      const r = await window.moonAPI.lspHover({
        root, file, line: position.lineNumber - 1, character: position.column - 1,
      })
      if (!r || !r.ok || !r.result) return null
      const c = r.result.contents
      const value = typeof c === 'string' ? c
        : c && c.value ? c.value
        : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x.value)).join('\n\n') : ''
      if (!value) return null
      const rg = r.result.range
      return {
        range: rg ? new monaco.Range(rg.start.line + 1, rg.start.character + 1, rg.end.line + 1, rg.end.character + 1) : undefined,
        contents: [{ value }],
      }
    },
  })

  // 通用确认框：替代原生 confirm()
  // confirm() 是**同步阻塞**的 —— 弹窗期间渲染进程不刷新，叠上 Monaco 的光标样式，
  // 用户会看到「鼠标消失」。异步模态没有这个问题，而且样式能跟随日间/夜间主题。
  function askConfirm({ title, body, okText = '确认', cancelText = '取消' }) {
    return new Promise((resolve) => {
      const mask = $('askMask')
      // 兜底：结构缺失时不把功能卡死（宁可放行，也不要无声失败）
      if (!mask) { resolve(true); return }
      $('askTitle').textContent = title || ''
      $('askBody').textContent = body || ''
      const okBtn = $('askOk')
      const cancelBtn = $('askCancel')
      okBtn.textContent = okText
      cancelBtn.textContent = cancelText
      mask.hidden = false
      okBtn.focus()
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        mask.hidden = true
        document.removeEventListener('keydown', onKey, true)
        okBtn.onclick = null; cancelBtn.onclick = null; mask.onclick = null
        resolve(v)
      }
      // 捕获阶段处理按键并阻止冒泡 —— 否则 Monaco 会抢走 Enter/Esc
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true) }
      }
      okBtn.onclick = () => finish(true)
      cancelBtn.onclick = () => finish(false)
      mask.onclick = (e) => { if (e.target === mask) finish(false) }
      document.addEventListener('keydown', onKey, true)
    })
  }

  // 重命名（Step 5，第一个「写操作」）
  // 与本文件其它 provider 的本质区别：它会**改文件**。按写操作标准做：
  //   · 先预览：弹出确认，明确告诉用户"将改 N 处"，确认后才写
  //   · 一次 undo：交给 Monaco —— 它把 rename 当单次 executeEdits，Ctrl+Z 一次全撤
  //   · 版本一致性：edits 带上当前的 versionId，Monaco 校验不过就拒改
  //   · 失败回滚：Monaco 应用 WorkspaceEdit 是原子的，不会留半成品
  // 【范围】当前只应用「当前文件」的改动；跨文件重命名暂未开放（架构上已留位置：
  //   LSP 返回的 changes 里带着其它文件的 uri，放开只需去掉下面的当前文件过滤）。
  monaco.languages.registerRenameProvider('moonbit', {
    provideRenameEdits: async (model, position, newName) => {
      const root = await ensureLsp()
      if (!root) return null
      const file = monacoPath(model)
      const word = model.getWordAtPosition(position)
      if (typeof model.isDirty === 'function' && model.isDirty()) {
        const go = await askConfirm({
          title: '当前文件有未保存的修改',
          body: '重命名只修改编辑器内容（不落盘），但仍建议先保存以避免混淆。',
          okText: '继续',
        })
        if (!go) return null
      }
      await window.moonAPI.lspOpen({ root, file, text: model.getValue() })
      const r = await window.moonAPI.lspRename({
        root, file,
        line: position.lineNumber - 1,
        character: position.column - 1,
        newName,
      })
      if (!r || !r.ok || !r.result) {
        logLine('重命名失败：' + (r && r.error ? r.error : '服务端未返回编辑'), 'err')
        return null
      }
      const changes = r.result.changes || {}
      const norm = (s) => { try { return decodeURIComponent(String(s)).toLowerCase() } catch (_) { return String(s).toLowerCase() } }
      const curUri = monaco.Uri.file(file).toString()
      const key = Object.keys(changes).find((k) => norm(k) === norm(curUri))
      if (!key) {
        logLine('重命名结果里没有当前文件（跨文件重命名暂未开放）', 'err')
        return null
      }
      const raw = changes[key] || []
      if (!raw.length) {
        logLine('没有需要修改的位置', 'err')
        return null
      }
      // 【预览】明确告知影响面，确认后才返回 edits
      const ok = await askConfirm({
        title: '确认重命名',
        body:
          `将把 "${word ? word.word : ''}" 重命名为 "${newName}"\n\n` +
          `当前文件内共 ${raw.length} 处将被修改。\n` +
          (Object.keys(changes).length > 1
            ? `\n（另有 ${Object.keys(changes).length - 1} 个文件也涉及改动，跨文件重命名暂未开放，本次不改。）`
            : ''),
      })
      if (!ok) return null
      const vid = model.getVersionId()
      const edits = raw.map((e) => ({
        resource: monaco.Uri.parse(key),
        versionId: vid,   // 版本一致性：编辑基于这一版，过期会被 Monaco 拒绝
        textEdit: {
          range: {
            startLineNumber: (e.range ? e.range.start.line : 0) + 1,
            startColumn: (e.range ? e.range.start.character : 0) + 1,
            endLineNumber: (e.range ? e.range.end.line : 0) + 1,
            endColumn: (e.range ? e.range.end.character : 0) + 1,
          },
          text: e.newText != null ? e.newText : newName,
        },
      }))
      logLine(`重命名：${word ? word.word : ''} → ${newName}（${edits.length} 处，可一次 Ctrl+Z 撤销）`, 'ok')
      return { edits }
    },
  })

  // 查找引用（Step 4 低复杂度项：与 definition 同模式，只是返回 Location[]）
  monaco.languages.registerReferenceProvider('moonbit', {
    provideReferences: async (model, position) => {
      const root = await ensureLsp()
      if (!root) return null
      const file = monacoPath(model)
      await window.moonAPI.lspOpen({ root, file, text: model.getValue() })
      const r = await window.moonAPI.lspReferences({
        root, file, line: position.lineNumber - 1, character: position.column - 1,
      })
      if (!r || !r.ok || !Array.isArray(r.result)) return null
      const out = []
      for (const loc of r.result) {
        if (!loc || !loc.uri || !loc.range) continue
        out.push({
          uri: monaco.Uri.parse(loc.uri),
          range: {
            startLineNumber: loc.range.start.line + 1,
            startColumn: loc.range.start.character + 1,
            endLineNumber: loc.range.end.line + 1,
            endColumn: loc.range.end.character + 1,
          },
        })
      }
      return out.length ? out : null
    },
  })
  // 手动触发索引刷新（命令面板用）
  window.__refreshSymbols = () => ensureSymbols(true).then((s) => s.length)
}

// --------------------------------------------------------------------------- 后端服务控制（IDE 内一键启停）
let bePort = 8110
let beState = 'stopped'

function setBeState(state, meta) {
  beState = state
  const badge = $('beState')
  const metaEl = $('beMeta')
  const startBtn = $('beStart')
  const stopBtn = $('beStop')
  if (!badge) return
  const label = { stopped: '已停止', starting: '启动中…', running: '运行中', error: '异常' }[state]
  badge.className = state
  badge.textContent = label
  if (metaEl) metaEl.textContent = meta || ''
  // 按钮可用性随状态变化，避免重复点击造成多实例
  if (startBtn) startBtn.disabled = state === 'starting' || state === 'running'
  if (stopBtn) stopBtn.disabled = state !== 'running' && state !== 'starting'
}

function beLog(line, cls) {
  const el = $('beLog')
  if (!el) return
  const d = document.createElement('div')
  if (cls) d.className = cls
  d.textContent = line
  el.appendChild(d)
  // 节点上限：长时间运行也不让 DOM 无限膨胀
  while (el.childNodes.length > 800) el.removeChild(el.firstChild)
  el.scrollTop = el.scrollHeight
}

async function refreshBackendStatus() {
  try {
    const st = await window.moonAPI.backendStatus(projectRootInput(), bePort)
    if (st.running) {
      setBeState(st.healthy ? 'running' : 'starting',
                 `127.0.0.1:${st.port} · PID ${st.pid}`)
    } else {
      setBeState('stopped', st.binary ? '二进制已就绪' : '尚未编译')
    }
  } catch (_) {
    setBeState('stopped')
  }
}

async function initBackendControl() {
  if (!$('beStart')) return
  // 日志与状态由主进程推送（服务是长驻进程，不能等它结束再返回）
  window.moonAPI.onBackendLog(({ line }) => {
    beLog(line, /error|fail|\[fatal\]|parse error/i.test(line) ? 'err' : '')
  })
  window.moonAPI.onBackendState((p) => {
    if (p.running) setBeState('running', `127.0.0.1:${p.port} · 健康检查通过`)
    else setBeState('stopped', '进程已退出')
  })

  $('beStart').onclick = async () => {
    setBeState('starting', '正在检查依赖并启动…')
    beLog('--- 启动后端 ---')
    const r = await window.moonAPI.backendStart(projectRootInput(), bePort, false)
    if (r.ok) {
      beLog(`后端已启动：http://127.0.0.1:${r.port}/health → ${r.health}`, 'ok')
      setBeState('running', `127.0.0.1:${r.port} · PID ${r.pid}`)
      // 顺带把 PG/Redis 视图刷新出来
      loadBackend()
    } else {
      beLog('启动失败：' + (r.error || '未知错误'), 'err')
      setBeState('error', r.error || '')
    }
  }

  $('beStop').onclick = async () => {
    await window.moonAPI.backendStop()
    beLog('已请求停止后端')
    setBeState('stopped')
  }

  $('beBuild').onclick = async () => {
    beLog('--- 编译（moon build --release）---')
    setBeState(beState === 'running' ? 'running' : 'stopped', '编译中…')
    const r = await window.moonAPI.backendBuild()
    beLog(r.ok ? '编译完成' : '编译失败', r.ok ? 'ok' : 'err')
    refreshBackendStatus()
  }

  $('beClear').onclick = () => {
    const el = $('beLog')
    if (el) el.innerHTML = ''
  }

  // 依赖状态提示（容器没起时先说清，而不是等启动失败）
  try {
    const d = await window.moonAPI.backendDeps()
    if (d.docker === false) {
      beLog('未检测到 docker —— 将假定 PostgreSQL / Redis 已在运行')
    } else if (!d.pg || !d.redis) {
      const miss = [!d.pg && 'mbp-pg', !d.redis && 'mbp-redis'].filter(Boolean).join('、')
      beLog('依赖容器未运行：' + miss + '（点「启动后端」会给出启动命令）', 'err')
    } else {
      beLog('依赖就绪：mbp-pg（PostgreSQL）、mbp-redis 均在运行')
    }
  } catch (_) {}

  refreshBackendStatus()
  // 定期刷新（服务可能被外部停掉）
  setInterval(refreshBackendStatus, 10000)
}

// --------------------------------------------------------------------------- 接口调试器（IDE 内直接调后端）
let apiEndpoints = []
let apiBodies = {}

function apiSetMeta(text, cls) {
  const el = $('apiMeta')
  if (!el) return
  el.innerHTML = ''
  const span = document.createElement('span')
  if (cls) span.className = cls
  span.textContent = text
  el.appendChild(span)
}

function apiRenderResponse(r) {
  const pre = $('apiResp')
  if (!pre) return
  if (r.error) {
    apiSetMeta('请求失败：' + r.error + (r.ms != null ? `  (${r.ms}ms)` : ''), 'bad')
    pre.textContent = r.error
    return
  }
  const okCls = r.status >= 200 && r.status < 400 ? 'ok' : 'bad'
  apiSetMeta(`${r.status} ${r.statusText || ''}  ·  ${r.ms}ms  ·  ${(r.body || '').length} 字节`, okCls)
  // JSON 美化（非 JSON 就原样显示）
  let text = r.body || ''
  try {
    text = JSON.stringify(JSON.parse(text), null, 2)
  } catch (_) {}
  pre.textContent = text

  // 贴心：登录/注册响应里带 user.token 时自动填入，后续受保护接口免手工复制
  try {
    const j = JSON.parse(r.body)
    if (j && j.user && j.user.token) {
      const t = $('apiToken')
      if (t) t.value = j.user.token
      apiSetMeta(
        `${r.status} ${r.statusText || ''}  ·  ${r.ms}ms  ·  已自动填入 token`,
        okCls,
      )
    }
  } catch (_) {}
}

function apiSelectEndpoint() {
  const sel = $('apiEndpoint')
  if (!sel) return
  const idx = sel.selectedIndex
  if (idx < 0 || !apiEndpoints[idx]) return
  const ep = apiEndpoints[idx]
  const m = $('apiMethod')
  if (m) {
    m.textContent = ep.method
    m.className = ep.method
  }
  const pth = $('apiPath')
  if (pth) pth.value = '/api' + ep.path
  const bodyEl = $('apiReqBody')
  if (bodyEl) bodyEl.value = apiBodies[`${ep.method} ${ep.path}`] || ''
}

async function initApiDebug() {
  if (!$('apiSend')) return
  const sel = $('apiEndpoint')
  sel.onchange = apiSelectEndpoint
  // 路径手改后不应被下拉重置
  $('apiPath').oninput = () => {}

  $('apiSend').onclick = async () => {
    const method = $('apiMethod').textContent.trim()
    const pth = $('apiPath').value.trim()
    const base = $('apiBase').value.trim() || 'http://127.0.0.1:8110'
    const token = $('apiToken').value.trim()
    const body = $('apiReqBody').value
    if (!pth) {
      apiSetMeta('请填写请求路径', 'bad')
      return
    }
    $('apiSend').disabled = true
    apiSetMeta('发送中…')
    try {
      const r = await window.moonAPI.apiSend({ baseUrl: base, method, path: pth, token, body })
      apiRenderResponse(r)
    } catch (e) {
      apiSetMeta('异常：' + e.message, 'bad')
    } finally {
      $('apiSend').disabled = false
    }
  }

  try {
    const res = await window.moonAPI.apiEndpoints()
    if (!res || !res.ok) {
      apiSetMeta('无法加载端点清单：' + ((res && res.error) || '未知'), 'bad')
      return
    }
    apiEndpoints = res.endpoints || []
    apiBodies = res.bodies || {}
    sel.innerHTML = ''
    for (const ep of apiEndpoints) {
      const o = document.createElement('option')
      o.textContent = `${ep.method}  /api${ep.path}${ep.summary ? '  —  ' + ep.summary : ''}`
      sel.appendChild(o)
    }
    if (apiEndpoints.length) {
      sel.selectedIndex = 0
      apiSelectEndpoint()
    }
    apiSetMeta(`已从 openapi.yml 载入 ${apiEndpoints.length} 个端点（登录后 token 会自动填入）`)
  } catch (e) {
    apiSetMeta('加载端点失败：' + e.message, 'bad')
  }
}

// --------------------------------------------------------------------------- 项目类型（打开任意项目时说清能力边界）
let projectInfoCache = null

// 状态栏左侧显示项目类型
function renderProjectKind(info) {
  projectInfoCache = info
  const el = $('stProject')
  if (!el) return
  if (!info || !info.ok) {
    el.textContent = '项目：—'
    el.title = ''
    return
  }
  el.textContent = '项目：' + info.label
  const f = info.features || {}
  const off = Object.entries(f)
    .filter(([, v]) => v && !v.ok && v.why)
    .map(([k, v]) => `• ${k}: ${v.why}`)
  el.title = off.length ? '以下能力对本项目不适用：\n' + off.join('\n') : '全部能力可用'
  el.style.color = info.kind === 'moonbit' ? '#7ee787' : '#d0a85c'
}

// 在「后端」「接口」面板顶部提示不适用原因（而不是静默失败）
function renderPanelNotice(panelId, featureKey) {
  const el = $(panelId)
  if (!el) return
  const old = el.querySelector('.nocap')
  if (old) old.remove()
  const f = projectInfoCache && projectInfoCache.features && projectInfoCache.features[featureKey]
  if (!f || f.ok) return
  const box = document.createElement('div')
  box.className = 'nocap'
  box.textContent = 'ℹ ' + f.why
  box.style.cssText = 'padding:6px 10px;color:#d0a85c;font-size:11px;border-bottom:1px solid #2a2a2a;'
  el.insertBefore(box, el.firstChild)
}

async function refreshProjectInfo() {
  try {
    // 识别用的是「地址栏里那条路径」（字符串）—— 不要回传上下文，避免「用识别结果造上下文、再用上下文去识别」的循环
    const info = await window.moonAPI.projectInfo(projectRootPath())
    renderProjectKind(info)
    // 用识别结果补齐上下文的 kind/label/features。
    // **rootDir 仍以「实际打开的目录」为准** —— 不能信 info.root：
    // 主进程在 cwd 为空时会回退 DEFAULT_CWD，那会把「无项目」变成「有项目」。
    if (projectCtx) {
      projectCtx = window.moonbitProjectContext.create(
        Object.assign({}, info || {}, { root: projectCtx.rootDir }),
        { entry: projectCtx.entry, activeFile: projectCtx.activeFile },
      )
    }
    if (info && info.ok) {
      renderPanelNotice('backend', 'backendControl')
      renderPanelNotice('api', 'apiDebug')
    }
  } catch (_) {}
}

// --------------------------------------------------------------------------- 核心初始化
//
// 与 Monaco **完全解耦**：文件树、面板切换、按钮绑定、后端控制、接口调试、
// 项目识别这些能力不依赖编辑器，必须无条件初始化。
//
// 之前它们全在 Monaco 的加载回调里，Monaco 一失败整个界面就"什么也干不了"。
// 前端全局错误兜底：
// 以前任何渲染层异常都是静默的 —— 界面某块不工作时用户只能干看着。
// 现在统一抓到「问题」面板里显示，至少能让人知道"哪里坏了、为什么"。
function installErrorReporting() {
  // 已知噪音：Monaco 的 web worker 在 file:// 下加载受限（会抛 editorWorkerHost 的 Uncaught Event）。
  // 但补全 / 跳转 / 高亮 / 悬停都跑在主线程（用自己的 CompletionItemProvider + symbols.jsonl），
  // 功能不受影响，所以不要把这条当成「前端错误」吓人。
  const NOISE = /editorWorkerHost|MonacoEnvironment|worker.*(load|fail)|Uncaught \[object Event\]/i
  const report = (kind, detail) => {
    if (NOISE.test(String(detail))) return
    try {
      const box = document.getElementById('problems')
      if (!box) return
      const line = document.createElement('div')
      line.className = 'item'
      line.style.color = '#ff9f9f'
      line.textContent = `[${kind}] ${detail}`
      box.appendChild(line)
      setMsg('检测到前端错误，详见「问题」面板')
      const badge = document.querySelector('#panelHead span[data-panel="problems"]')
      if (badge) badge.style.color = '#ff9f9f'
    } catch (_) {}
  }
  window.addEventListener(
    'error',
    (e) => report('错误', `${e.message || ''}  @ ${String(e.filename || '').split(/[\/]/).pop()}:${e.lineno || ''}`),
    true,
  )
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    report('未处理的 Promise', String((r && (r.stack || r.message)) || r).slice(0, 300))
  })
}

function initCore() {
  const step = (name, fn) => {
    try {
      fn()
    } catch (e) {
      try {
        logLine('初始化失败 [' + name + ']：' + (e && e.message ? e.message : e), 'err')
        setMsg('初始化失败：' + name)
      } catch (_) {}
    }
  }

  step('installErrorReporting（前端错误兜底）', () => installErrorReporting())
  step('活动栏（5 个主标签）', () => initActivityBar())
  step('LSP 诊断 → Monaco 标记', () => {
    // LSP 会在文件打开/修改后主动推送 publishDiagnostics —— 这是「边写边报」。
    // 与手动的 moon check 是互补关系：LSP 管实时，check 管一次性完整检查。
    window.moonAPI.onLspDiagnostics((p) => {
      try {
        if (!p || !p.uri || typeof monaco === 'undefined') return
        const uri = monaco.Uri.parse(p.uri)
        const model = monaco.editor.getModel(uri)
        const sev = (s) =>
          s === 1 ? monaco.MarkerSeverity.Error
            : s === 2 ? monaco.MarkerSeverity.Warning
              : s === 3 ? monaco.MarkerSeverity.Info
                : monaco.MarkerSeverity.Hint
        const markers = (p.diagnostics || []).map((d) => ({
          startLineNumber: (d.range && d.range.start ? d.range.start.line : 0) + 1,
          startColumn: (d.range && d.range.start ? d.range.start.character : 0) + 1,
          endLineNumber: (d.range && d.range.end ? d.range.end.line : 0) + 1,
          endColumn: (d.range && d.range.end ? d.range.end.character : 0) + 1,
          message: d.message || '',
          severity: sev(d.severity),
          source: 'moon-lsp',
        }))
        if (model) monaco.editor.setModelMarkers(model, 'moon-lsp', markers)
        // 同步到「问题」面板：只展示当前打开文件的，避免依赖库把面板刷屏
        const cur = tabs[active]
        if (cur && monaco.Uri.file(cur.path).toString() === uri.toString()) {
          renderProblems((p.diagnostics || []).map((d) => ({
            severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
            file: cur.path,
            line: (d.range && d.range.start ? d.range.start.line : 0) + 1,
            col: (d.range && d.range.start ? d.range.start.character : 0) + 1,
            message: d.message || '',
          })))
        }
      } catch (_) {}
    })
  })

  step('运行输出流（runner）', () => {
    window.moonAPI.onRunnerData((p) => {
      outEl.appendChild(document.createTextNode(p && p.data ? p.data : ''))
    })
    // 运行开始：必须给反馈 —— 否则点了「运行」界面毫无变化，
    // 用户会以为没跑起来（尤其是启动后不打印日志的服务类程序）。
    window.moonAPI.onRunnerStart((p) => {
      logLine(`[已启动] ${p && p.label ? p.label : ''} —— 进程运行中，输出会实时出现在这里\n`, 'ok')
      setMsg('运行中…')
    })
    // 服务就绪：主进程从输出里抓到本地 URL 并已尝试用系统浏览器打开。
    // 这里再显示一次，一是让用户知道「可以看了」，二是万一自动打开被拦，地址就在眼前。
    window.moonAPI.onRunnerUrl((p) => {
      if (!p || !p.url) return
      logLine(`\n[服务已就绪] ${p.url}  —— 已尝试用系统浏览器打开\n`, 'ok')
      setMsg('服务已就绪：' + p.url)
    })
    window.moonAPI.onRunnerEnd((p) => {
      const code = p && p.code != null ? p.code : '-'
      logLine(`\n[运行结束] 退出码 ${code}${p && p.error ? ' · ' + p.error : ''}\n`, p && p.code === 0 ? 'ok' : 'err')
      setMsg(p && p.code === 0 ? '运行完成' : `运行结束（exit ${code}）`)
    })
  })
  step('工具标签（工具入口页）', () => initToolsView())
  step('欢迎页（打开/新建）', () => initWelcome())
  step('输出面板空状态', () => initOutputEmptyState())
  step('initMoonStream（任务流式输出订阅）', () => initMoonStream())
  step('wireUI（按钮/面板绑定）', () => wireUI())
  step('initBackendControl（一键启停）', () => initBackendControl())
  step('initApiDebug（接口调试器）', () => initApiDebug())
  step('refreshProjectInfo（项目识别）', () => refreshProjectInfo())

  // 启动时是否自动打开项目：**只有命令行明确指定了目录才打开**（用户要求「初始化不打开任何项目」）。
  // 没指定就进欢迎页，由用户自己选项目（这也是成熟 IDE 的做法）。
  window.moonAPI
    .startInfo()
    .then((info) => {
      if (info && info.explicit && info.dir) return boot(info.dir)
      return showWelcome()
    })
    .catch((e) => {
      logLine('启动初始化失败：' + e, 'err')
      setMsg('启动初始化失败')
    })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCore)
} else {
  initCore()
}
