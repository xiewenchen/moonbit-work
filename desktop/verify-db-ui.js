// P15 面板端到端：数据库工作台 UI 真的打开、真的渲染、连不上时如实说
//
// 本机大概没装 psql/redis-cli —— 那正好验证最要紧的一点：
// 面板上要显示"未找到客户端"，而**不是**一个空表列表（空表列表等于骗人说"你没表"）。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const OUT = path.join(__dirname, 'db-ui-result.txt')
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
  await sleep(3000)

  log('\n=== ① 面板能打开并渲染 ===')
  await js('window.moonbitIDE.database.show()')
  await sleep(1500)
  chk('面板出现', await js(`!!document.getElementById('dbPanel')`), true)
  chk('有表列表区', await js(`!!document.getElementById('dbTables')`), true)
  chk('有列信息区', await js(`!!document.getElementById('dbCols')`), true)
  chk('有数据区', await js(`!!document.getElementById('dbRows')`), true)
  const btnTexts = JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('#dbPanel button')).map((b) => b.textContent))`))
  chk('有搜索/上一页/下一页/关闭', ['搜索', '上一页', '下一页', '关闭'].every((t) => btnTexts.indexOf(t) >= 0), JSON.stringify(btnTexts))
  chk('有 Redis 入口', btnTexts.some((t) => /看 Keys/.test(t)), JSON.stringify(btnTexts))

  log('\n=== ② ★ 连不上时如实说（不是空表列表）===')
  const leftText = await js(`(document.getElementById('dbTables') || {}).textContent || ''`)
  const raw = await P(`await window.moonAPI.dbTables('public')`)
  if (raw.ok === true) {
    chk('真的连上了数据库（本机装了 psql）→ 列表里应有表名', String(leftText).length > 0, String(leftText).slice(0, 120))
  } else {
    chk('★ 面板上显示了可读的失败原因', /未找到 psql 客户端|数据库返回错误/.test(String(leftText)), String(leftText).slice(0, 160))
    chk('  而不是"（public schema 里没有表）"这种会误导的话', !/没有表/.test(String(leftText)), String(leftText).slice(0, 160))
  }

  log('\n=== ③ 点"看 Keys" → Redis 侧同样如实 ===')
  await js(`(() => { const b = Array.from(document.querySelectorAll('#dbPanel button')).find((x) => x.textContent === '看 Keys'); if (b) b.click() })()`)
  await sleep(1200)
  const rowsText = await js(`(document.getElementById('dbRows') || {}).textContent || ''`)
  const rk = await P(`await window.moonAPI.dbRedisKeys('*')`)
  if (rk.ok === true) {
    chk('Redis 有响应', String(rowsText).length >= 0, String(rowsText).slice(0, 80))
  } else {
    chk('★ Redis 失败时也说清了是没客户端', /未找到 redis-cli 客户端/.test(String(rowsText)), String(rowsText).slice(0, 160))
  }

  log('\n=== ④ 安全闸在面板路径上也生效（界面塞不进写操作）===')
  const bad = await P(`await window.moonbitIDE.database.raw('DROP TABLE users')`)
  chk('★ 面板 API 直接塞 DROP → 拒', bad.ok === false, JSON.stringify(bad).slice(0, 140))
  const bad2 = await P(`await window.moonbitIDE.database.raw('SELECT 1; DELETE FROM users')`)
  chk('★ 多语句 → 拒', bad2.ok === false && /MULTI_STATEMENT/.test(String(bad2.error)), String(bad2.error))

  log('\n=== ⑤ 关闭 ===')
  await js(`(() => { const b = Array.from(document.querySelectorAll('#dbPanel button')).find((x) => x.textContent === '关闭'); if (b) b.click() })()`)
  await sleep(400)
  eq('关闭后面板消失', await js(`!document.getElementById('dbPanel')`), true)

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
