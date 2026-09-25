// 验证「组件是否真的跟着主题变了」——上一轮只做了机制、组件颜色写死，所以日间下卡片还是黑的。
// 判据：浅色主题下组件底色应当「亮」（相对亮度高），深色主题下应当「暗」，且两套必须不同。
const { createHarness } = require('./verify-harness')
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseRGB(s) {
  const m = String(s).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  return m ? [+m[1], +m[2], +m[3]] : null
}
function lum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await sleep(250) }
  if (win) { win.show(); win.focus() }
  await sleep(9000)
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const SHOT = path.join(__dirname, 'e2e-shots', 'theme')
  fs.mkdirSync(SHOT, { recursive: true })
  const safeShot = async (n) => { try { fs.writeFileSync(path.join(SHOT, n), (await win.webContents.capturePage()).toPNG()); console.log('  截图 ' + n) } catch (e) { console.log('  截图失败: ' + n) } }

  const H = createHarness()
  const chk = H.chk

  // 取样表达式（写成字符串，多处复用；避免 probe.toString() 那种脆做法）
  const PROBE = `(() => {
    const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null }
    return JSON.stringify({
      widgetBg: cs('.widget', 'backgroundColor'),
      widgetBorder: cs('.widget', 'borderTopColor'),
      widgetText: cs('.widget', 'color'),
      widgetCount: document.querySelectorAll('.widget').length,
      bannerGradient: cs('.dash-banner', 'backgroundImage'),
      hint: cs('.dash-hint', 'color'),
      calTitle: cs('.cal-title', 'color'),
      dayCell: cs('.dash-cal .d', 'color'),
      dayToday: cs('.dash-cal .d.today', 'backgroundColor'),
      wbtn: cs('.wbtn', 'color'),
      rowColor: cs('.dash-slot .row, .dash-slot .empty', 'color'),
      titlebar: cs('#titlebar', 'backgroundColor'),
      sidebar: cs('#sidebar', 'backgroundColor'),
      panel: cs('#panel', 'backgroundColor'),
    })
  })()`
  const withTheme = (mode) => js(`(async () => { window.moonbitTheme.set('${mode}'); await new Promise(r => setTimeout(r, 900)); return ${PROBE} })()`)

  console.log('=== 准备：切到主菜单 ===')
  await js(`(() => { const a = document.querySelector('a[data-view="home"]'); if (a) a.click() })()`)
  await sleep(1500)
  const pre = JSON.parse(await withTheme('dark'))
  console.log('  组件数:', pre.widgetCount)
  chk('工作台有组件', pre.widgetCount > 0, String(pre.widgetCount))

  console.log('\n=== 日间：组件底色应当是「亮」的 ===')
  const light = JSON.parse(await withTheme('light'))
  console.log('  ', JSON.stringify({ widgetBg: light.widgetBg, widgetBorder: light.widgetBorder, widgetText: light.widgetText, calTitle: light.calTitle, dayCell: light.dayCell, wbtn: light.wbtn }))
  const lw = parseRGB(light.widgetBg), lt = parseRGB(light.widgetText)
  chk('日间 widget 底色是亮色（亮度 > 0.8）', lw && lum(lw) > 0.8, light.widgetBg)
  chk('日间 widget 文字是深色（亮度 < 0.2）', lt && lum(lt) < 0.2, light.widgetText)
  chk('日间日历标题是深色', lum(parseRGB(light.calTitle) || [0, 0, 0]) < 0.3, light.calTitle)
  chk('日间日历日期文字是深色', lum(parseRGB(light.dayCell) || [0, 0, 0]) < 0.3, light.dayCell)
  chk('日间 #titlebar 是亮的', lum(parseRGB(light.titlebar) || [0, 0, 0]) > 0.8, light.titlebar)
  chk('日间 #sidebar 是亮的', lum(parseRGB(light.sidebar) || [0, 0, 0]) > 0.8, light.sidebar)
  chk('日间 #panel 是亮的', lum(parseRGB(light.panel) || [0, 0, 0]) > 0.8, light.panel)
  await safeShot('comp-light-home.png')

  console.log('\n=== 夜间：组件底色应当是「暗」的 ===')
  const dark = JSON.parse(await withTheme('dark'))
  console.log('  ', JSON.stringify({ widgetBg: dark.widgetBg, widgetBorder: dark.widgetBorder, widgetText: dark.widgetText, calTitle: dark.calTitle, dayCell: dark.dayCell, wbtn: dark.wbtn }))
  const dw = parseRGB(dark.widgetBg), dt = parseRGB(dark.widgetText)
  chk('夜间 widget 底色是深色（亮度 < 0.1）', dw && lum(dw) < 0.1, dark.widgetBg)
  chk('夜间 widget 文字是亮色（亮度 > 0.4）', dt && lum(dt) > 0.4, dark.widgetText)
  chk('夜间日历标题是亮色', lum(parseRGB(dark.calTitle) || [0, 0, 0]) > 0.4, dark.calTitle)
  chk('夜间 #titlebar 是暗的', lum(parseRGB(dark.titlebar) || [1, 1, 1]) < 0.15, dark.titlebar)
  await safeShot('comp-dark-home.png')

  console.log('\n=== 两套必须真的不同（这是本轮修复的核心）===')
  chk('widget 底色：日间 ≠ 夜间', light.widgetBg !== dark.widgetBg, `${light.widgetBg} vs ${dark.widgetBg}`)
  chk('widget 边框：日间 ≠ 夜间', light.widgetBorder !== dark.widgetBorder, `${light.widgetBorder} vs ${dark.widgetBorder}`)
  chk('widget 文字：日间 ≠ 夜间', light.widgetText !== dark.widgetText, `${light.widgetText} vs ${dark.widgetText}`)
  chk('日历标题：日间 ≠ 夜间', light.calTitle !== dark.calTitle, `${light.calTitle} vs ${dark.calTitle}`)
  chk('日历日期文字：日间 ≠ 夜间', light.dayCell !== dark.dayCell, `${light.dayCell} vs ${dark.dayCell}`)
  chk('顶部横幅渐变：日间 ≠ 夜间', light.bannerGradient !== dark.bannerGradient, `${String(light.bannerGradient).slice(0,60)} vs ${String(dark.bannerGradient).slice(0,60)}`)

  console.log('\n=== 「项目」标签也检查一遍 ===')
  await js(`(() => { const a = document.querySelector('a[data-view="project"]'); if (a) a.click() })()`)
  await sleep(1200)
  const projLight = JSON.parse(await js(`(async () => {
    window.moonbitTheme.set('light'); await new Promise(r=>setTimeout(r,900))
    const ed = document.querySelector('.monaco-editor .monaco-editor-background')
    return JSON.stringify({ editorBg: ed ? getComputedStyle(ed).backgroundColor : null })
  })()`))
  console.log('  ', JSON.stringify(projLight))
  chk('日间 Monaco 编辑器底色是亮的', lum(parseRGB(projLight.editorBg) || [0, 0, 0]) > 0.8, projLight.editorBg)
  await safeShot('comp-light-project.png')

  console.log('\n' + H.summary())
  app.quit()
  setTimeout(() => process.exit(H.exitCode()), 1500)
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
