// 多项目切换验证（P2-17）＋ 无项目态（P2-16）＋ 关闭项目（P2-18）
//
// 为什么需要这个脚本：「单一工程上下文」的核心价值就是**切换项目后各模块跟着换根** ——
// 而「打开项目」此前只能经**系统文件夹对话框**，脚本点不到。
// 为此 renderer 新增了显式入口 `window.moonbitIDE.openProject(dir)`（它同时是 P3 Command Registry 的雏形）。
//
// 关键断言不是"上下文对象变了"，而是**下游真的跟着变**：
// 切到 Node 项目时 Runner 列出 node 入口、切到 MoonBit 项目时列出带 --target native 的入口。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const OUT = path.join(__dirname, 'multiproject-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
function dump(code) {
  try {
    fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  } catch (e) {
    console.log('（结果文件写入失败，忽略：' + String((e && e.message) || e) + '）')
  }
  setTimeout(() => app.exit(code), 500)
}

// 造两个临时项目：A = Node，B = MoonBit
const A = fs.mkdtempSync(path.join(os.tmpdir(), 'mbproj-A-'))
const B = fs.mkdtempSync(path.join(os.tmpdir(), 'mbproj-B-'))
fs.writeFileSync(path.join(A, 'package.json'), JSON.stringify({ name: 'a', scripts: { dev: 'node dev.js', test: 'node t.js' } }, null, 2))
fs.writeFileSync(path.join(B, 'moon.mod'), '')
fs.mkdirSync(path.join(B, 'cmd', 'main'), { recursive: true })
// findRunners 用 isPkg() 判断可执行入口 —— 它检查的是**入口包目录**下的 moon.pkg，不是项目根
fs.writeFileSync(path.join(B, 'cmd', 'main', 'moon.pkg'), '')
fs.writeFileSync(path.join(B, 'cmd', 'main', 'main.mbt'), 'fn main { println("hi") }')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  await sleep(3000)

  let pass = 0, fail = 0
    /** 布尔断言：**只接受布尔**（detail 仅在失败时显示）。
   *  ⚠️ 误用防护：传数组/对象进来会**立刻判失败**并提示用 `eq` ——
   *  历史上 25 处 `eq('x', [a,b], [c,d])` 因为数组恒为真而**永远通过**，等于没验。 */
  const chk = (n, ok, detail) => {
    if (typeof ok !== 'boolean') {
      fail++; log('  [FAIL] ' + n + '   ⚠️ chk 只接受布尔（数组/对象比较请用 eq）：' + JSON.stringify(ok))
      return
    }
    if (ok) { pass++; log('  [PASS] ' + n) } else { fail++; log('  [FAIL] ' + n + (detail ? '  ' + detail : '')) }
  }
  /** 相等断言：JSON 相等比较（数组/对象用这个）*/
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; log('  [PASS] ' + n) }
    else { fail++; log('  [FAIL] ' + n + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
  }
  const ctx = async () => JSON.parse(await js('JSON.stringify(window.moonbitIDE.getContext())'))
  const openProject = async (dir) => {
    const info = await js(`(async () => {
      try {
        await window.moonbitIDE.openProject(${JSON.stringify(dir)});
        return JSON.stringify({ ok: true, cwd: document.getElementById('cwd').value, ctxRoot: (window.moonbitIDE.getContext() || {}).rootDir })
      } catch (e) { return JSON.stringify({ ok: false, err: String((e && e.message) || e) }) }
    })()`)
    log('   openProject(' + path.basename(dir) + ') → ' + String(info).slice(0, 260))
    await sleep(1000)
  }
  const runners = async () => JSON.parse(await js('(async () => JSON.stringify(await window.moonAPI.runnerList(window.moonbitIDE.getContext())))()'))

  log('\n=== ⓪ 入口自检 ===')
  log('   moonbitIDE keys = ' + (await js('Object.keys(window.moonbitIDE).join(",")')))
  log('   启动时 cwd = ' + (await js('document.getElementById("cwd").value')))
  log('   启动时 ctx = ' + (await js('JSON.stringify(window.moonbitIDE.getContext())')).slice(0, 160))

  log('\n=== ① 无项目态（P2-16）===')
  chk('启动时 hasProject = false', (await js('window.moonbitIDE.hasProject()')) === false)
  chk('describe() = （无项目）', (await js('window.moonbitIDE.describe()')) === '（无项目）')

  log('\n=== ② 打开项目 A（Node）===')
  await openProject(A)
  let c = await ctx()
  chk('A: projectType = node', c && c.projectType === 'node', JSON.stringify(c && c.projectType))
  chk('A: rootDir 正确', !!c && path.normalize(c.rootDir) === path.normalize(A), c && c.rootDir)
  chk('A: hasProject = true', (await js('window.moonbitIDE.hasProject()')) === true)
  let r = await runners()
  chk('A: Runner 跟着换根（kind=node）', r && r.kind === 'node', JSON.stringify(r && r.kind))

  log('\n=== ③ 切到项目 B（MoonBit）===')
  await openProject(B)
  c = await ctx()
  chk('B: projectType = moonbit', c && c.projectType === 'moonbit', JSON.stringify(c && c.projectType))
  chk('B: rootDir 已切换', !!c && path.normalize(c.rootDir) === path.normalize(B), c && c.rootDir)
  r = await runners()
  chk('B: Runner 列出 moonbit 入口', r && r.kind === 'moonbit', JSON.stringify(r && r.kind))
  chk('B: 命令带 --target native', !!(r && (r.runners || []).some((x) => /--target native/.test(String(x.hint)))), JSON.stringify((r && r.runners || []).map((x) => x.hint).slice(0, 2)))

  log('\n=== ④ 切回 A（P2-17 的 A→B→A）===')
  await openProject(A)
  c = await ctx()
  chk('回 A: projectType = node（无残留）', c && c.projectType === 'node', JSON.stringify(c && c.projectType))
  chk('回 A: rootDir = A', !!c && path.normalize(c.rootDir) === path.normalize(A), c && c.rootDir)
  r = await runners()
  chk('回 A: Runner 也回退正确', r && r.kind === 'node', JSON.stringify(r && r.kind))

  log('\n=== ⑤ 关闭项目（P2-18）===')
  await js('window.moonbitIDE.closeProject()')
  await sleep(1000)
  chk('关闭后 hasProject = false', (await js('window.moonbitIDE.hasProject()')) === false)
  chk('关闭后 getContext() = null', (await js('window.moonbitIDE.getContext() === null')) === true)
  // 注：showWelcome() 不显示 #welcomeScreen —— 它给文件树插一块 .welcome 引导，并加 body.no-project 类
  const noProj = await js(`document.body.classList.contains('no-project')`)
  chk('关闭后进入「无项目态」（body.no-project）', noProj === true, String(noProj))
  const guide = await js(`!!document.querySelector('#tree .welcome')`)
  chk('文件树里出现「未打开项目」引导', guide === true, String(guide))

  console.log('\n=== ⑥ 命令表（P3-09～P3-11 的接线证据）===')
  {
    const cl = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.commands.list()))()'))
    const names = (cl.commands || []).map((c) => c.name).sort()
    eq('commandList 返回 6 个项目命令', names, ['project.build', 'project.close', 'project.open', 'project.run', 'project.stop', 'project.test'])
    eq('危险命令带 danger 标记', (cl.commands || []).filter((c) => c.danger).length, 2)

    const ex = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.commands.execute('project.open', { dir: ${JSON.stringify(A)} })))()`))
    eq('execute(project.open) 正常且返回 rootDir', [ex.ok, ex.data && ex.data.rootDir], [true, A])

    const bad = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.commands.execute('no.such.command')))()`))
    eq('未知命令 → ok:false（不抛）', [bad.ok, /未知命令/.test(String(bad.error))], [false, true])

    const noDir = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.commands.execute("project.open", {})))()'))
    eq('缺参数 → ok:false', [noDir.ok, /缺少目录/.test(String(noDir.error))], [false, true])
  }

  log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  try {
    fs.rmSync(A, { recursive: true, force: true })
    fs.rmSync(B, { recursive: true, force: true })
  } catch (e) {
    log('（临时目录清理失败，忽略：' + String((e && e.message) || e) + '）')
  }
  dump(fail === 0 ? 0 : 1)
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
