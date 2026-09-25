// P20-04 端到端：面板入口挂在顶栏标签里（动态注入，不改 index.html 产物）
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const OUT = path.join(__dirname, 'panel-entry-result.txt')
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

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await sleep(250) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  const P = async (expr) => JSON.parse(await js(`(async () => JSON.stringify(${expr}))()`))
  await sleep(3500)

  log('\n=== ① 面板按钮被注入到顶栏 ===')
  chk('★ #navPanels 存在（顶栏里多了个入口）', await js(`!!document.getElementById('navPanels')`), true)
  const txt = await js(`(document.getElementById('navPanels') || {}).textContent || ''`)
  chk('  文案是「面板」', /面板/.test(String(txt)), String(txt))
  chk('  带 aria-label（可访问）', await js(`(document.getElementById('navPanels')||{}).getAttribute('aria-label')`) === '面板', true)
  chk('  它是标签栏里的一个 <li>（跟其它标签同级）', await js(`!!document.getElementById('navPanels').closest('li')`), true)

  log('\n=== ② ★ 它不会被当成第 6 个视图 ===')
  eq('★ 去掉了 data-view（否则切视图逻辑会误判）', await js(`(document.getElementById('navPanels')||{}).getAttribute('data-view')`), null)
  const views = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('a[data-view]')).map((a) => a.getAttribute('data-view')))`))
  eq('★ 视图仍是原来那 5 个', views, ['home', 'project', 'agent', 'ai', 'tools'])

  log('\n=== ③ 点它 → 打开面板菜单 ===')
  await js(`(() => { const a = document.getElementById('navPanels'); if (a) a.click() })()`)
  await sleep(900)
  chk('★ 面板菜单打开了', await js(`!!document.getElementById('panelMenu')`), true)
  const items = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('#panelMenu button')).map((b) => b.textContent))`))
  chk('  里面列着 7 个面板', items.filter((t) => t !== '关闭').length === 7, JSON.stringify(items))
  await js(`(() => { const b = Array.from(document.querySelectorAll('#panelMenu button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(400)
  chk('  可以关掉', await js(`!document.getElementById('panelMenu')`), true)

  log('\n=== ④ ★ 点它**不会**切走当前视图（它只是打开面板）===')
  const before = await js(`document.body.getAttribute('data-view') || 'home'`)
  await js(`(() => { const a = document.getElementById('navPanels'); if (a) a.click() })()`)
  await sleep(700)
  const after = await js(`document.body.getAttribute('data-view') || 'home'`)
  eq('★ 当前视图没变', after, before)
  await js(`(() => { const b = Array.from(document.querySelectorAll('#panelMenu button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(300)

  log('\n=== ⑤ 其它标签仍然正常（没被我们弄坏）===')
  for (const v of ['project', 'ai', 'tools', 'home']) {
    const ok = await js(`(() => {
      const a = document.querySelector('a[data-view="${v}"]')
      if (!a) return 'missing'
      a.click()
      return document.body.getAttribute('data-view') || ''
    })()`)
    eq('点「' + v + '」能切过去', ok, v)
    await sleep(300)
  }

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
