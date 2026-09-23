// 主题切换：日间（浅色护眼）/ 夜间（深色）/ 自动（按时间）
//
// 依据（详见 index.html 里 EXTRA_CSS 的注释）：
//   · WCAG 2.1 SC 1.4.3：正文对比度 ≥ 4.5:1（AA），大字/UI ≥ 3:1，AAA 为 7:1
//   · Solarized 原则：屏幕上「纯黑字 + 纯白底」相当于在直射阳光下看书，要降【亮度对比】
//     但保留【色相对比】，否则可读性崩
//
// 实现：日间不是另做一套界面，而是启用一份「浅色差异覆盖表」（moonbit-ui-light.css），
//       它是从 Strapi 自己的 light theme 导出的（见 export-strapi-page.js），
//       再配上 :root[data-theme="light"] 的变量映射，Monaco 也跟着换主题。
(function () {
  const KEY = 'moonbit-theme'
  const DAY_FROM = 7
  const DAY_TO = 18   // auto 模式下 7:00–18:00 用日间

  function mode() {
    try { return localStorage.getItem(KEY) || 'auto' } catch (_) { return 'auto' }
  }
  function resolve(m) {
    if (m === 'light' || m === 'dark') return m
    const h = new Date().getHours()
    return (h >= DAY_FROM && h < DAY_TO) ? 'light' : 'dark'
  }
  function realTheme() { return document.documentElement.dataset.theme || 'dark' }

  function apply() {
    const m = mode()
    const real = resolve(m)
    document.documentElement.dataset.theme = real
    // 浅色差异覆盖表（只含差异，依赖 moonbit-ui.css 先加载）
    const ov = document.getElementById('themeOverride')
    if (ov) ov.disabled = real !== 'light'
    // Monaco 跟随
    // Monaco 跟随。注意它由 loader.js 异步加载，theme.js 首次跑时 window.monaco 可能还不存在，
    // 那样这次 setTheme 就被跳过了（开机永远深色就是这个原因）。所以没就绪就延迟重试一次。
    try {
      if (window.monaco && window.monaco.editor && window.monaco.editor.setTheme) {
        window.monaco.editor.setTheme(real === 'light' ? 'strapi-light' : 'strapi-dark')
      } else if (!window.__mbThemeRetry) {
        window.__mbThemeRetry = true
        setTimeout(() => { window.__mbThemeRetry = false; apply() }, 1500)
      }
    } catch (_) {}
    paint(real, m)
  }

  function paint(real, m) {
    const el = document.getElementById('themeToggle')
    if (!el) return
    const label = m === 'auto' ? `自动 · ${real === 'light' ? '日间' : '夜间'}` : (m === 'light' ? '日间' : '夜间')
    // 图标用 SVG（icons.js），不用 ☀/☾ 这类字符
    el.textContent = ''
    const ic = document.createElement('span')
    ic.className = 'theme-ico'
    if (window.MBIcons) window.MBIcons.into(ic, real === 'light' ? 'sun' : 'moon', 14)
    else ic.textContent = real === 'light' ? 'day' : 'night'
    const tx = document.createElement('span')
    tx.textContent = label
    el.appendChild(ic)
    el.appendChild(tx)
    el.title = '点一下切换：日间 → 夜间 → 自动（当前：' + label + '）'
  }

  function set(m) {
    try { localStorage.setItem(KEY, m) } catch (_) {}
    apply()
  }
  function cycle() {
    const order = ['light', 'dark', 'auto']
    set(order[(order.indexOf(mode()) + 1) % order.length])
  }

  function mount() {
    // 挂在右下角固定位置：它必须「哪个标签下都看得到」，
    // 而状态栏只在「项目」标签里，所以不能挂那儿。
    if (!document.getElementById('themeToggle')) {
      const el = document.createElement('div')
      el.id = 'themeToggle'
      el.onclick = cycle
      document.body.appendChild(el)
    }
    apply()
    // auto 模式每 10 分钟重算（跨过昼夜切换点）
    setInterval(() => { if (mode() === 'auto') apply() }, 600000)
  }

  window.moonbitTheme = { apply, set, mode, resolve, realTheme }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()
