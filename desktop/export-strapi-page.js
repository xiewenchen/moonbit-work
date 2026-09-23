// 抓「渲染后的 HTML + 同一时刻生效的 CSS」—— 这两份来自同一次渲染，类名天然自洽。
// 这才是可转译的"源码"：直接把 Strapi 换成 MoonBit 就能用，不需要猜类名。
//
// 两个坑都踩过，这里规避掉：
//   1) 一次返回 80KB+ 会报 "Script failed to execute"（超 IPC 限制）→ 先缓存到 window 再分片取
//   2) Node 模板串里的 '\n' 到了渲染进程会变成真换行、把 JS 字面量写坏 → 用 String.fromCharCode(10)
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const BASE = 'http://localhost:1337'
const EMAIL = 'admin@moonbit.dev'
const PASS = 'Moonbit@2026'
const OUT = path.join(__dirname, 'strapi-ui')
const CHUNK = 40000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getToken() {
  const res = await fetch(BASE + '/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  const j = await res.json()
  return j.data && j.data.token
}

app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const token = await getToken()
  const win = new BrowserWindow({
    width: 1680, height: 1000, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
  })
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const grab = async (expr) => {
    const len = await js(`${expr}.length`)
    let out = ''
    for (let i = 0; i < len; i += CHUNK) {
      out += await js(`${expr}.slice(${i}, ${Math.min(i + CHUNK, len)})`)
    }
    return out
  }

  await win.loadURL(BASE + '/admin')
  await sleep(6000)
  // dark / light 各导出一次：Strapi 的 CSS 里颜色是编译后的字面量，
  // 所以浅色主题必须重新导出，不能靠改变量。
  for (const theme of ['dark', 'light']) {
    console.log(`\n===== 导出 ${theme} 主题 =====`)
    await js(`localStorage.setItem('jwtToken', JSON.stringify(${JSON.stringify(token)})); localStorage.setItem('isLoggedIn','true'); localStorage.setItem('STRAPI_THEME','${theme}');`)
    await win.loadURL(BASE + '/admin')
    await sleep(14000)
    console.log('元素数:', await js('document.querySelectorAll("*").length'))
    console.log('body 背景:', await js('getComputedStyle(document.body).backgroundColor'))

    await js(`window.__html = document.documentElement.outerHTML`)
    await js(`window.__css = Array.from(document.styleSheets).map(function(s){ try { return Array.from(s.cssRules).map(function(r){ return r.cssText }).join(String.fromCharCode(10)) } catch(e){ return '' } }).join(String.fromCharCode(10))`)
    const lenHtml = await js('window.__html.length')
    const lenCss = await js('window.__css.length')
    console.log('  HTML', lenHtml, ' CSS', lenCss)

    const html = await grab('window.__html')
    const css = await grab('window.__css')
    fs.writeFileSync(path.join(OUT, `page-source-${theme}.html`), html, 'utf8')
    fs.writeFileSync(path.join(OUT, `page-runtime-${theme}.css`), css, 'utf8')
    console.log(`  → page-source-${theme}.html ${(fs.statSync(path.join(OUT, `page-source-${theme}.html`)).size/1024).toFixed(1)}KB`
      + `  page-runtime-${theme}.css ${(fs.statSync(path.join(OUT, `page-runtime-${theme}.css`)).size/1024).toFixed(1)}KB`)
  }

  // 两套 CSS 的选择器集合是否一致 —— 决定能否「只换样式表」
  console.log('\n===== 对比两套 CSS 的选择器集合 =====')
  const selOf = (f) => new Set((fs.readFileSync(path.join(OUT, f), 'utf8').match(/\.[a-zA-Z_][\w-]{5,}/g) || []))
  const d = selOf('page-runtime-dark.css')
  const l = selOf('page-runtime-light.css')
  const common = [...d].filter((x) => l.has(x))
  console.log(`  dark 类名 ${d.size} 个，light 类名 ${l.size} 个，交集 ${common.length} 个`)
  console.log(`  dark 独有 ${d.size - common.length}，light 独有 ${l.size - common.length}`)
  console.log(`  → 交集占比 ${((common.length / Math.max(d.size, l.size)) * 100).toFixed(0)}%`)
  console.log('\n导出目录:', OUT)
  app.quit()
})
