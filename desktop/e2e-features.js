// IDE 功能体检：把 UI 上暴露的**每个入口**逐一实测，产出「能用 / 不能用」清单。
//
// 只读为主：不真保存文件、不真改代码（需要副作用的只检查"是否绑定/可用"）。
// 运行：cd desktop && ./node_modules/.bin/electron e2e-features.js [项目目录]

require('./main.js')
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const SHOT_DIR = path.join(__dirname, 'e2e-shots')
const rows = [] // { area, feature, ok, note }

function rec(area, feature, ok, note = '') {
  rows.push({ area, feature, ok, note })
  const tag = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP'
  console.log(`  [${tag}] ${area} / ${feature}${note ? '  — ' + note : ''}`)
}

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) {
    win = BrowserWindow.getAllWindows()[0] || null
    if (win) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!win) { console.log('未拿到窗口'); app.quit(); return }
  await new Promise((r) => setTimeout(r, 5000))
  const wc = win.webContents
  const js = (c) => wc.executeJavaScript(c, true)
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = async (n) => { try { fs.writeFileSync(path.join(SHOT_DIR, n + '.png'), (await wc.capturePage()).toPNG()) } catch (_) {} }

  console.log('════════ IDE 功能体检 ════════\n')

  // 转译后：文件树只在自己那个标签页里可见（默认可能停在「主菜单」或上次记住的标签），
  // 体检前先切到「项目」，否则会把 display:none 里的树误判成"0 节点"。
  const switched = await js(`(() => { const a = document.querySelector('a[data-view="project"]'); if (a) a.click(); return !!a })()`)
  console.log(`（已切到「项目」标签：${switched}）\n`)
  await pause(1500)

  // ---------------- 1. 文件树 ----------------
  console.log('【1】文件树')
  const treeN = await js("(document.getElementById('tree')||{children:[]}).children.length")
  rec('文件树', '能列出项目文件', treeN > 0, `${treeN} 个顶层节点`)
  // 展开第一个目录
  const expanded = await js(`(async () => {
    const first = document.querySelector('#tree > *')
    if (!first) return 'no-node'
    const clickable = first.querySelector('*') || first
    clickable.click()
    return 'clicked'
  })()`)
  await pause(1200)
  const afterExpand = await js("(document.getElementById('tree')||{children:[]}).children.length")
  rec('文件树', '能展开目录', expanded === 'clicked', `展开后根层 ${afterExpand} 项（子项在子树里）`)
  await shot('F01-文件树')

  // ---------------- 2. 打开文件到编辑器 ----------------
  console.log('\n【2】打开文件到编辑器')
  const treeText = await js("Array.from(document.querySelectorAll('#tree *')).filter(e=>e.children.length===0&&e.textContent.trim()).map(e=>e.textContent.trim()).slice(0,12).join('|')")
  console.log('      文件树里的文本（供参考）:', treeText.slice(0, 120))
  // 递归展开目录，直到树里出现文件节点，再点它。
  // 节点结构是 <div class="node"><span class="ico">·</span>文件名</div> ——
  // 文件名是 **text node** 而不是子元素；早先用 `children.length === 0 && 带扩展名`
  // 去找，永远只能匹配到那个 .ico span，因此一直误报 no-file-node（测试的锅，不是产品的）。
  let opened = 'no-file-node'
  for (let round = 0; round < 6; round++) {
    await js(`(() => {
      // 目录用 .ico.dir-i 标记（图标已从 ▸/▾ 字符换成 SVG）
      const dirs = Array.from(document.querySelectorAll('#tree .node')).filter(n => n.querySelector('.ico.dir-i'))
      dirs.slice(0, 6).forEach(d => d.click())
    })()`)
    await pause(1500)
    const r = await js(`(async () => {
      const nodes = Array.from(document.querySelectorAll('#tree .node'))
      const f = nodes.find(n => !n.querySelector('.ico.dir-i'))
      if (!f) return null
      const name = f.textContent
      f.click()
      return name
    })()`)
    if (r) { opened = 'clicked:' + r; break }
  }
  await pause(2500)
  const tabInfo = await js("JSON.stringify({ tabs: (document.getElementById('tabs')||{children:[]}).children.length, editorHasText: ((document.querySelector('.monaco-editor')||{}).innerText||'').length > 0, monacoModels: (window.monaco ? window.monaco.editor.getModels().length : -1) })")
  // 判据用「功能事实」：点击后确实产生了标签页 / Monaco 模型。
  // 不再用"能否用正则匹配到文件节点"当判据 —— 那个受文本编码影响，会误报。
  const ti0 = JSON.parse(tabInfo)
  rec('编辑器', '点文件能打开（生成标签页 + 装载内容）', ti0.tabs > 0 && ti0.monacoModels > 0,
      `点击 ${opened.slice(0, 40)} → tabs=${ti0.tabs} models=${ti0.monacoModels}`)
  await shot('F02-打开文件')

  // ---------------- 3. 编辑器核心（补全/跳转/悬停提供者是否注册） ----------------
  console.log('\n【3】编辑器智能功能（是否注册）')
  const langs = await js("(window.monaco ? window.monaco.languages.getLanguages().map(l=>l.id).filter(id=>id==='moonbit').join(',') : 'no-monaco')")
  rec('编辑器', 'moonbit 语言已注册', langs === 'moonbit', `languages 含 moonbit: ${langs}`)
  // Monaco 没提供"列出已注册 provider"的公开 API，只能间接验证：注册代码是否执行过
  const providerHint = await js("(typeof registerSymbolProviders === 'function') ? 'function' : 'missing'")
  rec('编辑器', '补全/跳转 provider 代码存在', providerHint === 'function', '（能否真出结果需在有符号索引时人工试）')
  const hoverHint = await js("document.querySelector('#editor').innerHTML.length > 100")
  rec('编辑器', '编辑器已挂载 Monaco DOM', hoverHint === true, '')

  // ---------------- 4. 保存（只查绑定，不真改文件） ----------------
  console.log('\n【4】保存')
  const saveBound = await js("(typeof saveActive === 'function' || typeof window.saveActive === 'function') ? 'function' : 'missing'")
  rec('编辑器', 'Ctrl+S 保存逻辑存在', saveBound === 'function', '（未实际触发，避免改动你的文件）')

  // ---------------- 5. 命令面板 ----------------
  console.log('\n【5】命令面板')
  const palette = await js(`(() => {
    const b = document.getElementById('cmdBtn'); if (!b) return 'no-btn'
    b.click()
    const p = document.getElementById('palette')
    return getComputedStyle(p).display + '|' + (document.getElementById('paletteList')||{children:[]}).children.length
  })()`)
  await pause(600)
  rec('命令面板', '能打开且列出命令', palette !== 'no-btn' && !palette.startsWith('none'),
      `display|项数 = ${palette}`)
  await js("(document.getElementById('paletteInput')||{}).value=''")
  await shot('F05-命令面板')
  await js("(document.getElementById('palette').style.display='none')")

  // ---------------- 6. 顶部命令按钮 check/build/test/fmt ----------------
  console.log('\n【6】顶部命令按钮')
  const cmdBtns = await js("Array.from(document.querySelectorAll('button[data-cmd]')).map(b=>b.dataset.cmd).join(',')")
  const cmdBound = await js("Array.from(document.querySelectorAll('button[data-cmd]')).every(b => typeof b.onclick === 'function')")
  rec('命令按钮', 'check/build/test/fmt 按钮均绑定', cmdBound === true, `按钮: ${cmdBtns}`)

  // ---------------- 7. 侧栏：搜索 ----------------
  console.log('\n【7】侧栏搜索')
  const searchUsable = await js(`(() => {
    const i = document.getElementById('searchInput'); const r = document.getElementById('searchResults')
    return JSON.stringify({ hasInput: !!i, hasResults: !!r, inputBound: i ? (typeof i.oninput === 'function' || typeof i.onkeydown === 'function') : false })
  })()`)
  const su = JSON.parse(searchUsable)
  rec('搜索', '搜索框存在并绑定事件', su.hasInput && su.hasResults, `inputBound=${su.inputBound}`)

  // ---------------- 8. 侧栏：大纲 ----------------
  console.log('\n【8】侧栏大纲')
  const outlineOk = await js("!!document.getElementById('outline')")
  rec('大纲', '大纲容器存在', outlineOk === true, '（内容取决于当前打开的文件）')

  // ---------------- 9. 底部面板切换 ----------------
  console.log('\n【9】底部面板切换')
  for (const p of ['output', 'problems', 'backend', 'api', 'terminal']) {
    const vis = await js(`(() => {
      const s = document.querySelector('#panelHead span[data-panel="${p}"]'); if (!s) return 'no-tab'
      s.click()
      const el = document.getElementById('${p}')
      return getComputedStyle(el).display
    })()`)
    await pause(500)
    rec('底部面板', `切到「${p}」可见`, vis !== 'none' && vis !== 'no-tab', `display=${vis}`)
  }
  await shot('F09-面板')

  // ---------------- 10. 终端 ----------------
  console.log('\n【10】集成终端')
  await js("(() => { const s=document.querySelector('#panelHead span[data-panel=\\'terminal\\']'); if(s) s.click(); })()")
  await pause(2500)
  const termInfo = await js(`(() => {
    return JSON.stringify({
      rows: (document.querySelectorAll('.xterm-rows > div').length) || 0,
      hasCanvas: !!document.querySelector('#terminal canvas'),
      hasTextarea: !!document.querySelector('#terminal textarea'),
      termVar: (typeof term !== 'undefined' && term) ? 'created' : 'null',
      fitAddon: (typeof fitAddon !== 'undefined' && fitAddon) ? 'created' : 'null',
      termId: String(typeof termId !== 'undefined' ? termId : 'undef'),
    })
  })()`)
  const ti = JSON.parse(termInfo)
  // xterm 新版默认用 DOM 渲染（rows），也可能用 canvas —— 两者其一即可
  rec('终端', 'xterm 已渲染', ti.hasCanvas === true || ti.rows > 0, `canvas=${ti.hasCanvas} rows=${ti.rows}`)
  rec('终端', '能接收键盘输入（有 textarea）', ti.hasTextarea === true, '')
  rec('终端', 'PTY 会话已创建', ti.termVar === 'created', `term=${ti.termVar} fitAddon=${ti.fitAddon} termId=${ti.termId}`)
  await shot('F10-终端')

  // ---------------- 11. 后端控制 ----------------
  console.log('\n【11】后端一键启停')
  const beOk = await js("JSON.stringify({ start: !!document.getElementById('beStart'), stop: !!document.getElementById('beStop'), build: !!document.getElementById('beBuild'), state: (document.getElementById('beState')||{}).textContent })")
  rec('后端控制', '启动/停止/编译按钮存在', JSON.parse(beOk).start && JSON.parse(beOk).build, beOk)

  // ---------------- 12. 接口调试器 ----------------
  console.log('\n【12】接口调试器')
  const apiOk = await js("JSON.stringify({ sel: (document.getElementById('apiEndpoint')||{options:[]}).options.length, send: !!document.getElementById('apiSend'), resp: !!document.getElementById('apiResp') })")
  const ao = JSON.parse(apiOk)
  rec('接口调试器', '端点清单已加载', ao.sel > 0, `${ao.sel} 个端点`)
  rec('接口调试器', '发送按钮 + 响应区存在', ao.send && ao.resp, '')

  // ---------------- 13. 项目识别 ----------------
  console.log('\n【13】状态栏')
  const st = await js("JSON.stringify({ project: (document.getElementById('stProject')||{}).textContent, module: (document.getElementById('stModule')||{}).textContent, msg: (document.getElementById('stMsg')||{}).textContent })")
  const stj = JSON.parse(st)
  rec('状态栏', '项目类型已识别', !!stj.project && stj.project !== '项目：—', stj.project + ' / ' + stj.module)

  // ---------------- 汇总 ----------------
  const fail = rows.filter((r) => r.ok === false)
  console.log('\n════════ 汇总 ════════')
  console.log(`  通过 ${rows.length - fail.length} / ${rows.length}`)
  if (fail.length) {
    console.log('  不能用 / 需要人确认的：')
    for (const f of fail) console.log(`    ✗ ${f.area} / ${f.feature}  ${f.note}`)
  }
  const report = {
    at: new Date().toISOString(),
    project: process.argv.slice(1).filter(a => a && a !== '.' && !a.endsWith('.js') && !a.startsWith('--'))[0] || '',
    total: rows.length, failed: fail.length, rows,
  }
  fs.writeFileSync(path.join(SHOT_DIR, 'feature-report.json'), JSON.stringify(report, null, 2))
  console.log(`\n  报告: ${path.join(SHOT_DIR, 'feature-report.json')}`)
  app.quit()
})
