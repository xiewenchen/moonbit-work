// P15-01～06 端到端：数据库工作台的接线 + 安全闸在 IPC 层也生效
//
// 这台机器上很可能没装 psql / redis-cli —— 那正好验证另一件事：
// **跑不动时必须如实说"未找到客户端"，而不是返回一个空结果集**
// （空结果会被误读成"这张表是空的"）。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const OUT = path.join(__dirname, 'db-explorer-result.txt')
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

  log('\n=== ① ★ 安全闸在 IPC 层也生效（界面塞进来的 SQL 也要过闸）===')
  {
    const multi = await P(`await window.moonAPI.dbRaw('SELECT 1; DROP TABLE users')`)
    chk('★ 多语句 → 拒（没到数据库）', multi.ok === false, JSON.stringify(multi).slice(0, 160))
    chk('  原因码是 MULTI_STATEMENT', /MULTI_STATEMENT/.test(String(multi.error)), String(multi.error))

    const del = await P(`await window.moonAPI.dbRaw('DELETE FROM users')`)
    chk('★ 写操作 → 拒', del.ok === false && /只允许 SELECT/.test(String(del.error)), String(del.error))

    const drop = await P(`await window.moonAPI.dbRaw('DROP TABLE users')`)
    chk('★ DROP → 拒', drop.ok === false, String(drop.error))

    const fn = await P(`await window.moonAPI.dbRaw("SELECT pg_read_file('/etc/passwd')")`)
    chk('★ 危险函数 → 拒', fn.ok === false && /FORBIDDEN_FUNCTION/.test(String(fn.error)), String(fn.error))

    const col = await P(`await window.moonAPI.dbColumns('users; DROP TABLE x')`)
    chk('★ 非法表名 → 拒（构造层就抛）', col.ok === false, JSON.stringify(col).slice(0, 140))
  }

  log('\n=== ② Redis 同样过闸 ===')
  {
    const flush = await P(`await window.moonAPI.dbRedisKeys('*')`)
    chk('SCAN 本身是允许的（要么有结果，要么如实报没客户端）', flush.ok === true || /未找到 redis-cli/.test(String(flush.error)), JSON.stringify(flush).slice(0, 140))
    // 直接塞一个写命令进去（走 redisValue 的 key 不是命令，这里用 raw 路径不存在 → 用 keys 的 pattern 无法注入命令）
    const val = await P(`await window.moonAPI.dbRedisValue('some:key')`)
    chk('读值要么成功、要么如实报没客户端', val.ok === true || /未找到 redis-cli/.test(String(val.error)), JSON.stringify(val).slice(0, 140))
  }

  log('\n=== ③ ★ 跑不动就如实说（不能返回空结果）===')
  {
    const t = await P(`await window.moonAPI.dbTables('public')`)
    if (t.ok === true) {
      chk('真的连上了数据库（本机装了 psql）', Array.isArray(t.rows), JSON.stringify(t).slice(0, 120))
    } else {
      chk('★ 没连上时给出可读原因（而不是空 rows）', /未找到 psql 客户端|数据库返回错误/.test(String(t.error)), String(t.error).slice(0, 160))
      chk('  并且明确不是"表是空的"', t.rows === undefined, JSON.stringify(t.rows))
    }
    const k = await P(`await window.moonAPI.dbRedisKeys('*')`)
    if (k.ok !== true) {
      chk('★ Redis 同理：说清是没客户端，不是"没有 key"', /未找到 redis-cli 客户端/.test(String(k.error)), String(k.error).slice(0, 140))
    }
  }

  log('\n=== ④ 合法查询能过闸（失败也应只失败在"没客户端"）===')
  {
    const ok = await P(`await window.moonAPI.dbRaw('SELECT 1')`)
    chk('合法 SELECT 过了闸', ok.ok === true || /未找到 psql 客户端/.test(String(ok.error)), JSON.stringify(ok).slice(0, 140))
    const pag = await P(`await window.moonAPI.dbQuery(${JSON.stringify({ table: 'users', limit: 5, offset: 10 })})`)
    chk('分页查询过了闸', pag.ok === true || /未找到 psql 客户端|数据库返回错误/.test(String(pag.error)), JSON.stringify(pag).slice(0, 140))
    const sea = await P(`await window.moonAPI.dbQuery(${JSON.stringify({ mode: 'search', table: 'users', term: "a' OR 1=1 --", columns: ['name'] })})`)
    chk('★ 搜索词里的注入串被转义后过闸（不是被拒也不是注入）', sea.ok === true || /未找到 psql 客户端|数据库返回错误/.test(String(sea.error)), JSON.stringify(sea).slice(0, 140))
  }

  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { log('\n[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
