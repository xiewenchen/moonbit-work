// AI Provider 的接线验证（P12 接线段）
//
// 两条最关键的断言：
//   ① **配置文件在用户目录**（不在项目里）—— P12-09；
//   ② **读回来的清单里 Key 是脱敏值**（`sk-****1234`），完整 Key 不出主进程 —— P12-07。
// 另外用**真实探测**验证连通性检查：一个必然失败的端点 + 一个 Ollama 默认端点。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, 'ai-provider-result.txt')
const ROOT = path.resolve(__dirname, '..')
const TEST_NAME = '__verify_provider__'
const REAL_KEY = 'sk-verify-abcdefghijklmnop1234'
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }

// ★ opencode 的真实模型配置：本脚本会写它（验证激活），所以必须备份 + 任何退出路径都还原
let CFG_PATH = null
let CFG_BACKUP = null
function restoreCfg() {
  try {
    if (!CFG_PATH) return
    if (CFG_BACKUP === null) {
      if (fs.existsSync(CFG_PATH)) fs.unlinkSync(CFG_PATH)
    } else {
      fs.writeFileSync(CFG_PATH, CFG_BACKUP, 'utf8')
    }
  } catch (e) {
    console.log('[WARN] 还原 opencode 配置失败：' + String((e && e.message) || e))
  }
}
function dump(code) {
  restoreCfg()                                    // ★ 无论怎么退出，都把用户的配置还原
  try {
    fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  } catch (e) {
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
  await sleep(3000)

  let pass = 0, fail = 0
    /** 布尔断言：**只接受布尔**（detail 仅在失败时显示）。
   *  ⚠️ 误用防护：传数组/对象进来会**立刻判失败**并提示用 `eq` ——
   *  历史上 25 处 `eq('x', [a,b], [c,d])` 因为数组恒为真而**永远通过**，等于没验。 */
  const chk = (n, ok, detail) => {
    if (typeof ok !== 'boolean') {
      fail++; log('  [FAIL] ' + n + '   ⚠️ chk 只接受布尔（数组/对象比较请用 eq）：' + JSON.stringify(ok))
      return
    }
    if (ok) { pass++; log('  [PASS] ' + n) } else { fail++; log('  [FAIL] ' + n + (detail ? '  ' + detail : '')) }
  }
  /** 相等断言：JSON 相等比较（数组/对象用这个）*/
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; log('  [PASS] ' + n) }
    else { fail++; log('  [FAIL] ' + n + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
  }
  const P = async (expr) => JSON.parse(await js(`(async () => JSON.stringify(${expr}))()`))

  log('\n=== ① 存储位置：必须在用户目录（P12-09）===')
  const st = await P('await window.moonbitIDE.agentTools.provider.storage()')
  log('   配置：' + st.file)
  eq('返回了存储路径', [st.ok, typeof st.file], [true, 'string'])
  chk('**不在项目目录里**', path.normalize(st.file).startsWith(path.normalize(ROOT)) === false, st.file)
  chk('在用户目录下（.moonbit-work）', /\.moonbit-work/.test(st.file), st.file)

  log('\n=== ② 保存 + 读回来必须已脱敏（P12-07）===')
  {
    const saved = await P(`await window.moonbitIDE.agentTools.provider.save(${JSON.stringify({
      name: TEST_NAME, type: 'openai', apiKey: REAL_KEY, model: 'gpt-4o-mini',
    })})`)
    chk('保存成功', saved.ok === true, JSON.stringify(saved).slice(0, 120))

    const list = await P('await window.moonbitIDE.agentTools.provider.list()')
    const item = (list.providers || []).find((x) => x.name === TEST_NAME)
    chk('清单里有刚保存的 provider', !!item, JSON.stringify((list.providers || []).map((x) => x.name)))
    eq('**Key 是脱敏值**', item && item.apiKey, 'sk-****1234')
    chk('**清单里不含完整 Key**', !JSON.stringify(list).includes(REAL_KEY))
    chk('但知道"有 Key"', item && item.hasKey, true)

    // 磁盘上确实是原文（本地配置要能用），但**不在项目里**
    const onDisk = fs.readFileSync(st.file, 'utf8')
    chk('磁盘上存的是原文（本地配置需要能用）', onDisk.includes(REAL_KEY), true)
    chk('磁盘文件确实在用户目录', path.normalize(st.file).startsWith(path.normalize(ROOT)) === false, true)
  }

  log('\n=== ③ 校验：需要 Key 的类型缺 Key 会被拦下 ===')
  {
    const bad = await P(`await window.moonbitIDE.agentTools.provider.save(${JSON.stringify({ name: TEST_NAME + '_bad', type: 'openai' })})`)
    eq('缺 Key → 拒绝', [bad.ok === false, /需要 apiKey/.test(String(bad.error))], [true, true])
    const badUrl = await P(`await window.moonbitIDE.agentTools.provider.save(${JSON.stringify({ name: TEST_NAME + '_bad', type: 'custom', baseUrl: 'ftp://x' })})`)
    eq('非法 baseUrl → 拒绝', [badUrl.ok === false, /baseUrl/.test(String(badUrl.error))], [true, true])
  }

  log('\n=== ④ 连通性检查：真实探测（结果结构化，不假装成功）===')
  {
    // 必然失败的端点（本机 1 端口没人听）
    const t1 = await P(`await window.moonbitIDE.agentTools.provider.test(${JSON.stringify({ name: 'dead', type: 'custom', baseUrl: 'http://127.0.0.1:1/v1' })})`)
    eq('探测必然失败的端点 → ok:false + 结构化字段', [t1.ok === false, typeof t1.latency, 'error' in t1], [true, 'number', true])

    // Ollama 默认端点：装了会成功，没装也应当是**结构化失败**（不抛）
    const t2 = await P(`await window.moonbitIDE.agentTools.provider.test(${JSON.stringify({ name: 'ollama', type: 'ollama' })})`)
    log('   Ollama 探测：' + JSON.stringify(t2).slice(0, 140))
    chk('Ollama 探测返回结构化结果', ['ok', 'latency', 'model', 'status', 'error'].every((k) => k in t2), true)

    // 失败信息里不该出现 Key（P12-08）
    const t3 = await P(`await window.moonbitIDE.agentTools.provider.test(${JSON.stringify({ name: 'dead2', type: 'openai', apiKey: REAL_KEY, baseUrl: 'http://127.0.0.1:1/v1' })})`)
    chk('探测失败的 error 里不含 Key', !String(t3.error || '').includes(REAL_KEY))
  }

  log('\n=== ⑤ Provider 面板（真打开 + 真渲染）===')
  {
    await js('window.moonbitIDE.agentTools.provider.openPanel()')
    await sleep(900)
    chk('面板出现', await js(`!!document.getElementById('providerPanel')`), true)
    const panelText = await js(`(document.getElementById('providerPanel') || {}).textContent || ''`)
    chk('面板列出了 provider', String(panelText).includes(TEST_NAME), true)
    eq('**面板上显示的是脱敏 Key**', [String(panelText).includes('sk-****1234'), String(panelText).includes(REAL_KEY)], [true, false])
    chk('面板提示了配置位置', /\.moonbit-work/.test(String(panelText)), true)
    await js(`(() => { const b = Array.from(document.querySelectorAll('#providerPanel button')).find(x => x.textContent === '关闭'); if (b) b.click() })()`)
    await sleep(400)
    chk('关闭后面板消失', await js(`!document.getElementById('providerPanel')`), true)
  }

  log('\n=== ⑥ 删除（清理测试数据）===')
  {
    const del = await P(`await window.moonbitIDE.agentTools.provider.remove(${JSON.stringify(TEST_NAME)})`)
    chk('删除成功', del.ok === true, JSON.stringify(del).slice(0, 100))
    const list = await P('await window.moonbitIDE.agentTools.provider.list()')
    chk('清单里没有了', !(list.providers || []).some((x) => x.name === TEST_NAME))
    chk('删不存在的 → 明确失败', (await P(`await window.moonbitIDE.agentTools.provider.remove('__nope__')`)).ok === false, true)
  }

  log('\n=== ⑦ 激活：翻译成 opencode 配置（合并写回，不能破坏已有 provider）===')
  {
    const act0 = await P('await window.moonbitIDE.agentTools.provider.active()')
    CFG_PATH = act0.file
    CFG_BACKUP = fs.existsSync(CFG_PATH) ? fs.readFileSync(CFG_PATH, 'utf8') : null
    log('   opencode 配置：' + CFG_PATH + '（备份 ' + (CFG_BACKUP === null ? '无（原本不存在）' : CFG_BACKUP.length + ' 字节') + '）')

    const before = CFG_BACKUP ? JSON.parse(CFG_BACKUP.replace(/^\s*\/\/.*$/gm, '')) : {}
    const beforeIds = Object.keys(before.provider || {})
    log('   激活前的 provider：' + JSON.stringify(beforeIds))

    // 先存一个可激活的 provider（测试用名）
    await P(`await window.moonbitIDE.agentTools.provider.save(${JSON.stringify({
      name: TEST_NAME, type: 'openai', apiKey: REAL_KEY, model: 'gpt-4o-mini',
    })})`)
    const a = await P(`await window.moonbitIDE.agentTools.provider.activate(${JSON.stringify(TEST_NAME)})`)
    chk('激活成功', a.ok === true, JSON.stringify(a).slice(0, 120))
    eq('返回的 model 是 id/model 形式', a.model, a.id + '/gpt-4o-mini')

    const after = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
    chk('配置里出现了该 provider', !!(after.provider && after.provider[a.id]), Object.keys((after.provider || {})).join(','))
    eq('provider 的 baseURL 写对了', after.provider[a.id].options.baseURL, 'https://api.openai.com/v1')
    eq('apiKey 真的写进去了（否则根本驱动不了）', after.provider[a.id].options.apiKey, REAL_KEY)
    eq('npm 驱动是 openai-compatible', after.provider[a.id].npm, '@ai-sdk/openai-compatible')
    eq('models 里有那个模型', Object.keys(after.provider[a.id].models || {}), ['gpt-4o-mini'])
    eq('顶层 model 指向它', after.model, a.model)
    chk('**原有 provider 一个都没丢**（合并而非覆盖）',
      beforeIds.every((id) => !!(after.provider && after.provider[id])), JSON.stringify({ before: beforeIds, after: Object.keys(after.provider || {}) }))
    eq('原有顶层字段保留（如 $schema）', after.$schema, before.$schema)

    const act1 = await P('await window.moonbitIDE.agentTools.provider.active()')
    eq('active() 读回来一致', [act1.model, act1.baseUrl], [a.model, 'https://api.openai.com/v1'])

    chk('激活不存在的 → 拒', (await P(`await window.moonbitIDE.agentTools.provider.activate('__nope__')`)).ok === false)
    // 缺 Key 的 openai 类型不能激活（写进去也没用）
    await P(`await window.moonbitIDE.agentTools.provider.save(${JSON.stringify({ name: TEST_NAME + '_nokey', type: 'ollama' })})`)
    chk('ollama 类型（不需要 key）可以激活', (await P(`await window.moonbitIDE.agentTools.provider.activate(${JSON.stringify(TEST_NAME + '_nokey')})`)).ok === true)
    await P(`await window.moonbitIDE.agentTools.provider.remove(${JSON.stringify(TEST_NAME + '_nokey')})`)

    // 面板上要有「激活」按钮
    await js('window.moonbitIDE.agentTools.provider.openPanel()')
    await sleep(800)
    const btnTexts = await js(`JSON.stringify(Array.from(document.querySelectorAll('#providerPanel button')).map(x => x.textContent))`)
    chk('面板有「激活」按钮', String(btnTexts).includes('激活'), String(btnTexts).slice(0, 140))
    chk('面板显示了「当前生效」', /当前生效/.test(await js(`(document.getElementById('providerPanel') || {}).textContent || ''`)))
    await js(`(() => { const b = Array.from(document.querySelectorAll('#providerPanel button')).find(x => x.textContent === '关闭'); if (b) b.click() })()`)
    await sleep(300)
    // 收尾：第 ⑦ 组自己存的 provider 也要删掉，否则会留在用户的 providers.json 里
    await P(`await window.moonbitIDE.agentTools.provider.remove(${JSON.stringify(TEST_NAME)})`)
  }

  log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  dump(fail === 0 ? 0 : 1)
}).catch((e) => { log('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
