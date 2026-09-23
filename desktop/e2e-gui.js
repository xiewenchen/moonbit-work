// GUI 实测驱动：像真人一样操作 IDE，每一步截图 + 打印结果。
//
// 为什么要这个：之前所有"验证"都是模拟 IPC 调用 ——
// 「主进程函数能跑通」不等于「人在界面上点得动」。
// 这个脚本真正加载 index.html、点按钮、读界面文本、截图，
// 用来找出「用户上手后干不了什么」。
//
// 运行：cd desktop && ./node_modules/.bin/electron e2e-gui.js [项目目录]

// 关键：直接复用**真实的主进程**（它会注册全部 IPC 并创建窗口）。
// 之前这个脚本自己当主进程、只注册了少数 IPC，导致所有需要主进程的能力
// （文件树、终端、项目识别、接口清单…）全部失效 —— 那样的"实测"是假的。
require('./main.js')

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const SHOT_DIR = path.join(__dirname, 'e2e-shots')

const results = []
function log(ok, step, detail) {
  results.push({ ok, step, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${step}${detail ? '  — ' + detail : ''}`)
}

async function shot(win, name) {
  try {
    const img = await win.webContents.capturePage()
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true })
    fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), img.toPNG())
    return true
  } catch (e) {
    return false
  }
}

// 在渲染进程里执行一段 JS，返回结果
const js = (win, code) => win.webContents.executeJavaScript(code, true)

app.whenReady().then(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // 捕获渲染进程的报错 —— 这是「界面点不动」最可能的根因
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (_ev, level, message, line, sourceId) => {
      const tag = ['debug', 'info', 'warn', 'error'][level] || level
      if (tag === 'error' || tag === 'warn') {
        console.log(`  [渲染进程 ${tag}] ${String(message).slice(0, 300)}  (${String(sourceId).split(/[\/]/).pop()}:${line})`)
      }
    })
    wc.on('preload-error', (_ev, preloadPath, err) => {
      console.log(`  [preload 失败] ${preloadPath}: ${err && err.message}`)
    })
    wc.on('render-process-gone', (_ev, details) => {
      console.log(`  [渲染进程崩溃] ${JSON.stringify(details)}`)
    })
  })
  // 等 main.js 创建好窗口，然后操作**同一个**窗口（而不是自己再开一个）
  let win = null
  for (let i = 0; i < 40; i++) {
    win = BrowserWindow.getAllWindows()[0] || null
    if (win) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!win) {
    console.log('未拿到主进程创建的窗口')
    app.quit()
    return
  }
  // 等 Monaco / 终端 / 文件树初始化
  await new Promise((r) => setTimeout(r, 4000))

  console.log('════════ 像真人一样操作 IDE ════════')
  console.log('（复用真实主进程：main.js 的全部 IPC 都在）')
  console.log('')

  // 先做一次「体检」：preload 有没有生效、各 IPC 是否可达
  console.log('【0】环境体检')
  const health = await js(win, `(async () => {
    const out = { hasMoonAPI: typeof window.moonAPI !== 'undefined' }
    if (!out.hasMoonAPI) { out.keys = Object.keys(window).slice(0, 20); return out }
    out.apiKeys = Object.keys(window.moonAPI)
    out.checks = {}
    const probe = async (name, fn) => { try { out.checks[name] = { ok: true, v: String(await fn()).slice(0,60) } } catch (e) { out.checks[name] = { ok: false, v: String(e.message||e).slice(0,120) } } }
    await probe('defaultCwd', () => window.moonAPI.defaultCwd())
    await probe('fsList', () => window.moonAPI.fsList ? window.moonAPI.fsList('C:/Users/33567/AppData/Roaming/reasonix/global-workspace/moonbit-platform').then(r => (r.ok? r.entries.length+' 项' : r.error)) : 'API 名不对')
    await probe('projectInfo', () => window.moonAPI.projectInfo('C:/Users/33567/AppData/Roaming/reasonix/global-workspace/moonbit-platform').then(r => r.ok ? r.kind : r.error))
    await probe('apiEndpoints', () => window.moonAPI.apiEndpoints().then(r => r.ok ? r.endpoints.length + ' 端点' : r.error))
    return out
  })()`)
  console.log('    window.moonAPI 存在:', health.hasMoonAPI)
  if (health.apiKeys) console.log('    moonAPI 上的方法数:', health.apiKeys.length)
  if (health.checks) {
    for (const [k, v] of Object.entries(health.checks)) {
      console.log(`    ${v.ok ? '✅' : '❌'} ${k}: ${v.v}`)
    }
  } else if (!health.hasMoonAPI) {
    console.log('    ❌ preload 没有暴露 moonAPI！window 上的键:', (health.keys||[]).join(', '))
  }
  console.log('')

  // ---- 1. 界面骨架是否渲染出来 ----
  console.log('【1】界面骨架')
  const skeleton = await js(win, `(() => ({
    hasEditor: !!document.getElementById('editor'),
    hasTree: !!document.getElementById('tree'),
    hasTabs: !!document.getElementById('tabs'),
    hasTerminal: !!document.getElementById('terminal'),
    hasPanelHead: !!document.getElementById('panelHead'),
    panelTabs: Array.from(document.querySelectorAll('#panelHead span[data-panel]')).map(s => s.dataset.panel),
    statusProject: (document.getElementById('stProject')||{}).textContent || '',
    statusModule: (document.getElementById('stModule')||{}).textContent || '',
    monacoLoaded: typeof window.monaco !== 'undefined',
  }))()`)
  log(skeleton.hasEditor, '编辑器容器存在')
  log(skeleton.hasTree, '文件树容器存在')
  log(skeleton.hasPanelHead, '底部面板存在')
  log(skeleton.monacoLoaded, 'Monaco 编辑器已加载', skeleton.monacoLoaded ? '' : 'Monaco 未加载 → 无法编辑代码！')
  log(skeleton.panelTabs.length >= 4, `面板标签: ${(skeleton.panelTabs || []).join(' / ')}`,
      skeleton.panelTabs.length ? '' : '没有任何面板标签，用户点不了')
  log(!!skeleton.statusProject && skeleton.statusProject !== '项目：—',
      `状态栏项目识别: ${skeleton.statusProject}`)
  await shot(win, '01-初始界面')

  // ---- 2. 文件树是否真的列出了文件（用户最直观的"能不能用"）----
  console.log('\n【2】文件树（用户打开项目第一眼）')
  const treeInfo = await js(win, `(() => {
    const t = document.getElementById('tree')
    if (!t) return { count: 0, sample: [], text: '(无 #tree)' }
    const items = Array.from(t.querySelectorAll('*')).filter(e => e.children.length === 0 && e.textContent.trim())
    return { count: items.length, sample: items.slice(0,6).map(e => e.textContent.trim().slice(0,40)), text: (t.textContent||'').slice(0,120) }
  })()`)
  log(treeInfo.count > 0, `文件树节点数: ${treeInfo.count}`, treeInfo.count ? treeInfo.sample.join(' | ') : '文件树是空的 → 用户看不到任何文件')
  await shot(win, '02-文件树')

  // ---- 3. 每个面板点一遍，看是否真的有内容 ----
  console.log('\n【3】逐个面板点一遍（用户会这么干）')
  for (const p of ['backend', 'api', 'terminal', 'problems', 'output']) {
    const before = await js(win, `(() => {
      const el = document.getElementById('${p}')
      return { exists: !!el, visible: el ? getComputedStyle(el).display !== 'none' : false, textLen: el ? el.textContent.trim().length : -1 }
    })()`)
    // 真的去点那个标签
    const clicked = await js(win, `(() => {
      const s = document.querySelector('#panelHead span[data-panel="${p}"]')
      if (!s) return false
      s.click()
      return true
    })()`)
    await new Promise((r) => setTimeout(r, 900))
    const after = await js(win, `(() => {
      const el = document.getElementById('${p}')
      return { visible: el ? getComputedStyle(el).display !== 'none' : false, textLen: el ? el.textContent.trim().length : -1,
               text: el ? el.textContent.trim().slice(0,100) : '' }
    })()`)
    log(clicked && after.visible, `面板「${p}」可切换并显示`,
        clicked ? `内容长度 ${after.textLen}` : '标签不存在')
    // terminal 用 xterm 的 canvas 渲染，problems 在无问题时本就为空 —— 都不算缺陷
    if (after.visible && after.textLen <= 0 && p !== 'terminal' && p !== 'problems') {
      log(false, `面板「${p}」内容为空`, '用户点进去什么也看不到')
    }
    await shot(win, `03-面板-${p}`)
  }

  // ---- 4. 后端面板的按钮真的能点吗 ----
  console.log('\n【4】后端面板的按钮（用户会点「启动后端」）')
  const btns = await js(win, `(() => {
    const ids = ['beStart','beStop','beBuild','beClear','apiSend']
    const out = {}
    for (const id of ids) {
      const b = document.getElementById(id)
      out[id] = b ? { exists: true, disabled: !!b.disabled, text: b.textContent.trim() } : { exists: false }
    }
    return out
  })()`)
  for (const [id, info] of Object.entries(btns)) {
    log(info.exists, `按钮 #${id} 存在`, info.exists ? `"${info.text}"${info.disabled ? '（当前禁用）' : ''}` : '按钮不在 DOM 里 → 用户点不到')
  }

  // ---- 5. 真正点一次「启动后端」，看界面有没有反馈 ----
  console.log('\n【5】真的点一下「启动后端」，看界面反馈')
  const backendStateBefore = await js(win, `(document.getElementById('beState')||{}).textContent || ''`)
  await js(win, `(() => { const s = document.querySelector('#panelHead span[data-panel="backend"]'); if (s) s.click(); })()`)
  await new Promise((r) => setTimeout(r, 300))
  const clickedStart = await js(win, `(() => { const b = document.getElementById('beStart'); if (!b || b.disabled) return false; b.click(); return true })()`)
  log(clickedStart, '能点下「启动后端」', clickedStart ? '' : '按钮被禁用或不存在')
  await new Promise((r) => setTimeout(r, 6000)) // 等它尝试启动
  const feedback = await js(win, `(() => {
    const st = document.getElementById('beState')
    const lg = document.getElementById('beLog')
    return { state: st ? st.textContent.trim() : '(无)', logLen: lg ? lg.textContent.trim().length : -1,
             log: lg ? lg.textContent.trim().slice(0,200) : '' }
  })()`)
  log(feedback.logLen > 0, `点了之后日志有输出（${feedback.logLen} 字符）`,
      feedback.logLen > 0 ? '' : '点了没有任何反馈 → 用户会以为坏了')
  log(feedback.state !== backendStateBefore || feedback.logLen > 0,
      `状态徽章: "${backendStateBefore}" → "${feedback.state}"`)
  if (feedback.log) console.log('        日志片段:', feedback.log.replace(/\n/g, ' | ').slice(0, 160))
  await shot(win, '04-点了启动后端')

  // ---- 6. 接口面板是否真的列出了端点 ----
  console.log('\n【6】接口面板（用户会想看有没有接口可调）')
  await js(win, `(() => { const s = document.querySelector('#panelHead span[data-panel="api"]'); if (s) s.click(); })()`)
  await new Promise((r) => setTimeout(r, 1500))
  const apiInfo = await js(win, `(() => {
    const sel = document.getElementById('apiEndpoint')
    const n = sel ? sel.options.length : -1
    return { count: n, first: sel && sel.options[0] ? sel.options[0].textContent : '' , meta: (document.getElementById('apiMeta')||{}).textContent || ''}
  })()`)
  log(apiInfo.count > 0, `端点下拉里有 ${apiInfo.count} 个端点`,
      apiInfo.count > 0 ? apiInfo.first : (apiInfo.meta || '下拉是空的 → 用户没接口可调'))
  await shot(win, '05-接口面板')

  // ---- 7. 总结 ----
  const failed = results.filter((r) => !r.ok)
  console.log('\n════════ 结果 ════════')
  console.log(`  通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    console.log('  用户会卡在这些地方：')
    for (const f of failed) console.log(`    ✗ ${f.step}${f.detail ? ' — ' + f.detail : ''}`)
  }
  console.log(`  截图目录: ${SHOT_DIR}`)
  app.quit()
})
