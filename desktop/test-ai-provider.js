'use strict'

/**
 * AI Provider Center 单测（Phase 2 / MBW-P12-01 ～ P12-11）
 *
 * 纯 Node：HTTP 探测靠注入。
 * 本文件里最要紧的一组是**脱敏**（P12-07/08）——
 * 断言"脱敏后的序列化结果里不含完整 Key"，包括**深层嵌套**与**错误信息**两条容易漏的路径。
 */

const {
  PROVIDER_TYPE,
  ALL_TYPES,
  PROVIDER_PRESETS,
  maskKey,
  redactProvider,
  redactForLog,
  logSafe,
  createProvider,
  validateProvider,
  probeUrl,
  testConnection,
  mergeProviders,
  listForUi,
} = require('./ai-provider')

let pass = 0
let fail = 0
const failures = []
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
}

const REAL_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234'

async function main() {
  console.log('\n=== P12-07 Key 脱敏 ===')
  {
    chk('标准 sk- Key → sk-****1234 形式', maskKey(REAL_KEY), 'sk-****1234')
    chk('只暴露后 4 位（前缀之外的中间段全遮）', maskKey(REAL_KEY).includes('proj-abcdef'), false)
    chk('非 sk- 前缀的长串 → ****后4位', /^\*{4}.{4}$/.test(maskKey('0123456789abcdef')), true)
    chk('短串一律 ****（露头露尾等于没脱敏）', [maskKey('short'), maskKey('12345678901')], ['****', '****'])
    chk('空 / null / undefined → 空串或 ****', [maskKey(''), maskKey(null), maskKey(undefined)], ['', '', ''])
  }

  console.log('\n=== P12-08 脱敏后**不含**完整 Key（含深层嵌套）===')
  {
    const p = createProvider({ name: 'a', type: 'openai', apiKey: REAL_KEY })
    const masked = redactProvider(p)
    chk('redactProvider 后不含原文', JSON.stringify(masked).includes(REAL_KEY), false)
    chk('但保留了"有没有 Key"的信息', [masked.apiKey, masked.hasKey], ['sk-****1234', true])

    const payload = {
      provider: p,
      nested: { deep: { apiKey: REAL_KEY, token: REAL_KEY } },
      list: [{ authorization: 'Bearer ' + REAL_KEY, password: 'p@ss' }],
      safe: 'this is fine',
      error: 'failed with key ' + REAL_KEY,
    }
    const redacted = redactForLog(payload)
    const text = JSON.stringify(redacted)
    chk('**深度脱敏：整包序列化里没有原文**', text.includes(REAL_KEY), false)
    chk('深度脱敏：数组里的 authorization 也被处理', /Bearer \*\*\*\*/.test(text) || !text.includes('Bearer '), true)
    chk('无关字段保持原样', redacted.safe, 'this is fine')
    chk('嵌套结构仍可读（不是整包变字符串）', typeof redacted.nested.deep, 'object')

    chk('logSafe 与 redactForLog 一致', JSON.stringify(logSafe(payload)), text)

    // 项目目录里的清单必须是脱敏的
    const ui = listForUi([p, { name: 'b', type: 'ollama' }])
    chk('listForUi 全部脱敏', JSON.stringify(ui).includes(REAL_KEY), false)
    chk('listForUi 条数与名称', ui.map((x) => x.name), ['a', 'b'])
  }

  console.log('\n=== P12-01 Schema 与校验 ===')
  {
    const p = createProvider({ name: ' my ', type: 'deepseek', apiKey: 'x' })
    chk('归一：name trim、预设填充 baseUrl/model', [p.name, p.baseUrl, p.model, p.enabled], ['my', 'https://api.deepseek.com/v1', 'deepseek-chat', true])
    chk('尾斜杠被去掉（拼端点不会出 //）', createProvider({ name: 'x', baseUrl: 'https://a.com/v1///' }).baseUrl, 'https://a.com/v1')
    chk('enabled:false 被保留', createProvider({ name: 'x', enabled: false }).enabled, false)
    chk('未知 type → custom', createProvider({ name: 'x', type: 'wat' }).type, 'custom')

    chk('缺 name → 报错', validateProvider(createProvider({ type: 'ollama' })).errors, ['缺少 name'])
    chk('非法 baseUrl → 报错', validateProvider(createProvider({ name: 'x', type: 'custom', baseUrl: 'ftp://a' })).errors, ['baseUrl 必须以 http:// 或 https:// 开头'])
    chk('需要 Key 的类型缺 Key → 报错', /需要 apiKey/.test(validateProvider(createProvider({ name: 'x', type: 'openai' })).errors.join()), true)
    chk('Ollama 不需要 Key', validateProvider(createProvider({ name: 'x', type: 'ollama' })).ok, true)
    chk('正常 provider 通过', validateProvider(createProvider({ name: 'x', type: 'ollama' })).ok, true)
  }

  console.log('\n=== P12-02 ～ P12-05 四种预设 ===')
  {
    chk('四种预设齐备', Object.keys(PROVIDER_PRESETS).sort(), ['custom', 'deepseek', 'ollama', 'openai'])
    chk('DeepSeek 端点与模型', [PROVIDER_PRESETS.deepseek.baseUrl, PROVIDER_PRESETS.deepseek.model], ['https://api.deepseek.com/v1', 'deepseek-chat'])
    chk('Ollama 是本地且不需 Key', [PROVIDER_PRESETS.ollama.baseUrl, PROVIDER_PRESETS.ollama.needsKey], ['http://127.0.0.1:11434/v1', false])
    chk('自定义预设不预填端点', [PROVIDER_PRESETS.custom.baseUrl, PROVIDER_PRESETS.custom.model], ['', ''])
    chk('ALL_TYPES 与预设一致', ALL_TYPES.slice().sort(), Object.keys(PROVIDER_PRESETS).sort())
  }

  console.log('\n=== P12-06 Test Connection ===')
  {
    chk('探测端点 = baseUrl + /models', probeUrl('https://api.a.com/v1/'), 'https://api.a.com/v1/models')

    const okDeps = { request: async (spec) => ({ ok: true, status: 200, body: '{"data":[]}' }), now: () => 1000 }
    const ok = await testConnection({ name: 'a', type: 'openai', apiKey: REAL_KEY }, okDeps)
    chk('成功 → ok + latency + model', [ok.ok, typeof ok.latency, ok.model, ok.status], [true, 'number', 'gpt-4o-mini', 200])

    let seenAuth = null
    await testConnection({ name: 'a', type: 'openai', apiKey: REAL_KEY }, {
      request: async (spec) => { seenAuth = spec.headers && spec.headers.Authorization; return { ok: true, status: 200 } },
      now: () => 1,
    })
    chk('请求头带了 Authorization', String(seenAuth), 'Bearer ' + REAL_KEY)

    const bad = await testConnection({ name: 'a', type: 'openai', apiKey: REAL_KEY }, { request: async () => ({ ok: false, status: 401, body: 'invalid key ' + REAL_KEY }), now: () => 5 })
    chk('失败 → ok:false + status', [bad.ok, bad.status], [false, 401])
    chk('**错误信息也脱敏（有的服务会回显 Key）**', String(bad.error).includes(REAL_KEY), false)

    const noKey = await testConnection({ name: 'a', type: 'openai' })
    chk('缺 Key → 校验先拦住', [noKey.ok, /需要 apiKey/.test(String(noKey.error))], [false, true])

    const boom = await testConnection({ name: 'a', type: 'ollama' }, { request: async () => { throw new Error('网络炸了') } })
    chk('request 抛错 → 转成失败', [boom.ok, /网络炸了/.test(String(boom.error))], [false, true])

    const noReq = await testConnection({ name: 'a', type: 'ollama' }, {})
    chk('未注入 request → 明确报错', /未注入/.test(String(noReq.error)), true)
  }

  console.log('\n=== P12-10 全局与项目分离 ===')
  {
    const g = [{ name: 'main', type: 'openai', apiKey: 'g-key-1234567890' }, { name: 'only-global', type: 'ollama' }]
    const pj = [{ name: 'main', type: 'deepseek', apiKey: 'p-key-1234567890' }, { name: 'only-project', type: 'custom', baseUrl: 'http://x/v1' }]
    const merged = mergeProviders(g, pj)
    chk('项目同名覆盖全局', merged.find((x) => x.name === 'main').type, 'deepseek')
    chk('覆盖后 scope = project', merged.find((x) => x.name === 'main').scope, 'project')
    chk('全局独有的保留', merged.find((x) => x.name === 'only-global').scope, 'global')
    chk('项目独有的追加在后面', merged.map((x) => x.name), ['main', 'only-global', 'only-project'])
    chk('数量 = 并集', merged.length, 3)
    chk('空输入不抛', [mergeProviders().length, mergeProviders(null, null).length], [0, 0])
  }

  console.log('\n=== P12-11 切换 Provider（给 Agent 用的一份配置）===')
  {
    const list = listForUi([{ name: 'main', type: 'deepseek', apiKey: REAL_KEY, model: 'deepseek-chat' }])
    chk('切换所需的字段齐备', ['name', 'type', 'baseUrl', 'model', 'apiKey', 'enabled'].every((k) => k in list[0]), true)
    chk('**给界面的 Key 是脱敏的**', list[0].apiKey, 'sk-****1234')
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('单测异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
