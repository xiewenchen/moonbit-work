// 进入 Strapi admin 并抓实测 UI：dark + light 两套配色都抓。
// 关键修正：admin 的 token 是 `JSON.stringify(token)` 存进 jwtToken 的，
// 裸字符串会让它 JSON.parse 失败 → 白屏（踩过）。
// 另外 isLoggedIn 也要设，否则它不认登录态。
// 主题开关就是 localStorage 的 STRAPI_THEME —— 顺便实测两套 token。
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const BASE = 'http://localhost:1337'
const EMAIL = 'admin@moonbit.dev'
const PASS = 'Moonbit@2026'
const SHOT_DIR = path.join(__dirname, 'e2e-shots', 'strapi')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getToken() {
  const res = await fetch(BASE + '/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  const j = await res.json()
  return j.data && j.data.token
}

app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const token = await getToken()
  console.log('token:', token ? token.slice(0, 20) + '…' : '(失败)')

  const win = new BrowserWindow({
    width: 1680, height: 1000, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
  })
  win.webContents.on('console-message', (e, level, msg) => {
    const s = String(msg)
    if (/SyntaxError|Uncaught|Failed to fetch/i.test(s)) console.log('  [renderer]', s.slice(0, 160))
  })
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const shot = async (n) => {
    fs.writeFileSync(path.join(SHOT_DIR, n + '.png'), (await win.webContents.capturePage()).toPNG())
    console.log('  截图:', n + '.png')
  }

  // 抓当前页面的真实样式（背景/文字色按出现次数排序 = 实际调色板）
  const sample = () => js(`(() => {
    const all = Array.from(document.querySelectorAll('*'))
    const bg = {}, fg = {}
    for (const el of all) {
      const c = getComputedStyle(el)
      if (c.backgroundColor !== 'rgba(0, 0, 0, 0)') bg[c.backgroundColor] = (bg[c.backgroundColor]||0)+1
      if (el.children.length === 0 && el.textContent.trim()) fg[c.color] = (fg[c.color]||0)+1
    }
    const top = (o,n) => Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,n).map(x=>x[0]+' ×'+x[1])
    const pick = (el) => { if (!el) return null; const c = getComputedStyle(el); return {
      bg: c.backgroundColor, color: c.color, size: c.fontSize, weight: c.fontWeight, radius: c.borderRadius, pad: c.padding, h: c.height, border: c.border } }
    return JSON.stringify({
      url: location.href,
      elCount: all.length,
      theme: localStorage.getItem('STRAPI_THEME'),
      htmlFontSize: getComputedStyle(document.documentElement).fontSize,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      fontFamily: getComputedStyle(document.body).fontFamily.split(',')[0],
      topBackgrounds: top(bg, 8),
      topTextColors: top(fg, 8),
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0,10).map(h=>h.tagName+':'+h.textContent.trim()),
      navLinks: Array.from(document.querySelectorAll('a[href^="/admin"]')).slice(0,20).map(a=>a.textContent.trim()).filter(Boolean),
      buttons: Array.from(document.querySelectorAll('button')).slice(0,14).map(b=>b.textContent.trim()).filter(Boolean),
      primaryBtn: (() => { const b = Array.from(document.querySelectorAll('button')).find(x => { const c=getComputedStyle(x).backgroundColor; return c && c!=='rgba(0, 0, 0, 0)' }); return b ? { text: b.textContent.trim().slice(0,16), style: pick(b) } : null })(),
      firstInput: pick(document.querySelector('input')),
      elCounts: { inputs: document.querySelectorAll('input').length, tables: document.querySelectorAll('table').length, navs: document.querySelectorAll('nav').length },
    }, null, 1)
  })()`)

  console.log('\n=== ① 建立 origin，注入 token（JSON.stringify！）+ isLoggedIn ===')
  await win.loadURL(BASE + '/admin')
  await sleep(6000)
  console.log('  注入:', await js(`(() => {
    localStorage.setItem('jwtToken', JSON.stringify(${JSON.stringify(token)}))
    localStorage.setItem('isLoggedIn', 'true')
    return Object.keys(localStorage).join(', ')
  })()`))

  for (const theme of ['dark', 'light']) {
    console.log(`\n=== ② 主题 ${theme}：重载并采样 ===`)
    await js(`localStorage.setItem('STRAPI_THEME', ${JSON.stringify(theme)})`)
    await win.loadURL(BASE + '/admin')
    await sleep(14000)
    const s = await sample()
    console.log(s)
    await shot(theme === 'dark' ? '10-admin-dark' : '11-admin-light')
  }

  console.log('\n截图目录:', SHOT_DIR)
  app.quit()
})
