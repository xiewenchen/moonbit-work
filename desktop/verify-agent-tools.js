// 只读工具的接线验证（P6 接线段）
//
// 验的是「七个工具在**真实数据**上可用」+「越界仍然被拒」——
// 而不只是模型单测通过（那由 test-agent-tools.js 覆盖）。
//
// 关键：workspace 由 openProject（用户操作）设定，Agent 侧**没有** setWorkspace 入口，
// 所以下面的越界用例即使想绕也绕不过去。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, 'agent-tools-result.txt')
const ROOT = path.resolve(__dirname, '..')
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
  const call = async (name, args) => JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentTools.call(${JSON.stringify(name)}, ${JSON.stringify(args || {})})))()`))

  log('\n=== ① 工具清单（P6-09）===')
  {
    const l = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.list()))()'))
    const tools = l.tools || []
    eq('8 个只读工具（P14 新增 backendStatus）', tools.length, 8)
    chk('  新增的 backendStatus 在里面', tools.some((t) => t.name === 'backendStatus'), JSON.stringify(tools.map((t) => t.name)))
    eq('**全部是 read 权限**', Array.from(new Set(tools.map((t) => t.permission))).join(','), 'read')
    chk('每个都有超时与输出限额', tools.every((t) => t.timeoutMs > 0 && t.maxOutputBytes > 0), true)
    chk('**没有写/执行工具**', tools.filter((t) => ['writeFile', 'applyPatch', 'project.run', 'project.build'].includes(t.name)).length === 0, JSON.stringify(tools.map((t) => t.name)))
  }

  log('\n=== ② workspace 由 openProject 设定 ===')
  {
    await js(`window.moonbitIDE.openProject(${JSON.stringify(ROOT)})`)
    await sleep(1200)
    const w = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.workspace()))()'))
    eq('workspace = 打开的项目', path.normalize(w.workspace || ''), path.normalize(ROOT))
    eq('**Agent 侧没有 setWorkspace 入口**', (await js('typeof window.moonbitIDE.agentTools.setWorkspace')), 'undefined')
  }

  log('\n=== ③ 在真实数据上跑七个工具 ===')
  {
    const f = await call('readFile', { path: 'hello/cmd/main/main.mbt' })
    eq('readFile 读到真实文件', [f.ok, /fn main/.test(String(f.data && f.data.content))], [true, true])

    const d = await call('listDir', { path: 'hello' })
    // 注意：data 可能是 null（工具报错时），先保护再取字段 —— 否则脚本会抛异常而**提前退出**（结果行都不打印，但 exit=0 → 假绿）
    const entries = (d && d.data && d.data.entries) || []
    eq('listDir 列出真实目录', [d.ok, entries.some((e) => e.name === 'cmd')], [true, true])

    const s = await call('search', { query: 'createServiceRunner', path: '.' })
    eq('search 在真实代码里搜到', [s.ok, (s.data.hits && s.data.hits.results || []).length > 0], [true, true])

    const sym = await call('symbols', { query: 'safe_byte' })
    chk('symbols 可调用（索引不存在时也明确说明）', sym.ok, true)
    log('      symbols 结果：' + JSON.stringify(sym.data).slice(0, 120))

    const info = await call('getProjectInfo')
    eq('getProjectInfo 读真实项目类型', [info.ok, info.data.kind], [true, 'moonbit'])

    const run = await call('getRunLog')
    chk('getRunLog 可调用（无运行时给出状态）', run.ok, true)

    const diag = await call('getDiagnostics')
    chk('getDiagnostics 可调用（读渲染侧统一问题模型）', diag.ok, true)
  }

  log('\n=== ④ 越界仍然被拒（沙箱在真实路径下也生效）===')
  {
    const a = await call('readFile', { path: '../secret.txt' })
    eq('`../secret.txt` → 拒', [a.ok, /越出 workspace/.test(String(a.error))], [false, true])

    const b = await call('readFile', { path: 'C:/Windows/System32/drivers/etc/hosts' })
    chk('绝对路径在 workspace 外 → 拒', b.ok === false, JSON.stringify(b).slice(0, 100))

    const c = await call('listDir', { path: '../../..' })
    chk('listDir 越界 → 拒', c.ok === false, JSON.stringify(c).slice(0, 100))

    const e = await call('readFile', { path: 'no-such-file-xyz.mbt' })
    chk('文件不存在 → ok:false（不抛）', e.ok === false, JSON.stringify(e).slice(0, 100))
  }

  log('\n=== ⑤ 关闭项目后 workspace 清空 ===')
  {
    await js('window.moonbitIDE.closeProject()')
    await sleep(1000)
    const w = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.workspace()))()'))
    chk('关闭后 workspace 清空（不再是刚才那个项目）', path.normalize(w.workspace || '') !== path.normalize(ROOT), String(w.workspace))
    const after = await call('readFile', { path: 'hello/cmd/main/main.mbt' })
    eq('**关闭项目后文件类工具应全部被拒**（不默默退到某个目录）', [after.ok === false, /未打开项目/.test(String(after.error))], [true, true])
  }

  console.log('\n=== ⑥ 执行工具清单（P7）===')
  {
    const l = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.exec.list()))()'))
    const tools = l.tools || []
    eq('6 个执行工具', tools.length, 6)
    eq('**全部是 execute（没有 write）**', Array.from(new Set(tools.map((t) => t.permission))).join(','), 'execute')
    chk('**没有改文件的工具**（P8 才开）', tools.filter((t) => ['applyPatch', 'writeFile'].includes(t.name)).length === 0, true)

    // health 不带 url → 退回报告运行状态：**不跑任何外部命令**，所以本机 moon 坏也能验
    const h = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.exec.call("health", {})))()'))
    eq('health 不带 url 可用（不跑外部命令）', [h.ok === true, /未提供 url/.test(String(h.data && h.data.note))], [true, true])

    const a = JSON.parse(await js('(async () => JSON.stringify(await window.moonbitIDE.agentTools.exec.audit()))()'))
    chk('执行有审计记录', (a.audit || []).length >= 1, true)
    chk('审计含 tool / result / duration', (a.audit[0] || {}).tool === 'health' && typeof (a.audit[0] || {}).duration === 'number', true)
  }

  log('\n=== P14-12 backendStatus 工具：真的能调（只读）===')
  {
    const r = JSON.parse(await js(`(async () => JSON.stringify(await window.moonbitIDE.agentTools.call('backendStatus', {})))()`))
    chk('backendStatus 可调用', r.ok === true, JSON.stringify(r).slice(0, 160))
    chk('  返回里有 port 与 deps', !!(r.data && typeof r.data.port === 'number' && r.data.deps), JSON.stringify(r.data).slice(0, 200))
    chk('  deps 标了 known（拿不到 docker 时不假装"没有"）', typeof r.data.deps.known === 'boolean', JSON.stringify(r.data.deps))
    // 本机没起后端服务 → 必须如实 ok:false，并给出可读原因
    chk('  如实报告连不上（不是假装健康）', r.data.ok === false, String(r.data.ok))
    chk('  且带可读错误', /连不上/.test(String(r.data.error)), String(r.data.error))
  }

  log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  dump(fail === 0 ? 0 : 1)
}).catch((e) => { log('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
