// 验证 AI Agent 的「模型配置」弹窗：**真点按钮**，不只看元素存不存在。
//   · 点「配置模型」→ 弹窗应真的打开（#agCfgMask 不再 hidden）
//   · 切预设 → baseURL/model 应跟着变
//   · 点「保存」→ 配置应真的写进去（通过 agentConfigGet 复查）
// 注意：会写 ~/.config/opencode/opencode.jsonc —— 所以**先备份、测完恢复**。
require('./main.js')
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CFG_DIR = path.join(os.homedir(), '.config', 'opencode')
const CAND = [path.join(CFG_DIR, 'opencode.jsonc'), path.join(CFG_DIR, 'opencode.json')]
const OUT = path.join(__dirname, 'agent-config-result.txt')
const lines = []
const log = (s) => { lines.push(String(s)); console.log(s) }
function dump(code) { try { fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8') } catch (_) {} ; setTimeout(() => app.exit(code), 500) }

app.whenReady().then(async () => {
  // 备份现有配置
  const existed = CAND.filter((p) => { try { return fs.statSync(p).isFile() } catch (_) { return false } })
  const backups = existed.map((p) => ({ p, s: fs.readFileSync(p, 'utf8') }))
  log('· 备份了 ' + backups.length + ' 个配置文件')

  let win = null
  for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (win) break; await new Promise((r) => setTimeout(r, 250)) }
  if (!win) { log('没拿到窗口'); return dump(1) }
  const js = (c) => win.webContents.executeJavaScript(c)
  await new Promise((r) => setTimeout(r, 4000))
  // 切到 AI Agent 标签
  await js(`(() => { const a = document.querySelector('a[data-view="ai"]'); if (a) a.click() })()`)
  await new Promise((r) => setTimeout(r, 800))

  let pass = 0, fail = 0
  const chk = (n, ok, d) => { if (ok) { pass++; log('  [PASS] ' + n) } else { fail++; log('  [FAIL] ' + n + '  ' + (d || '')) } }

  log('\n=== ① 点「配置模型」应真的打开弹窗 ===')
  const opened = JSON.parse(await js(`(() => {
    const b = document.getElementById('agConfig')
    if (!b) return JSON.stringify({ err: 'no-button' })
    b.click()
    return new Promise((res) => setTimeout(() => {
      const m = document.getElementById('agCfgMask')
      const key = document.getElementById('agCfgKey')
      const base = document.getElementById('agCfgBase')
      const model = document.getElementById('agCfgModel')
      res(JSON.stringify({
        btnText: b.textContent.trim(),
        maskVisible: !!m && !m.hidden && getComputedStyle(m).display !== 'none',
        hasKey: !!key, keyType: key ? key.type : '',
        base: base ? base.value : '', model: model ? model.value : '',
        preset: (document.getElementById('agCfgPreset') || {}).value || '',
      }))
    }, 600))
  })()`))
  log('   ' + JSON.stringify(opened))
  chk('存在「配置模型」按钮', opened.btnText === '配置模型', opened.btnText)
  chk('点一下就真的打开了弹窗', opened.maskVisible === true)
  chk('API Key 默认是密码框', opened.keyType === 'password', opened.keyType)
  chk('预设自动填了 baseURL 与模型', !!opened.base && !!opened.model, opened.base + ' / ' + opened.model)

  log('\n=== ② 切预设应联动 baseURL / 模型 ===')
  const switched = JSON.parse(await js(`(() => {
    const sel = document.getElementById('agCfgPreset')
    sel.value = 'ollama'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return JSON.stringify({ base: document.getElementById('agCfgBase').value, model: document.getElementById('agCfgModel').value })
  })()`))
  log('   ' + JSON.stringify(switched))
  chk('选「本地 Ollama」后 baseURL 跟着变', /11434/.test(switched.base), switched.base)

  log('\n=== ③ 点「保存」应真的写进配置 ===')
  const saved = JSON.parse(await js(`(async () => {
    document.getElementById('agCfgKey').value = 'test-key-12345'
    document.getElementById('agCfgBase').value = 'http://127.0.0.1:11434/v1'
    document.getElementById('agCfgModel').value = 'qwen2.5:7b'
    document.getElementById('agCfgSave').click()
    await new Promise((r) => setTimeout(r, 1200))
    const st = await window.moonAPI.agentConfigGet()
    const m = document.getElementById('agCfgMask')
    return JSON.stringify({
      cfg: (st && st.config) || null,
      maskHiddenAfter: !!m && m.hidden,
    })
  })()`))
  const provs = (saved.cfg && saved.cfg.provider) ? Object.keys(saved.cfg.provider) : []
  log('   provider = ' + JSON.stringify(provs) + '   model = ' + JSON.stringify(saved.cfg && saved.cfg.model))
  chk('保存后配置里出现了 provider', provs.length > 0, JSON.stringify(provs))
  chk('保存的 model 与填写一致', String(saved.cfg && saved.cfg.model || '').includes('qwen2.5:7b'), String(saved.cfg && saved.cfg.model))
  chk('保存后弹窗自动关闭', saved.maskHiddenAfter === true)

  log('\n=== ④ 面板状态行应能显示模型 ===')
  const statusLine = JSON.parse(await js(`(() => JSON.stringify({ text: (document.getElementById('agStatus') || {}).textContent || '' }))()`))
  log('   状态行 = ' + JSON.stringify(statusLine.text))
  chk('状态行不再是「检查中…」', statusLine.text && statusLine.text !== '检查中…', statusLine.text)

  // 恢复备份
  log('\n=== 恢复原配置 ===')
  for (const p of CAND) { try { if (!backups.some((b) => b.p === p)) fs.rmSync(p, { force: true }) } catch (_) {} }
  for (const b of backups) { try { fs.writeFileSync(b.p, b.s, 'utf8') } catch (_) {} }
  log('· 已恢复 ' + backups.length + ' 个文件；本轮新增的已删除')

  log('\n结果：' + pass + ' 通过, ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  dump(fail === 0 ? 0 : 1)
})
