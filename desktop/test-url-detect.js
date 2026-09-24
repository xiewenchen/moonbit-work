'use strict'

/**
 * URL Detector 单测（Phase 2 / MBW-P1-08 ～ MBW-P1-13）
 *
 * 纯 Node，不需要 Electron、不需要 native 构建 —— 因此不受本机工具链故障（R12）影响。
 * 断言失败只记录，不扩大修改范围（RULE-02）。
 *
 * 覆盖：
 *   P1-08 单 chunk          P1-09 跨 chunk（3 段）
 *   P1-10 ANSI 色码         P1-11 多 URL 的挑选规则
 *   P1-12 非法 / 边界形态    P1-13 重复 URL 只触发一次
 *   + 防漂移：本模块的正则必须与 runners.js:262 的生产正则逐字符一致
 */

const fs = require('fs')
const path = require('path')
const {
  LOCAL_URL_RE,
  stripAnsi,
  detectUrl,
  createUrlScanner,
  portOf,
} = require('./url-detect')

let pass = 0
let fail = 0
const failures = []

function chk(name, got, want) {
  const ok = got === want
  if (ok) {
    pass++
    console.log('  [PASS] ' + name)
  } else {
    fail++
    failures.push(name)
    console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want))
  }
}

console.log('\n=== P1-08 单 chunk ===')
chk('Server at http://127.0.0.1:8123', detectUrl('Server at http://127.0.0.1:8123'), 'http://127.0.0.1:8123')
chk('句末带标点要剥掉', detectUrl('listening on http://127.0.0.1:8123.'), 'http://127.0.0.1:8123')

console.log('\n=== P1-09 跨 chunk（3 段）===')
{
  const s = createUrlScanner()
  const parts = ['Server listenin', 'g at http://127.', '0.0.1:8123']
  const hits = parts.map((p) => s.push(p)).filter(Boolean)
  chk('跨 3 段拼出同一个 URL', hits.length === 1 && hits[0].url, 'http://127.0.0.1:8123')
  chk('拼接后直接检测也一致', detectUrl(parts.join('')), 'http://127.0.0.1:8123')
}

console.log('\n=== P1-10 ANSI 色码 ===')
chk(
  '\\x1b[32m 包裹',
  detectUrl('\u001b[32mServer\u001b[0m http://127.0.0.1:8123'),
  'http://127.0.0.1:8123'
)
chk(
  'URL 后紧跟 ANSI',
  detectUrl('\u001b[32mhttp://localhost:1337/admin\u001b[39m'),
  'http://localhost:1337/admin'
)
chk('stripAnsi 幂等', stripAnsi(stripAnsi('\u001b[31mx\u001b[0m')), 'x')

console.log('\n=== P1-11 多 URL 的挑选规则 ===')
{
  const text = 'http://127.0.0.1:8123\nhttp://127.0.0.1:5173'
  chk('未给偏好 → 取第一个（与现状一致）', detectUrl(text), 'http://127.0.0.1:8123')
  chk('偏好 5173 → 选中 5173', detectUrl(text, { preferPorts: [5173] }), 'http://127.0.0.1:5173')
  chk('偏好无匹配 → 回退第一个', detectUrl(text, { preferPorts: [9999] }), 'http://127.0.0.1:8123')
  chk('preferPort 单数形式也支持', detectUrl(text, { preferPort: 5173 }), 'http://127.0.0.1:5173')
  chk('portOf 解析端口', portOf('http://localhost:5173/'), 5173)
  chk('portOf 无端口 → null', portOf('http://localhost'), null)
}

console.log('\n=== P1-12 非法 / 边界形态 ===')
chk('`localhost:`（无 scheme）→ null', detectUrl('localhost:'), null)
chk('`http://`（无 host）→ null', detectUrl('http://'), null)
chk('`http://foo`（非本地 host）→ null', detectUrl('http://foo'), null)
chk('`http://127.0.0.1`（无端口）→ 合法', detectUrl('http://127.0.0.1'), 'http://127.0.0.1')
chk('`http://127.0.0.1:`（尾冒号）→ 去掉冒号', detectUrl('http://127.0.0.1:'), 'http://127.0.0.1')
chk('外网地址不匹配', detectUrl('visit https://example.com/api'), null)
chk('空输入 → null', detectUrl(''), null)
chk('null/undefined 不抛异常', detectUrl(null) === null && detectUrl(undefined) === null, true)

console.log('\n=== P1-13 重复 URL 只触发一次 ===')
{
  const s = createUrlScanner()
  const a = s.push('Server http://127.0.0.1:8123')
  const b = s.push('Ready http://127.0.0.1:8123')
  chk('第一次命中', a && a.url, 'http://127.0.0.1:8123')
  chk('第二次同一 URL → 不再触发（不会开两个浏览器）', b, null)
  chk('opened 标志为真', s.opened, true)
  s.reset()
  chk('reset 后可再次命中', (s.push('again http://127.0.0.1:8123') || {}).url, 'http://127.0.0.1:8123')
}

console.log('\n=== 防漂移：正则必须与 runners.js:262 一致 ===')
{
  const runnersSrc = fs.readFileSync(path.join(__dirname, 'runners.js'), 'utf8')
  const lit = runnersSrc.match(/buf\.match\((\/[^\n]*\/[a-z]*)\)/)
  if (!lit) {
    chk('能在 runners.js 里找到生产正则', false, true)
  } else {
    const inner = lit[1].slice(1, lit[1].lastIndexOf('/'))
    chk('url-detect.js 的正则 === runners.js:262 的正则', LOCAL_URL_RE.source, inner)
  }
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
if (fail) {
  console.log('失败项：\n  - ' + failures.join('\n  - '))
}
process.exit(fail === 0 ? 0 : 1)
