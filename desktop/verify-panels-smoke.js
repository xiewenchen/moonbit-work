// 面板冒烟测试：每个面板都真开一遍，断言"里面真的渲染出了东西"。
//
// 为什么需要它：P13-04 补 时发现 showOfficePanel 结尾**从没调 refresh()** ——
// 面板挂上去了、IPC 也全对，但打开永远是空的。这类 bug 单看代码很难发现
//（其余 4 个面板都有加载调用，只有它漏了），而"打开一个面板看有没有东西"却一秒能验。
//
// 它不测业务逻辑（那是各面板自己 verify-*.js 的事），只测**最底线的**：
// 面板存在 + 关键容器有内容 + 控制台没抛未捕获异常。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const PROJ = path.resolve(__dirname, '..')
const OUT = path.join(__dirname, 'panels-smoke-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const { chk, eq } = H

function dump(code) {
  try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (e) {
    console.log('（结果文件写入失败，忽略：' + String((e && e.message) || e) + '）')
  }
  setTimeout(() => app.exit(code), 500)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 面板：入口（window.moonbitIDE 上的调用）→ 面板根 id → 必须有内容的容器
const PANELS = [
  { name: '文件服务商 Provider', call: 'window.moonbitIDE.agentTools.provider.openPanel()', root: 'providerPanel', containers: ['providerList'] },
  { name: '工程状态 Quality', call: 'window.moonbitIDE.quality.show()', root: 'qualityPanel', containers: ['qualityList'] },
  { name: '数据库工作台', call: 'window.moonbitIDE.database.show()', root: 'dbPanel', containers: [] },
  { name: '工作台 Workbench', call: 'window.moonbitIDE.workbench.show()', root: 'wbPanel', containers: [] },
  { name: '会话 Session', call: 'window.moonbitIDE.session.show()', root: 'sessPanel', containers: [] },
  { name: '项目知识 Memory', call: 'window.moonbitIDE.memory.show()', root: 'memPanel', containers: [] },
  { name: '办公联动 Office', call: 'window.moonbitIDE.office.show()', root: 'officePanel', containers: ['officeRelay'] },
  { name: '环境诊断', call: 'window.moonbitIDE.env.show()', root: 'envPanel', containers: [] },
  { name: '设置 Settings', call: 'window.moonbitIDE.settings.show()', root: 'settingsPanel', containers: [] },
  { name: '关于 About', call: 'window.moonbitIDE.about.show()', root: 'aboutPanel', containers: ['aboutInfo'] },
]

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  await sleep(3000)

  // 捕获渲染侧未捕获异常 —— 面板里的 bug 常常表现为这里冒一条
  await js(`(function () {
    window.__smokeErrors = []
    window.addEventListener('error', (e) => window.__smokeErrors.push(String(e.message || e)))
    window.addEventListener('unhandledrejection', (e) => window.__smokeErrors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason)))
    return true
  })()`)

  // 打开一个项目（多数面板依赖"当前项目"才有内容可渲染）
  await js(`window.moonbitIDE.openProject(${JSON.stringify(PROJ)})`)
  await sleep(2500)

  log('=== 逐个打开面板，断言"真的渲染出了东西" ===')
  for (const p of PANELS) {
    // 关掉上一个面板，避免互相干扰
    await js(`document.querySelectorAll('#providerPanel,#qualityPanel,#dbPanel,#wbPanel,#sessPanel,#memPanel,#officePanel,#envPanel,#settingsPanel,#aboutPanel').forEach((x) => x.remove())`)
    await sleep(150)

    const exists = await js(`(() => { try { ${p.call}; return 'ok' } catch (e) { return 'throw: ' + e.message } })()`)
    await sleep(1400)

    const rootOk = await js(`!!document.getElementById(${JSON.stringify(p.root)})`)
    chk('[' + p.name + '] 能打开且根节点存在', rootOk === true, 'exists=' + exists + ' root=' + p.root)

    if (rootOk) {
      const textLen = await js(`(document.getElementById(${JSON.stringify(p.root)}) || {}).textContent.length || 0`)
      chk('[' + p.name + '] ★ 面板里**有内容**（不是空白壳子）', Number(textLen) > 40, 'textContent 长度=' + textLen + (Number(textLen) <= 40 ? '  ← 打开就空，疑似漏了加载调用' : ''))

      for (const c of p.containers) {
        const cl = await js(`(() => { const e = document.getElementById(${JSON.stringify(c)}); return e ? e.textContent.length : -1 })()`)
        chk('[' + p.name + '] 容器 #' + c + ' 有内容', Number(cl) > 0, '长度=' + cl)
      }
    }

    await js(`(() => { const b = Array.from(document.querySelectorAll('button')).filter((x) => x.textContent === '关闭'); b.forEach((x) => x.click()) })()`)
    await sleep(200)
  }

  log('\n=== 渲染侧未捕获异常（面板冒烟期间）===')
  const errs = JSON.parse(await js(`JSON.stringify(window.__smokeErrors || [])`))
  chk('★ 没有未捕获异常', errs.length === 0, JSON.stringify(errs).slice(0, 300))

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
