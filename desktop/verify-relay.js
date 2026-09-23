// 文件中转站验证（WPS 风格布局）：
//   标签名/图标 · 左分类+计数 · 顶工具条 · 宫格/列表双视图 · 搜索 · 排序
//   · 悬浮/右键操作 · 版本历史 · 真实还原 · 固定监控（下载/桌面 不可移除）
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DOC = path.resolve('.relay-test/年度总结.docx')
const TXT = path.resolve('.relay-test/备注.txt')
const J = JSON.stringify

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await sleep(250) }
  if (win) { win.show(); win.focus() }
  await sleep(9000)
  const js = (c) => win.webContents.executeJavaScript(c, true)
  const SHOT = path.join(__dirname, 'e2e-shots', 'relay')
  fs.mkdirSync(SHOT, { recursive: true })
  const safeShot = async (n) => { try { fs.writeFileSync(path.join(SHOT, n), (await win.webContents.capturePage()).toPNG()); console.log('  截图 ' + n) } catch (e) { console.log('  截图失败: ' + n) } }

  let pass = 0, fail = 0
  const chk = (n, ok, d) => { if (ok) { pass++; console.log(`  [PASS] ${n}`) } else { fail++; console.log(`  [FAIL] ${n}  ${d || ''}`) } }

  try { fs.rmSync(path.join(os.homedir(), '.moonbit-backups', crypto.createHash('sha1').update(DOC).digest('hex').slice(0, 16)), { recursive: true, force: true }) } catch (_) {}

  console.log('=== ① 标签 ===')
  const t = JSON.parse(await js(`(() => {
    const a = document.querySelector('a[data-view="agent"]')
    const all = Array.from(document.querySelectorAll('a[data-view]'))
    return JSON.stringify({
      text: a ? a.textContent.trim() : '',
      icons: all.map((x) => { const s = x.querySelector('svg'); return s ? s.innerHTML.length : 0 }),
    })
  })()`))
  chk('第三个标签名为「文件中转站」', t.text === '文件中转站', t.text)
  chk('每个标签的图标都不一样', new Set(t.icons).size === t.icons.length, J(t.icons))

  console.log('\n=== ② WPS 式布局：左分类 + 工具条 ===')
  await js(`(() => { const a = document.querySelector('a[data-view="agent"]'); if (a) a.click() })()`)
  await sleep(1800)
  const ui = JSON.parse(await js(`(() => {
    const navs = Array.from(document.querySelectorAll('.fm-nav')).map((n) => n.dataset.cat + '|' + n.querySelector('.n').textContent)
    return JSON.stringify({
      visible: getComputedStyle(document.getElementById('mainview-agent')).display !== 'none',
      hasSide: !!document.querySelector('.fm-side'),
      navs,
      hasSearch: !!document.getElementById('fmSearch'),
      hasViewBtn: !!document.getElementById('fmViewGrid') && !!document.getElementById('fmViewList'),
      hasCols: !!document.getElementById('fmCols'),
      emojiLeft: (document.body.textContent.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2800}-\u{28FF}\u{25A0}-\u{25FF}]/gu) || []).length,
      svgIcons: document.querySelectorAll('svg').length,
      hasSortBtn: !!document.getElementById('fmSort'),
      hasCrumb: (document.getElementById('fmCrumb') || {}).textContent || '',
      listClass: (document.getElementById('fmList') || {}).className || '',
      root: (document.getElementById('relayRoot') || {}).textContent || '',
    })
  })()`))
  console.log('  ', J(ui))
  chk('中转站界面可见', ui.visible === true)
  chk('有左侧分类栏', ui.hasSide === true)
  chk('分类含 最近/桌面/下载/其他/已备份', ['recent', 'desktop', 'downloads', 'other', 'backed'].every((c) => ui.navs.some((x) => x.startsWith(c + '|'))), J(ui.navs))
  chk('每条分类带计数', ui.navs.every((x) => x.split('|')[1] !== undefined), J(ui.navs))
  chk('顶栏有搜索 / 视图切换', ui.hasSearch && ui.hasViewBtn)
  chk('页面文本里没有 emoji/字符图标', ui.emojiLeft === 0, String(ui.emojiLeft) + ' 个')
  chk('图标是内联 SVG（不是 emoji）', ui.svgIcons >= 10, String(ui.svgIcons))
  chk('面包屑显示当前分类', ui.hasCrumb === '最近', ui.hasCrumb)
  chk('默认是宫格视图', /grid/.test(ui.listClass), ui.listClass)
  chk('显示备份目录', ui.root.includes('.moonbit-backups'), ui.root)

  console.log('\n=== ③ 文件列表 + 宫格/列表切换 ===')
  const grid = JSON.parse(await js(`(async () => {
    await window.moonAPI.relayTouch(${J(DOC)})
    await window.moonAPI.relayTouch(${J(TXT)})
    window.moonbitRelay.refresh()
    await new Promise(r => setTimeout(r, 2200))
    const cards = Array.from(document.querySelectorAll('#fmList .fm-card'))
    return JSON.stringify({
      count: cards.length,
      names: cards.map((c) => c.querySelector('.nm').textContent),
      hasIco: cards.every((c) => !!c.querySelector('.ico')),
      hasOps: cards.every((c) => !!c.querySelector('.ops button')),
      gridCols: getComputedStyle(document.getElementById('fmList')).gridTemplateColumns.split(' ').length,
    })
  })()`))
  console.log('  ', J(grid))
  chk('宫格视图渲染出卡片', grid.count >= 2, String(grid.count))
  chk('每张卡有图标 / 名称 / 操作按钮', grid.hasIco && grid.hasOps)
  chk('宫格是多列排布', grid.gridCols >= 2, String(grid.gridCols))

  const listView = JSON.parse(await js(`(async () => {
    document.getElementById('fmViewList').click()
    await new Promise(r => setTimeout(r, 900))
    const rows = Array.from(document.querySelectorAll('#fmList .fm-row'))
    const cols = document.getElementById('fmCols')
    return JSON.stringify({
      cls: document.getElementById('fmList').className,
      rows: rows.length,
      hasTime: rows.every((r) => !!r.querySelector('.ms')),
      hasSize: rows.every((r) => !!r.querySelector('.sz')),
      colsShown: cols ? !cols.hidden : false,
      colButtons: cols ? Array.from(cols.querySelectorAll('button')).map((b) => b.dataset.sort) : [],
    })
  })()`))
  console.log('  ', J(listView))
  chk('能切到列表视图', /list/.test(listView.cls), listView.cls)
  chk('列表行显示 名称/时间/大小', listView.rows >= 2 && listView.hasTime && listView.hasSize, J(listView))
  chk('列表视图显示列头（可排序）', listView.colsShown === true && listView.colButtons.length === 3, J(listView.colButtons))
  await safeShot('fm-list-view.png')

  console.log('\n=== ④ 搜索 + 排序 ===')
  const search = JSON.parse(await js(`(async () => {
    document.getElementById('fmViewGrid').click()          // 切回宫格
    await new Promise(r => setTimeout(r, 500))
    const s = document.getElementById('fmSearch')
    s.value = '年度'
    s.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 900))
    const names = Array.from(document.querySelectorAll('#fmList .fm-card .nm')).map((x) => x.textContent)
    const crumb = document.getElementById('fmCrumb').textContent
    s.value = ''
    s.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 900))
    return JSON.stringify({ names, crumb, afterClear: document.querySelectorAll('#fmList .fm-card').length })
  })()`))
  console.log('  ', J(search))
  chk('搜索能过滤出目标文件', search.names.length === 1 && search.names[0].includes('年度'), J(search.names))
  chk('面包屑反映搜索状态', search.crumb.includes('搜索'), search.crumb)
  chk('清空搜索后恢复全部', search.afterClear >= 2, String(search.afterClear))

  console.log('\n=== ⑤ 右键菜单 ===')
  const ctx = JSON.parse(await js(`(async () => {
    const card = document.querySelector('#fmList .fm-card')
    const r = card.getBoundingClientRect()
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 20) }))
    await new Promise(r2 => setTimeout(r2, 500))
    const m = document.getElementById('fmCtx')
    return JSON.stringify({
      shown: !!m,
      items: m ? Array.from(m.querySelectorAll('button')).map((b) => b.textContent) : [],
      header: m ? (m.querySelector('.hdr') || {}).textContent : '',
    })
  })()`))
  console.log('  ', J(ctx))
  chk('右键弹出菜单', ctx.shown === true)
  chk('菜单含「备份当前内容」', ctx.items.some((x) => x.includes('备份')), J(ctx.items))
  chk('菜单含「查看历史版本」', ctx.items.some((x) => x.includes('历史版本')), J(ctx.items))
  chk('菜单标出文件名', !!ctx.header, ctx.header)
  await js(`(() => { const m = document.getElementById('fmCtx'); if (m) m.remove() })()`)

  console.log('\n=== ⑥ 备份 → 已备份分类 → 版本历史 ===')
  const backup = JSON.parse(await js(`(async () => {
    try {
      // 明确操作**我们的测试文件**，不要依赖「列表第一个」——
      // 桌面上其它文件的 mtime 可能更新（用户随时会新增文件），会排到第一。
      const cards = Array.from(document.querySelectorAll('#fmList .fm-card'))
      const mine = cards.find((c) => ((c.querySelector('.nm') || {}).textContent || '') === '年度总结.docx')
      if (!mine) return JSON.stringify({ err: 'test-file-not-in-list', names: cards.map((c) => (c.querySelector('.nm') || {}).textContent) })
      const btn = mine.querySelector('.ops button')
      if (!btn) return JSON.stringify({ err: 'no-op-button', html: mine.innerHTML.slice(0, 200) })
      btn.click()
      await new Promise(r => setTimeout(r, 2200))
      // 切到「已备份」分类
      const nav = Array.from(document.querySelectorAll('.fm-nav')).find((n) => n.dataset.cat === 'backed')
      if (!nav) return JSON.stringify({ err: 'no-backed-nav' })
      nav.click()
      await new Promise(r => setTimeout(r, 1400))
      const cards2 = Array.from(document.querySelectorAll('#fmList .fm-card'))
      return JSON.stringify({
        cat: (document.getElementById('fmCrumb') || {}).textContent,
        count: cards2.length,
        names: cards2.map((c) => (c.querySelector('.nm') || {}).textContent),
        ops: cards2[0] ? Array.from(cards2[0].querySelectorAll('.ops button')).map((b) => b.title || '') : [],
        navCount: (nav.querySelector('.n') || {}).textContent,
      })
    } catch (e) { return JSON.stringify({ err: String((e && e.stack) || e) }) }
  })()`))
  console.log('  ', J(backup))
  chk('备份后出现在「已备份」分类', backup.count >= 1 && backup.names.includes('年度总结.docx'), J(backup.names))
  chk('分类计数同步更新', backup.navCount === String(backup.count), `${backup.navCount} vs ${backup.count}`)
  chk('已备份项有「备份」「版本」两个入口（图标按钮，看 title）', backup.ops.length >= 2 && backup.ops.includes('历史版本'), J(backup.ops))

  const ver = JSON.parse(await js(`(async () => {
    const cards = Array.from(document.querySelectorAll('#fmList .fm-card'))
    const c = cards.find((x) => x.querySelector('.nm').textContent === '年度总结.docx') || cards[0]
    // 按钮现在用 SVG 图标，textContent 为空 —— 按 title 找
    const vbtn = Array.from(c.querySelectorAll('.ops button')).find((b) => (b.title || '').indexOf('历史版本') >= 0)
    if (!vbtn) return JSON.stringify({ panel: false, rows: 0, err: 'no-version-button' })
    vbtn.click()
    await new Promise(r => setTimeout(r, 1800))
    const rows = Array.from(document.querySelectorAll('.fm-ver'))
    return JSON.stringify({
      panel: !!document.querySelector('.fm-ver-panel'),
      rows: rows.length,
      hasClose: !!document.querySelector('.fm-ver-close'),
      hasRestore: rows.some((r) => Array.from(r.querySelectorAll('button')).some((b) => b.textContent.includes('还原'))),
      hasDelete: rows.some((r) => Array.from(r.querySelectorAll('button')).some((b) => b.textContent === '删除')),
    })
  })()`))
  console.log('  ', J(ver))
  chk('展开版本历史面板', ver.panel === true && ver.rows >= 1, J(ver))
  chk('每个版本有「还原到此版本」', ver.hasRestore === true)
  chk('每个版本可单独删除', ver.hasDelete === true)
  chk('面板标题带「收起」按钮（可折叠）', ver.hasClose === true)

  // 历史版本面板必须**横向占满整行** —— 宫格视图下它曾被当成一个「格子」，
  // 宽度只有一列（minmax(150px)），版本内容显示不全。
  const layout = JSON.parse(await js(`(() => {
    const p = document.querySelector('.fm-ver-panel')
    const list = document.getElementById('fmList')
    if (!p || !list) return JSON.stringify({ err: 'no-panel' })
    return JSON.stringify({
      view: list.className,
      panelW: Math.round(p.getBoundingClientRect().width),
      listW: list.clientWidth,
    })
  })()`))
  console.log('  ', J(layout))
  chk('宫格视图下历史版本横向占满（不被挤成一格）', !layout.err && layout.panelW >= layout.listW * 0.8, J(layout))

  await safeShot('fm-versions.png')

  // 折叠：点「收起」后面板应消失（用户要求历史版本是可折叠的）
  const folded = JSON.parse(await js(`(async () => {
    const x = document.querySelector('.fm-ver-close')
    if (!x) return JSON.stringify({ clicked: false })
    x.click()
    await new Promise((r) => setTimeout(r, 700))
    return JSON.stringify({ clicked: true, panel: !!document.querySelector('.fm-ver-panel') })
  })()`))
  console.log('  ', J(folded))
  chk('面板可折叠：点「收起」后消失', folded.clicked === true && folded.panel === false, J(folded))

  console.log('\n=== ⑦ 真实还原（并可回退）===')
  const before = JSON.parse(await js(`(async () => {
    const r = await window.moonAPI.relayVersions(${J(DOC)})
    return JSON.stringify({ count: r.count, stamp: r.versions[r.versions.length - 1].stamp })
  })()`))
  fs.appendFileSync(DOC, Buffer.from('界面上的改动'))
  const after = JSON.parse(await js(`(async () => {
    const res = await window.moonAPI.relayRestore(${J(DOC)}, ${J(before.stamp)})
    const r1 = await window.moonAPI.relayVersions(${J(DOC)})
    return JSON.stringify({ ok: res.ok, err: res.error, preBackup: !!res.preBackup, count: r1.count })
  })()`))
  console.log('  ', J(after))
  chk('还原成功', after.ok === true, after.err)
  chk('还原前自动备份当前内容（可再退回）', after.preBackup === true)
  chk('版本数 +1', after.count === before.count + 1, `${before.count} → ${after.count}`)

  console.log('\n=== ⑧ 固定监控：下载 + 桌面 ===')
  const watch = JSON.parse(await js(`(async () => {
    window.moonbitRelay.refresh()
    await new Promise(r => setTimeout(r, 1400))
    const st = await window.moonAPI.relayStatus()
    const dl = st.watched.find((d) => /Downloads$/i.test(d))
    const rm = await window.moonAPI.relayWatchRemove(dl)
    const still = (await window.moonAPI.relayStatus()).watched.some((d) => /Downloads$/i.test(d))
    const add = await window.moonAPI.relayWatchAdd(${J(path.resolve('.relay-test'))})
    const rm2 = await window.moonAPI.relayWatchRemove(${J(path.resolve('.relay-test'))})
    return JSON.stringify({ watched: st.watched, rmOk: rm.ok, rmErr: rm.error, still, addOk: add.ok, rmCustom: rm2.ok })
  })()`))
  console.log('  ', J(watch))
  chk('默认监控了下载与桌面', watch.watched.some((d) => /Downloads$/i.test(d)) && watch.watched.some((d) => /Desktop$/i.test(d)), J(watch.watched))
  chk('固定目录拒绝移除且仍在监控', watch.rmOk === false && watch.still === true, J(watch))
  chk('仍可手动加/删其他文件夹', watch.addOk === true && watch.rmCustom === true)

  console.log('\n=== ⑨ 启动时扫描：桌面/下载里「已存在」的文档 ===')
  // 之前 watcher 只在 fs.watch 的变化回调里记录文件、没有初始扫描 ——
  // 结果启动前就在桌面上的 .doc/.docx 一个都列不出来（用户报过）。
  const scan = JSON.parse(await js(`(async () => {
    const st = await window.moonAPI.relayStatus()
    return JSON.stringify({
      total: (st.recent || []).length,
      paths: (st.recent || []).map((r) => r.path),
      names: (st.recent || []).map((r) => r.name),
      watched: st.watched,
    })
  })()`))
  const deskPrefix = path.resolve(path.join(os.homedir(), 'Desktop')).toLowerCase()
  const downPrefix = path.resolve(path.join(os.homedir(), 'Downloads')).toLowerCase()
  const inDesk = scan.paths.filter((p) => path.resolve(p).toLowerCase().startsWith(deskPrefix))
  const inDown = scan.paths.filter((p) => path.resolve(p).toLowerCase().startsWith(downPrefix))
  console.log('   桌面读到 ' + inDesk.length + ' 个，下载读到 ' + inDown.length + ' 个')
  // 独立数一遍桌面里实际有多少文档，与读到的比对（口径与 relay 的扫描一致）
  const OFFICE_EXT = /\.(docx?|xlsx?|pptx?|pdf|wps|et|dps|odt|ods|odp)$/i
  const countOffice = (dir, depth) => {
    let n = 0
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (/^~\$/.test(e.name)) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { if (depth < 3) n += countOffice(full, depth + 1); continue }
        if (e.isFile() && OFFICE_EXT.test(full)) n++
      }
    } catch (_) {}
    return n
  }
  const expectDesk = countOffice(path.join(os.homedir(), 'Desktop'), 1)
  chk('桌面上的「已存在」文档被读到', expectDesk === 0 || inDesk.length > 0, `桌面实有 ${expectDesk}，读到 ${inDesk.length}`)
  chk('读到的列表非空（不再只显示「本次动过」的文件）', scan.total > 0, `总计 ${scan.total}`)

  await js(`(() => { const a = document.querySelector('a[data-view="agent"]'); if (a) a.click() })()`)
  await sleep(1000)
  await safeShot('fm-grid-view.png')

  console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
  app.quit()
  setTimeout(() => process.exit(0), 1500)
})
