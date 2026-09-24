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
function dump(code) {
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

  log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  dump(fail === 0 ? 0 : 1)
}).catch((e) => { log('[FATAL] script threw before finishing: ' + String((e && e.stack) || e)); dump(1) })
