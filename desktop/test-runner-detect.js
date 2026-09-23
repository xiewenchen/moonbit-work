// 项目类型识别 + 运行入口发现的**输入→输出**测试（纯 Node，不启 GUI）。
//
// 为什么单独做这个：用户手点过两次——
//   ① 打开 Node 项目（strapi-backend）时顶栏按钮硬跑 moon，报 "not in a Moon project"
//   ② 打开 Java 项目（RuoYi-master）时运行报「项目类型：unknown」
// 这两条都属于 findRunners/kindOf 的**纯函数行为**，所以用「给定目录 → 期望输出」来验，
// 不需要 Electron。
//
// 断言必须是**行为**（输入变了输出就变），不是「函数存在」。
// 运行：node test-runner-detect.js
const fs = require('fs')
const os = require('os')
const path = require('path')
const { findRunners, kindOf } = require('./runners')

let pass = 0, fail = 0
const chk = (n, ok, d) => { if (ok) { pass++; console.log('  [PASS] ' + n) } else { fail++; console.log('  [FAIL] ' + n + '  ' + (d || '')) } }

// 造一个临时项目目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-detect-'))
function mk(name, files) {
  const d = path.join(TMP, name)
  fs.mkdirSync(d, { recursive: true })
  for (const [f, content] of Object.entries(files)) {
    const full = path.join(d, f)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return d
}

console.log('\n=== 项目类型识别（输入 → 输出）===')

// ① MoonBit
{
  const d = mk('mb', { 'moon.mod': 'name = "x/y"\n', 'hello/cmd/main/moon.pkg': '', 'hello/cmd/main/main.mbt': 'fn main {}\n' })
  const r = findRunners(d)
  chk('moon.mod 存在 → kind=moonbit', r.kind === 'moonbit', r.kind)
  chk('  且能扫出 hello/cmd/main 入口', r.runners.some((x) => /hello/.test(x.label)), JSON.stringify(r.runners.map((x) => x.label)))
  chk('  入口标题是中文、hint 是命令', r.runners.every((x) => /^运行 /.test(x.label) && /moon run/.test(x.hint)), JSON.stringify(r.runners[0]))
}

// ② Node（strapi-backend 那次的场景）
{
  const d = mk('node', { 'package.json': JSON.stringify({ name: 'x', scripts: { develop: 'strapi develop', start: 'strapi start', strapi: 'strapi', 'test:api': 'node t.js' } }) })
  const r = findRunners(d)
  chk('package.json 存在 → kind=node', r.kind === 'node', r.kind)
  const labels = r.runners.map((x) => x.label)
  chk('  develop 被翻成中文且标「推荐」', labels[0] === '开发模式启动（推荐）', JSON.stringify(labels))
  chk('  带前缀的 test:api 也被翻', labels.includes('跑测试 · api'), JSON.stringify(labels))
  chk('  空脚本 strapi 保留原名（不硬翻）', labels.includes('运行 strapi'), JSON.stringify(labels))
  // 行为：主入口必须排在空脚本之前 —— 用户就是因为 strapi 排在前面才点错的
  chk('  推荐入口排在空脚本之前', labels.indexOf('开发模式启动（推荐）') < labels.indexOf('运行 strapi'), JSON.stringify(labels))
}

// ③ Java（RuoYi 那次的场景）
{
  const d = mk('java', {
    'pom.xml': '<project/>',
    'ruoyi-admin/src/main/resources/application.yml': 'server:\n  port: 80\n',
    'ruoyi-admin/src/main/resources/application-druid.yml': 'url: jdbc:mysql://localhost:3306/ry\ndruid: {}\n',
    'sql/ry.sql': '-- schema\n',
  })
  const r = findRunners(d)
  chk('pom.xml 存在 → kind=java（之前是 unknown）', r.kind === 'java', r.kind)
  chk('  给出「启动应用」入口', r.runners.some((x) => x.label === '启动应用'), JSON.stringify(r.runners.map((x) => x.label)))
  const hint = (r.runners.find((x) => x.label === '启动应用') || {}).hint || ''
  chk('  hint 里点出「需要先启动 MySQL」（扫 druid 数据源得出）', /MySQL/.test(hint), hint)
  chk('  hint 里点出「要先建表」（因为存在 sql/ 目录）', /建表/.test(hint), hint)
  chk('  这个版本不报 Redis（用 EhCache，配置里没有 redis 字样）', !/Redis/.test(hint), hint)
}

// ④ 静态站点（只有 index.html）
{
  const d = mk('static', { 'index.html': '<h1>hi</h1>' })
  const r = findRunners(d)
  chk('只有 index.html → kind=static（之前是 unknown）', r.kind === 'static', r.kind)
  chk('  给出「在浏览器里预览」入口', r.runners.some((x) => x.label === '在浏览器里预览'), JSON.stringify(r.runners.map((x) => x.label)))
}

// ⑤ 真的什么都没有
{
  const d = mk('empty', { 'readme.txt': 'hi' })
  chk('只有 readme → kind=unknown（不误报）', kindOf(d) === 'unknown', kindOf(d))
  chk('  也没有任何入口', findRunners(d).runners.length === 0)
}

// ⑥ 优先级：一个目录里既有 package.json 又有 index.html，应该认 Node 而不是 static
{
  const d = mk('both', { 'package.json': JSON.stringify({ scripts: { dev: 'x' } }), 'index.html': '<h1>hi</h1>' })
  chk('Node 与 static 并存 → 优先 Node', kindOf(d) === 'node', kindOf(d))
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
