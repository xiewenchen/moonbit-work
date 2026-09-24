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
    try { localStorage.removeItem('moonbit-view'); localStorage.removeItem('moonbit-banner-hidden') } catch (_) {}
    // 让顶部宣传条显示（它可能因「记住关闭」而隐藏 —— 隐藏了布局断言就没意义）
    const byText = (t) => { for (const e of document.querySelectorAll('*')) { if (e.children.length === 0 && (e.textContent || '').trim() === t) return e } return null }
    let bn = byText('MoonBit 工作台')
    for (let i = 0; i < 6 && bn; i++) { if (bn.tagName === 'DIV' && String(bn.className).includes('hbAFoo')) break; bn = bn.parentElement }
    if (bn) bn.style.display = 'flex'
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
    // 几何：欢迎页必须只在「内容区」里，不能盖住左侧标签栏与顶部宣传条
    const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), right: Math.round(b.x + b.width), bottom: Math.round(b.y + b.height) } }
    const byText = (t) => { for (const e of document.querySelectorAll('*')) { if (e.children.length === 0 && (e.textContent || '').trim() === t) return e } return null }
    let bn = byText('MoonBit 工作台')
    for (let i = 0; i < 6 && bn; i++) { if (bn.tagName === 'DIV' && String(bn.className).includes('hbAFoo')) break; bn = bn.parentElement }
    before.navRect = box(document.querySelector('nav'))
    before.bannerRect = box(bn)
    before.welcomeRect = box(document.getElementById('welcomeScreen'))
    return before
  })()`)

  console.log('\n  === 未打开项目时 ===')
  for (const [k, v] of Object.entries(r)) console.log('  ' + k.padEnd(14) + ': ' + (v && typeof v === 'object' ? JSON.stringify(v) : v))
  const okEmpty =
    r.welcome === '可见' && r.wsOpen === '可见' && r.wsNew === '可见' &&
    r.runBtn === '隐藏' && r.checkBtn === '隐藏' && r.cmdBtn === '隐藏' &&
    r.body === '隐藏' && r.panel === '隐藏'
  console.log('\n  ' + (okEmpty ? '✅ 空状态正确：只剩打开/新建，其余全隐藏' : '❌ 空状态不对'))

  // 布局：欢迎页不得盖住左侧标签栏 / 顶部宣传条（曾经用 fixed; inset:0 铺满整个窗口）
  const wr = r.welcomeRect, nr = r.navRect, br = r.bannerRect
  const okLayout = !!wr && !!nr && wr.x >= nr.right && (!br || wr.y >= br.bottom)
  console.log('  左侧标签栏 right=' + (nr ? nr.right : '?') + '  顶部宣传条 bottom=' + (br ? br.bottom : '?') +
    '  欢迎页 x=' + (wr ? wr.x : '?') + ' y=' + (wr ? wr.y : '?'))
  console.log('\n  ' + (okLayout ? '✅ 欢迎页只占内容区：左侧标签栏与顶部宣传条都没被盖住' : '❌ 欢迎页越界，盖住了左侧标签栏或顶部宣传条'))

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
  app.exit(okEmpty && okLayout && okOther && okBack ? 0 : 1)
}).catch((e) => { log('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
