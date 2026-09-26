// ⚠️ 已过时（2026-09-26）—— **不再作为回归判据**（理由同 verify-strapi-parity.js）
//
// 它是"把 UI 对齐 Strapi"那个阶段的最终验收。主题 token 化之后，
// 这些"与 Strapi 一致"的断言必然失败 —— **前提已变，不是缺陷**。
// 仍会跑、仍会打印结果（便于人工比对），但退出码按"过时"处理。
const OBSOLETE = true
const OBSOLETE_REASON = '主题已 token 化，"与 Strapi 一致"不再是目标 —— 前提已变，不是缺陷'
// ⚠️ 过时脚本的兜底：这个脚本的失败发生在**渲染侧**（不在 JS 的 promise 链上），
//    所以 .catch 兜不住 —— 用 uncaughtException 把退出码归零，但**一定打印原因**（不静默）。
process.on('uncaughtException', (e) => {
  console.log('\n⚠️ 本脚本**已过时**，且本轮中途出错：' + String((e && e.message) || e).slice(0, 120))
  console.log('   原因：' + OBSOLETE_REASON + '　→ 退出码按"过时"处理（0），这不是产品回归。')
  process.exit(0)
})
// Strapi 主题化最终验收：外围 UI + Monaco + 新组件（Toast / EmptyState）
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await new Promise(r=>setTimeout(r,250)) }
  await new Promise(r=>setTimeout(r,6000))
  const js = (c) => win.webContents.executeJavaScript(c, true)

  let pass = 0, fail = 0
  const check = (n, c, d='') => { if (c) { pass++; console.log(`  [PASS] ${n}`) } else { fail++; console.log(`  [FAIL] ${n}  ${d}`) } }

  console.log('=== ① Monaco 主题与外围是否统一（消除"两个世界"）===')
  const t = await js(`(() => {
    const cs = getComputedStyle(document.documentElement)
    const edBg = getComputedStyle(document.getElementById('editor')).backgroundColor
    const shellBg = getComputedStyle(document.getElementById('app')).backgroundColor
    const lines = getComputedStyle(document.querySelector('.monaco-editor .view-lines') || document.body).color
    return JSON.stringify({ edBg: edBg, shellBg: shellBg, varDeepest: cs.getPropertyValue('--s-bg-deepest').trim(), lines: lines })
  })()`)
  console.log('  ', String(t))
  const tt = JSON.parse(t)
  check('编辑器容器背景 = Strapi 最深色', tt.edBg === 'rgb(24, 24, 38)', tt.edBg)
  check('外壳背景 = 编辑器容器背景（无断层）', tt.edBg === tt.shellBg, `${tt.edBg} vs ${tt.shellBg}`)

  // 通过 Monaco API 确认主题名与其中的颜色真的生效
  const themeInfo = await js(`(() => {
    try {
      const g = monaco.editor.getEditors ? monaco.editor.getEditors()[0] : null
      // 从 DOM 里读 Monaco 实际渲染出来的背景
      const bg = document.querySelector('.monaco-editor .monaco-editor-background')
      const margin = document.querySelector('.monaco-editor .margin')
      return JSON.stringify({
        editorBg: bg ? getComputedStyle(bg).backgroundColor : 'none',
        marginBg: margin ? getComputedStyle(margin).backgroundColor : 'none',
      })
    } catch (e) { return JSON.stringify({ err: String(e.message) }) }
  })()`)
  console.log('  ', String(themeInfo))
  const ti = JSON.parse(themeInfo)
  check('Monaco 内部背景也是 #181826（主题生效，不是 vs-dark 的 #1e1e1e）',
    ti.editorBg === 'rgb(24, 24, 38)', `${ti.editorBg}`)
  check('Monaco 行号区背景同步', ti.marginBg === 'rgb(24, 24, 38)', `${ti.marginBg}`)

  console.log('\n=== ② Toast 组件 ===')
  const toastOk = await js(`(async () => {
    toast('编译成功', 'ok')
    await new Promise(r => setTimeout(r, 260))
    const box = document.getElementById('toast')
    const el = box.lastElementChild
    const cs = el ? getComputedStyle(el) : null
    return JSON.stringify({
      count: box.childNodes.length,
      text: el ? el.textContent : '',
      shown: el ? el.classList.contains('show') : false,
      borderLeft: cs ? cs.borderLeftColor : '',
      radius: cs ? cs.borderRadius : '',
    })
  })()`)
  console.log('  ', String(toastOk))
  const to = JSON.parse(toastOk)
  check('Toast 能弹出', to.count > 0 && to.text === '编译成功', JSON.stringify(to))
  check('Toast 有 show 类（可见）', to.shown === true)
  check('Toast 左边框是 Strapi success 色', to.borderLeft === 'rgb(92, 177, 118)', to.borderLeft)
  check('Toast 圆角 4px', to.radius === '4px', to.radius)

  console.log('\n=== ③ EmptyState 组件 ===')
  const emptyOk = await js(`(() => {
    const box = document.getElementById('searchResults')
    emptyState(box, '没有匹配结果', '试试更短的关键词')
    const el = box.querySelector('.empty-state')
    return JSON.stringify({ has: !!el, text: el ? el.textContent : '', color: el ? getComputedStyle(el).color : '' })
  })()`)
  console.log('  ', String(emptyOk))
  const eo = JSON.parse(emptyOk)
  check('EmptyState 能渲染', eo.has === true, JSON.stringify(eo))
  check('EmptyState 含标题与提示', eo.text.includes('没有匹配结果') && eo.text.includes('更短'), eo.text)
  check('EmptyState 用次要文字色', eo.color === 'rgb(102, 102, 135)', eo.color)

  console.log('\n=== ④ 三态按钮（Strapi: 主 / 次 / 危险）===')
  const btns = await js(`(() => {
    const g = (sel, p) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[p] : 'none' }
    return JSON.stringify({
      primary: g('button[data-cmd]', 'backgroundColor'),
      ghost: g('button.ghost', 'backgroundColor'),
      ghostBorder: g('button.ghost', 'borderTopColor'),
    })
  })()`)
  console.log('  ', String(btns))
  const b = JSON.parse(btns)
  check('主按钮 = Strapi primary', b.primary === 'rgb(123, 121, 255)', b.primary)
  check('次按钮透明底 + 描边', b.ghost === 'rgba(0, 0, 0, 0)' && b.ghostBorder === 'rgb(74, 74, 106)', `${b.ghost} / ${b.ghostBorder}`)

  console.log('\n=== ⑤ 截图 ===')
  try {
    const p = path.join(__dirname, 'e2e-shots', 'S02-strapi-final.png')
    fs.writeFileSync(p, (await win.webContents.capturePage()).toPNG())
    console.log('  已保存:', p)
  } catch (e) { console.log('  截图失败:', e.message) }

  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass+fail} 项`)
  if (OBSOLETE) {
    console.log('\n⚠️ 本脚本**已过时**：' + OBSOLETE_REASON)
    console.log('   → 退出码按"过时"处理（0），不参与回归判定 —— 逐项结果仍打印，便于人工比对。')
    app.exit(0)
    return
  }
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => {
  // ⚠️ 过时脚本**即使中途抛错**也不该染红回归 —— 但必须把原因说清楚（不静默）。
  if (OBSOLETE) {
    console.log('\n⚠️ 本脚本**已过时**，且本轮中途出错：' + String((e && e.message) || e).slice(0, 120))
    console.log('   原因：' + OBSOLETE_REASON)
    console.log('   → 退出码按"过时"处理（0）。这不是产品回归。')
    process.exit(0)
  }
  console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e))
  process.exit(1)
})
