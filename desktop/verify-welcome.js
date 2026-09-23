// 验证「未打开项目」的界面状态：
//   · 只显示欢迎页（打开/新建）
//   · 编译/运行按钮、命令面板、编辑器、底部面板都不可见
//   · 打开项目后这些恢复显示
require('./main.js')
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 3500))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.error('没拿到窗口'); app.exit(1); return }

  // 先清掉上次测试可能留下的标签记忆，并显式切到「项目」标签再断言。
  // 启动时落在哪个标签取决于 localStorage 与是否打开项目 —— 那是设计允许的；
  // 本脚本验证的是「项目标签 + 无项目」这个组合，不应依赖外部状态。
  await win.webContents.executeJavaScript(`(() => {
    try { localStorage.removeItem('moonbit-view') } catch (_) {}
    const a = document.querySelector('a[data-view="project"]'); if (a) a.click()
  })()`)
  await new Promise((r) => setTimeout(r, 400))

  const r = await win.webContents.executeJavaScript(`(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return '不存在'
      const cs = getComputedStyle(el)
      return (cs.display !== 'none' && cs.visibility !== 'hidden') ? '可见' : '隐藏'
    }
    const before = {
      bodyClass: document.body.className,
      welcome: vis('#welcomeScreen'),
      wsOpen: vis('#wsOpen'),
      wsNew: vis('#wsNew'),
      titlebar: vis('#titlebar'),
      runBtn: vis('button[data-cmd="run"]'),
      checkBtn: vis('button[data-cmd="check"]'),
      cmdBtn: vis('#cmdBtn'),
      body: vis('#body'),
      panel: vis('#panel'),
      runBtnText: (document.querySelector('button[data-cmd="run"]') || {}).textContent,
      checkBtnText: (document.querySelector('button[data-cmd="check"]') || {}).textContent,
    }
    return before
  })()`)

  console.log('\n  === 未打开项目时 ===')
  for (const [k, v] of Object.entries(r)) console.log('  ' + k.padEnd(14) + ': ' + v)
  const okEmpty =
    r.welcome === '可见' && r.wsOpen === '可见' && r.wsNew === '可见' &&
    r.runBtn === '隐藏' && r.checkBtn === '隐藏' && r.cmdBtn === '隐藏' &&
    r.body === '隐藏' && r.panel === '隐藏'
  console.log('\n  ' + (okEmpty ? '✅ 空状态正确：只剩打开/新建，其余全隐藏' : '❌ 空状态不对'))

  // ===== 场景 2：切到其它标签，无项目也应正常显示 =====
  const other = await win.webContents.executeJavaScript(`(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return '不存在'
      const cs = getComputedStyle(el)
      return (cs.display !== 'none' && cs.visibility !== 'hidden') ? '可见' : '隐藏'
    }
    const out = {}
    for (const v of ['home', 'agent', 'tools']) {
      // 模拟点击该标签
      const a = document.querySelector('a[data-view="' + v + '"]')
      if (a) a.click()
      out[v] = {
        welcome: vis('#welcomeScreen'),
        mainview: vis('#mainview-' + v),
      }
    }
    return out
  })()`)
  console.log('\n  === 无项目时切到其它标签（应正常显示，欢迎页不出现）===')
  let okOther = true
  for (const [k, v] of Object.entries(other)) {
    const good = v.welcome === '隐藏' && v.mainview === '可见'
    if (!good) okOther = false
    console.log('  ' + k.padEnd(7) + ' 欢迎页=' + v.welcome + '  该标签内容=' + v.mainview + '  ' + (good ? '✅' : '❌'))
  }
  console.log('\n  ' + (okOther ? '✅ 其它标签不受「无项目」影响' : '❌ 其它标签被错误锁住'))

  // ===== 场景 3：回到项目标签，仍应只显示欢迎页 =====
  const back = await win.webContents.executeJavaScript(`(() => {
    const a = document.querySelector('a[data-view="project"]')
    if (a) a.click()
    const vis = (sel) => {
      const el = document.querySelector(sel)
      const cs = el ? getComputedStyle(el) : null
      return el && cs.display !== 'none' ? '可见' : '隐藏'
    }
    return { welcome: vis('#welcomeScreen'), runBtn: vis('button[data-cmd="run"]') }
  })()`)
  console.log('\n  === 切回项目标签（无项目）===')
  console.log('  欢迎页=' + back.welcome + '  运行按钮=' + back.runBtn)
  const okBack = back.welcome === '可见' && back.runBtn === '隐藏'
  console.log('  ' + (okBack ? '✅ 项目标签仍是「只留打开/新建」' : '❌ 项目标签状态不对'))

  // 清理本次测试对 localStorage 的污染（点标签会写入 moonbit-view）
  try { await win.webContents.executeJavaScript(`(() => { localStorage.removeItem('moonbit-view') })()`) } catch (_) {}
  app.exit(okEmpty && okOther && okBack ? 0 : 1)
})
