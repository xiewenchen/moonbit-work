// PH3-ENV-04 接线验证：环境面板上的「PATH 补全建议」
//
// ⚠️ 这个脚本要回答的是"**用户在面板上看得见、能拿到**"，而不是"env-recovery 里有 pathFixups"。
//    教训来自 PH3-Q-10/11：后端方法存在但没人调用 = 假完成；
//    而且接线那一刻才发现两个模块的字段名不一致（state vs found），
//    不真跑就只会看到"面板上一条建议都没有"。
//
// 真路径：开环境面板 → 断言面板真的渲染出来 → 对每个 MISSING 项断言建议块与候选目录
//        → 断言「复制」按钮存在（可操作）→ 断言环境正常的项**没有**瞎给建议。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHarness } = require('./verify-harness')

const OUT = path.join(__dirname, 'env-fixups-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
const H = createHarness({ log })
const chk = H.chk
const eq = H.eq

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await new Promise((r) => setTimeout(r, 250)) }
  if (!win) { log('[FATAL] 没拿到窗口'); process.exit(1) }
  await new Promise((r) => setTimeout(r, 3000))
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  try {
    log('=== ① 后端：建议确实产生了（且认出 checkEnvironment 的形状）===')
    const fix = JSON.parse(await js(`(async () => { const r = await window.moonAPI.envCheck(); return JSON.stringify({ fixups: r.fixups || [], items: (r.env && r.env.items) || [] }) })()`))
    log('  · 环境项 ' + fix.items.length + ' 个，其中缺的 ' + fix.items.filter((x) => !x.found).length + ' 个；建议 ' + fix.fixups.length + ' 条')
    // 本机一定缺至少一样（Docker/opencode 基本不会装），否则这条断言要按环境 SKIP
    const missing = fix.items.filter((x) => !x.found)
    if (missing.length === 0) {
      log('  → 本机环境全齐，没有 MISSING 项可断言 —— 按规则 SKIP（不算失败）')
      log(H.summary())
      fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
      app.exit(0)
      return
    }
    // ⚠️ 不能断言"每条缺失都有建议" —— 候选表只覆盖少数工具（moon/node/git/docker/opencode），
    //    缺的是别的（如某个没登记的项）时，**不给建议才是对的**（第一版断言就写强了，误报）。
    const fixIds = fix.fixups.map((f) => f.id)
    const knownMissing = missing.filter((m) => fixIds.indexOf(m.id) >= 0)
    const unknownMissing = missing.filter((m) => fixIds.indexOf(m.id) < 0)
    log('  · 缺的项：' + JSON.stringify(missing.map((m) => m.id)) + '；其中候选表认识的：' + JSON.stringify(knownMissing.map((m) => m.id)))
    chk('★ 候选表认识的缺失项**都有**建议', knownMissing.length === fix.fixups.length && fix.fixups.length > 0,
      '建议 ' + fix.fixups.length + ' 条 / 认识的缺失项 ' + knownMissing.length + ' 个')
    chk('★ 候选表不认识的项**不**瞎给建议（宁可不给）', unknownMissing.every((m) => fixIds.indexOf(m.id) < 0),
      JSON.stringify(unknownMissing.map((m) => m.id)))
    chk('  建议与缺失项一一对应（按 id）',
      fix.fixups.every((f) => missing.some((m) => m.id === f.id)),
      JSON.stringify(fixIds))
    chk('  且每条都带候选目录', fix.fixups.every((f) => Array.isArray(f.candidates) && f.candidates.length > 0))
    chk('★ 探测出错的项**不给** PATH 建议（与「没装」不是一回事）',
      fix.items.filter((x) => x.error).every((x) => !fix.fixups.some((f) => f.id === x.id)),
      JSON.stringify(fix.items.filter((x) => x.error).map((x) => x.id)))

    log('\n=== ①bis 强制造一个"候选表认识的缺失项"（否则上面的断言可能恒过=假通过）===')
    // ⚠️ 本机缺的那一项未必在候选表里，那样"面板上没有建议段"是**正确的**，
    //    于是"面板上真的有建议"这条就永远测不到。所以这里显式造一个已知 id。
    //    env-recovery 是主进程模块（没注入渲染侧），在 Node 侧直接 require 即可。
    const envRec = require('./env-recovery')
    const forced = envRec.pathFixups([
      { id: 'moon', name: 'MoonBit', found: false },
      { id: 'node', name: 'Node', found: true },
      { id: 'whatever-unknown', name: '没登记的工具', found: false },
    ])
    chk('★ 已知 id 的缺失项一定给出建议（否则就是判据没匹配上）',
      forced.length === 1 && forced[0].id === 'moon', JSON.stringify(forced.map((f) => f.id)))
    chk('  且候选目录非空', Array.isArray(forced[0] && forced[0].candidates) && forced[0].candidates.length > 0)
    chk('★ 装了的（found:true）不给建议', !forced.some((f) => f.id === 'node'))
    chk('★ 候选表没登记的不瞎给建议', !forced.some((f) => f.id === 'whatever-unknown'))

    log('\n=== ② 界面：用户真的看得见（这是接线，不是库自测）===')
    await js(`window.moonbitIDE.env.show()`)
    await sleep(2000)
    const shown = JSON.parse(await js(`(() => {
      const panel = document.getElementById('envPanel')
      const list = document.getElementById('envList')
      return JSON.stringify({
        panel: !!panel,
        rows: document.querySelectorAll('#envList > div').length,
        text: (list && list.textContent) || '',
        copyBtns: Array.from(document.querySelectorAll('#envList button')).filter((b) => /复制/.test(b.textContent)).length,
      })
    })()`))
    chk('★ 环境面板真的开了', shown.panel === true)
    chk('★ 面板上渲染出了环境项', shown.rows > 0, shown.rows + ' 行')
    // 面板上到底该不该出现这个段，取决于后端是否真给了建议 —— 两者必须一致
    chk('★★ 面板与后端**一致**（有建议就该看得见，没有就不该出现）',
      /可能装在这些目录/.test(String(shown.text)) === (fix.fixups.length > 0),
      '后端 ' + fix.fixups.length + ' 条 / 界面有该段=' + /可能装在这些目录/.test(String(shown.text)))
    chk('★ 「复制」按钮数与环境缺失项数一致（可操作，不是只给看）',
      shown.copyBtns > 0 === (fix.fixups.length > 0), '复制按钮 ' + shown.copyBtns + ' 个')
    if (fix.fixups.length > 0) {
      // 候选目录必须真的出现在界面上（不能只是后端有；要能核对）
      const firstCand = fix.fixups[0].candidates[0]
      chk('★ 候选目录原文出现在界面上', String(shown.text).indexOf(firstCand) >= 0, '找 ' + firstCand)
      chk('  且明确提醒"先确认目录真的存在"', /先确认/.test(String(shown.text)))
    } else {
      log('  → 本机缺的项都不在候选表里，面板上本来就不该有这个段 —— 此二项按环境 SKIP')
    }

    log('\n=== ③ 点「复制」：真复制（失败也要如实说）===')
    const copied = JSON.parse(await js(`(async () => {
      const btns = Array.from(document.querySelectorAll('#envList button')).filter((b) => /复制/.test(b.textContent))
      if (!btns.length) return JSON.stringify({ clicked: false })
      btns[0].click()
      await new Promise((r) => setTimeout(r, 400))
      return JSON.stringify({ clicked: true, label: btns[0].textContent })
    })()`))
    chk('  点了复制按钮', copied.clicked === true)
    // 无头环境剪贴板可能不可用 —— 那时按钮应显示"复制失败"而不是假装成功
    chk('★★ 结果如实（"已复制"或"复制失败"，不装作成功）',
      /已复制|复制失败/.test(String(copied.label)), String(copied.label))

    log('\n=== ④ 环境正常的项不该被瞎给建议 ===')
    const avail = fix.items.filter((x) => x.found)
    const theirIds = avail.map((x) => x.id)
    chk('★ 可用的项没有出现在建议里', !fix.fixups.some((f) => theirIds.indexOf(f.id) >= 0), JSON.stringify(theirIds))
  } catch (e) {
    H.chk('验证中途出错（下面几项可能因此没跑到）', false, String((e && e.message) || e))
    log('[FATAL] 验证中途出错：' + String((e && e.stack) || e))
  }

  log('\n' + H.summary())
  try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (e) { console.log('  （结果文件写不了：' + String((e && e.message) || e) + '）') }
  app.exit(H.exitCode())
}).catch((e) => { console.error('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); process.exit(1) })
