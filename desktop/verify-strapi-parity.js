// ⚠️ 已过时（2026-09-26）—— **不再作为回归判据**
//
// 这个脚本断言的是"IDE 的实际 computed style == Strapi 的实测配色基准"。
// 它来自"把 UI 对齐 Strapi"那个阶段。而后来主题做了 **token 化**（日间/夜间两套 token），
// 配色**有意**不再等于 Strapi 基准 —— 于是它的 8 项配色断言必然失败。
//
// **这不是缺陷，是前提变了。** 继续以红灯示人只会长期淹没真正的回归，
// 所以把它明确标成过时：仍然会跑、仍然会把每一项打印出来（便于人工比对），
// 但**退出码按"过时"处理**，不参与"回归是否通过"的判定。
//
// 若将来确实要重新做"与某个基准对齐"，应当**重写**成对 token 的断言（见 verify-dash.js 的做法）。
//
// Strapi 对齐度验证 v2：把 IDE 的实际 computed style 与「Strapi 实测基准」逐项比对。
//
// v1 的教训：断言写得不严谨会误报 ——
//   · 背景/文字在 #app 上，测 body 得到 rgba(0,0,0,0)（透明）
//   · CSS 变量读出来是 hex 定义值，基准是 computed 的 rgb()，格式不同不能直接比
// 所以这里统一：元素取对 + 两边都归一成 rgb() 再比。
const OBSOLETE = true
const OBSOLETE_REASON = '主题已 token 化（日间/夜间），"与 Strapi 配色一致"不再是目标 —— 前提已变，不是缺陷'
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// #c0c0cf → rgb(192, 192, 207)
function hex2rgb(v) {
  const s = String(v).trim()
  if (!s.startsWith('#')) return s
  const n = parseInt(s.slice(1, 7), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await sleep(250) }
  await sleep(8000)
  const js = (c) => win.webContents.executeJavaScript(c, true)

  const snap = await js(`(() => {
    const cs = (el, p) => el ? getComputedStyle(el)[p] : ''
    const root = getComputedStyle(document.documentElement)
    const v = (n) => root.getPropertyValue(n).trim()
    const btn = Array.from(document.querySelectorAll('button')).find(b => {
      const c = getComputedStyle(b).backgroundColor
      return c && c !== 'rgba(0, 0, 0, 0)'
    })
    const actActive = document.querySelector('#activitybar .act.active')
    const tabActive = document.querySelector('#panelHead span.active')
    return JSON.stringify({
      appBg: cs(document.getElementById('app'), 'backgroundColor'),
      sidebarBg: cs(document.getElementById('sidebar'), 'backgroundColor'),
      appColor: cs(document.getElementById('app'), 'color'),
      strongColor: cs(tabActive, 'color'),
      btnBg: cs(btn, 'backgroundColor'),
      btnRadius: cs(btn, 'borderRadius'),
      actColor: cs(actActive, 'color'),
      actBarBg: cs(document.getElementById('activitybar'), 'backgroundColor'),
      vText: v('--s-text'),
      vPrimary: v('--s-primary'),
      vDanger: v('--s-danger'),
      vSuccess: v('--s-success'),
      vBorder: v('--s-border'),
      vHover: v('--s-bg-hover'),
      vActive: v('--s-bg-active'),
    })
  })()`)
  const s = JSON.parse(snap)

  let pass = 0, fail = 0
  const cmp = (name, got, want) => {
    const a = hex2rgb(got), b = hex2rgb(want)
    const ok = a === b
    if (ok) pass++; else fail++
    console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name.padEnd(20)} IDE=${String(a).padEnd(22)} Strapi=${b}`)
  }

  console.log('=== ① 实测对比：IDE 实际渲染值 vs Strapi 实测基准 ===')
  cmp('页面底', s.appBg, 'rgb(24, 24, 38)')
  cmp('面板/侧栏底', s.sidebarBg, 'rgb(33, 33, 52)')
  cmp('活动栏底', s.actBarBg, 'rgb(33, 33, 52)')
  cmp('正文色', s.appColor, 'rgb(192, 192, 207)')
  cmp('强文字/标题', s.strongColor, 'rgb(255, 255, 255)')
  cmp('主按钮底色', s.btnBg, 'rgb(73, 69, 255)')
  cmp('活动栏选中图标', s.actColor, 'rgb(123, 121, 255)')
  cmp('圆角', s.btnRadius, '4px')

  console.log('\n=== ② token 原值核对（对 Strapi dark theme 源码）===')
  cmp('--s-text', s.vText, '#c0c0cf')
  cmp('--s-primary', s.vPrimary, '#7b79ff')
  cmp('--s-danger', s.vDanger, '#ee5e52')
  cmp('--s-success', s.vSuccess, '#5cb176')
  cmp('--s-border', s.vBorder, '#32324d')
  cmp('--s-bg-hover', s.vHover, '#32324d')
  cmp('--s-bg-active', s.vActive, '#4a4a6a')

  console.log('\n=== ③ Strapi 原始规则落地检查 ===')
  const R = JSON.parse(await js(`(() => {
    const html = getComputedStyle(document.documentElement)
    const btn = document.querySelector('#titlebar button:not(.ghost)') || document.querySelector('button')
    const act = document.querySelector('#activitybar .act.active')
    const cs = (el,p) => el ? getComputedStyle(el)[p] : ''
    return JSON.stringify({
      htmlFontSize: html.fontSize,
      bodyLineHeight: cs(document.body,'lineHeight'),
      fontFamily: cs(document.body,'fontFamily'),
      btnHeight: cs(btn,'height'),
      btnBorderWidth: cs(btn,'borderTopWidth'),
      btnTransition: cs(btn,'transitionProperty'),
      btnDuration: cs(btn,'transitionDuration'),
      actBg: cs(act,'backgroundColor'),
      actColor: cs(act,'color'),
    })
  })()`))
  console.log('  ', JSON.stringify(R))
  const rk = (n, ok, d) => { if (ok) { pass++; console.log(`  [PASS] ${n}`) } else { fail++; console.log(`  [FAIL] ${n}  ${d}`) } }
  rk('html font-size = 62.5%（10px）· Strapi 的 1rem=10px 技巧', R.htmlFontSize === '10px', R.htmlFontSize)
  // computed 会把 1.5 换算成 px（13 × 1.5 = 19.5），这里两种形式都接受
  rk('body line-height = 1.5（Strapi 原文）', R.bodyLineHeight === '19.5px' || R.bodyLineHeight === '1.5', R.bodyLineHeight)
  rk('字体族用 Strapi 那串（-apple-system 开头）', R.fontFamily.includes('-apple-system'), R.fontFamily.slice(0,40))
  rk('按钮高度 3.2rem = 32px（证明 1rem=10px 真的生效）', R.btnHeight === '32px', R.btnHeight)
  // 边框宽度会受窗口 scaling 影响，只要求“有边框”
  rk('按钮有边框（Strapi 按钮是 border 而非纯背景块）', parseFloat(R.btnBorderWidth) > 0, R.btnBorderWidth)
  rk('过渡属性含 border-color（Strapi 原文三属性）', R.btnTransition.includes('border-color'), R.btnTransition)
  // computed 把 120ms 写成 0.12s、200ms 写成 0.2s
  rk('过渡时长两档 120ms/200ms（原文值）', (/0\.12s|120ms/.test(R.btnDuration)) && (/0\.2s|200ms/.test(R.btnDuration)), R.btnDuration)
  rk('活动栏 active = 浅色底（primary200 #4a4a6a），不是左侧竖条', R.actBg === 'rgb(74, 74, 106)', R.actBg)

  console.log('\n=== ④ 功能未受损 ===')
  const intact = await js(`(async () => {
    const dirs = Array.from(document.querySelectorAll('#tree .node')).filter(n => n.textContent.startsWith('▸'))
    dirs.slice(0, 4).forEach(d => d.click())
    await new Promise(r => setTimeout(r, 2200))
    return JSON.stringify({
      tree: document.querySelectorAll('#tree .node').length,
      editor: !!document.querySelector('.monaco-editor'),
      acts: document.querySelectorAll('#activitybar .act').length,
      panels: document.querySelectorAll('#panelHead [data-panel]').length,
      terminal: !!document.getElementById('terminal'),
      backend: !!document.getElementById('beStart'),
      api: !!document.getElementById('apiSend'),
    })
  })()`)
  const it = JSON.parse(intact)
  console.log('  ', intact)
  const okAll = it.tree > 0 && it.editor && it.acts === 4 && it.panels === 5 && it.terminal && it.backend && it.api
  if (okAll) { pass++; console.log('  [PASS] 文件树/编辑器/活动栏/底部面板/终端/后端/接口 全部正常') }
  else { fail++; console.log('  [FAIL] 有功能缺失') }

  const SHOT = path.join(__dirname, 'e2e-shots', 'views')
  fs.mkdirSync(SHOT, { recursive: true })
  // ⚠️ 同上：截图是附加产物，失败不该改变验证结论（无 GUI 时 capturePage 会抛 UnknownVizError）
  try {
    fs.writeFileSync(path.join(SHOT, 'strapi-parity.png'), (await win.webContents.capturePage()).toPNG())
    console.log('\n截图: e2e-shots/views/strapi-parity.png')
  } catch (e) {
    console.log('\n（截图跳过：' + String((e && e.message) || e).slice(0, 60) + ' —— 不影响上面的结论）')
  }
  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
  if (OBSOLETE) {
    console.log('\n⚠️ 本脚本**已过时**：' + OBSOLETE_REASON)
    console.log('   → 退出码按"过时"处理（0），不参与回归判定 —— 但上面的逐项结果仍然打印，便于人工比对。')
    app.exit(0)
    return
  }
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
