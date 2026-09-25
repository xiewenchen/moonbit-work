// 验证 1.5 新建项目 + 2.7 保存时格式化（全在临时目录，不动用户项目）
const path = require('path'), fs = require('fs'), os = require('os')
require('./main.js')
const { app, BrowserWindow } = require('electron')

const TMP = path.join(os.tmpdir(), 'moonbit-ide-e2e-' + Date.now())

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await new Promise(r=>setTimeout(r,250)) }
  await new Promise(r=>setTimeout(r,6000))
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const q = async (l, c) => console.log(`  ${l}: ${String(await js(c)).slice(0,170)}`)

  console.log('════ 1.5 新建 MoonBit 项目 ════')
  console.log('  目标:', TMP)
  await q('调 newProject', `window.moonAPI.newProject(${JSON.stringify(TMP)}).then(r=>JSON.stringify({ok:r.ok,code:r.code,err:(r.stderr||'').slice(0,80)}))`)
  await new Promise(r=>setTimeout(r,1500))
  const exists = fs.existsSync(TMP)
  console.log('  目录已创建:', exists)
  if (exists) {
    const entries = fs.readdirSync(TMP)
    console.log('  生成内容:', entries.join(', '))
    const hasModJson = entries.some(e => e.startsWith('moon.mod'))
    const hasSrc = entries.some(e => e.endsWith('.mbt'))
    console.log('  有 moon.mod*:', hasModJson, ' 有 .mbt 源文件:', hasSrc)
  }

  console.log('\n════ 2.7 保存时格式化（moon fmt）════')
  // 在新建的项目里制造一个缩进混乱的文件
  if (exists) {
    const srcFile = fs.readdirSync(TMP).find(e => e.endsWith('.mbt'))
    if (srcFile) {
      const full = path.join(TMP, srcFile)
      const messy = 'pub fn add(a : Int, b : Int) -> Int {                return a + b\n}\n'
      fs.writeFileSync(full, messy, 'utf8')
      console.log('  写入未格式化内容（多余空格）:', JSON.stringify(messy.split('\n')[0].slice(0, 70)))
      // 走真实的格式化 IPC
      const r = await js(`window.moonAPI.formatFile(${JSON.stringify(TMP)}, ${JSON.stringify(full)}).then(r=>JSON.stringify({ok:r.ok,code:r.code,err:(r.stderr||'').slice(0,100)}))`)
      console.log('  moon fmt 结果:', String(r))
      const after = fs.readFileSync(full, 'utf8')
      console.log('  格式化后第一行:', JSON.stringify(after.split('\n')[0].slice(0, 70)))
      const changed = after !== messy
      console.log('  内容是否被格式化:', changed ? '✅ 是' : '❌ 否')
    }
  }

  console.log('\n════ 命令面板是否已含新命令 ════')
  await q('命令数', "commands().length")
  await q('命令列表', "commands().map(c=>c.label).join(' | ')")

  // 清理
  try { fs.rmSync(TMP, { recursive: true, force: true }); console.log('\n  已清理临时目录') } catch (_) {}
  app.quit()
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
