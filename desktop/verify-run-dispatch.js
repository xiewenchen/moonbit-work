// 验证顶栏按钮**按项目类型分派**（真点击 + 真断言）。
//
// 用户手点过的坑：打开 Node 项目（strapi-backend）点「跑测试」，
// 输出里却是 `moon test` 报 "not in a Moon project" —— 因为按钮硬编码了 runMoon。
//
// 断言是**行为**：真点按钮 → 看**实际跑的什么命令、输出里是什么**。
//   在 Node 项目里点「跑测试」→ 必须跑 npm 脚本（输出 NPM_TEST_RAN），且不能出现 moon 的报错
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const OUT = path.join(__dirname, 'run-dispatch-result.txt')
// P19-17：断言统一走公共 harness（消灭这份脚本里的局部 chk 定义）
const { createHarness } = require('./verify-harness')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
function dump(code) { try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (_) {} ; setTimeout(() => app.exit(code), 500) }

// P19-17：不再自定义 chk —— 类型闸与计数都由 verify-harness 统一提供
const H = createHarness({ log })
const chk = H.chk

app.whenReady().then(async () => {
  // 造一个临时 Node 项目：它的 test 脚本会打印一个**只有 npm 跑才会出现**的标记
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'run-dispatch-'))
  fs.writeFileSync(path.join(TMP, 'package.json'), JSON.stringify({
    name: 'dispatch-probe',
    scripts: { test: 'node -e "console.log(\'NPM_TEST_RAN\')"' },
  }, null, 2))

  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await new Promise((r) => setTimeout(r, 250)) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  await new Promise((r) => setTimeout(r, 3000))

  log('\n=== ① 把工作目录指向一个 Node 项目，然后**真点「跑测试」** ===')
  const res = JSON.parse(await js(`(async () => {
    document.getElementById('cwd').value = ${JSON.stringify(TMP)}
    const btn = document.querySelector('button[data-cmd="test"]')
    if (!btn) return JSON.stringify({ err: 'no-test-button' })
    const out = document.getElementById('output')
    if (out) out.textContent = ''
    btn.click()
    await new Promise((r) => setTimeout(r, 12000))   // 等 npm 真正跑完
    return JSON.stringify({ text: (out ? out.textContent : '').slice(0, 1200) })
  })()`))
  if (res.err) { log('  ' + res.err); log('\n' + H.summary()); return dump(1) }
  log('   输出片段：' + JSON.stringify(res.text.replace(/\s+/g, ' ').slice(0, 220)))

  // 行为断言：跑的是 npm 脚本（出现标记），而不是 moon
  chk('在 Node 项目里点「跑测试」→ 真的跑了 npm 脚本', /NPM_TEST_RAN/.test(res.text), res.text.slice(0, 200))
  chk('  且**没有**出现 moon 的 "not in a Moon project" 报错', !/not in a Moon project/i.test(res.text), res.text.slice(0, 200))
  chk('  也没有 `moon test` 这行命令', !/\$ moon test/i.test(res.text), res.text.slice(0, 200))

  log('\n=== ② 反过来：MoonBit 项目里点「跑测试」应走 moon ===')
  const root = path.resolve(__dirname, '..')
  const res2 = JSON.parse(await js(`(async () => {
    document.getElementById('cwd').value = ${JSON.stringify(root)}
    const btn = document.querySelector('button[data-cmd="test"]')
    const out = document.getElementById('output')
    if (out) out.textContent = ''
    btn.click()
    await new Promise((r) => setTimeout(r, 25000))   // moon test 较慢，等久一点
    return JSON.stringify({ text: (out ? out.textContent : '').slice(0, 1500) })
  })()`))
  log('   输出片段：' + JSON.stringify(res2.text.replace(/\s+/g, ' ').slice(0, 220)))
  chk('在 MoonBit 项目里点「跑测试」→ 走的是 moon（不含 npm 相关行）', /moon/i.test(res2.text) && !/npm test/i.test(res2.text), res2.text.slice(0, 200))
  chk('  npm 项目的标记没有串到这里', !/NPM_TEST_RAN/.test(res2.text), res2.text.slice(0, 120))

  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_) {}
  log('\n' + H.summary())
  dump(H.exitCode())
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
