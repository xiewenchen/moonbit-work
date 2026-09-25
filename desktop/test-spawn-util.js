'use strict'

/**
 * spawn-util 单测（Phase 2.1 / P17-06）
 *
 * 纯 Node。断言用公共 verify-harness。
 *
 * 这一份的重点：**控制字符必须被拒**（换行在 cmd 里就是命令分隔符），
 * 以及"不该加引号的别加"（加多了会让命令跑不起来）。
 */

const { createHarness } = require('./verify-harness')
const { resolveSpawn, quoteForCmd } = require('./spawn-util')

const H = createHarness()
const { chk, eq } = H
const isWin = process.platform === 'win32'

async function main() {
  console.log('\n=== ① 控制字符一律拒（换行在 cmd 里就是命令分隔符）===')
  {
    for (const bad of ['a\nb', 'a\rb', 'a\r\nb', 'a\u0000b']) {
      let threw = false
      try { quoteForCmd(bad) } catch (e) { threw = true }
      chk('★ quoteForCmd 拒：' + JSON.stringify(bad).slice(0, 16), threw)
      let threw2 = false
      try { resolveSpawn('npm', ['run', bad]) } catch (e) { threw2 = true }
      chk('★ resolveSpawn 拒（参数里）：' + JSON.stringify(bad).slice(0, 16), threw2)
    }
  }

  console.log('\n=== ② 该加引号的加、不该加的不加 ===')
  {
    eq('普通词不加引号', quoteForCmd('hello'), 'hello')
    eq('路径里的反斜杠不需要引号', quoteForCmd('C:\\work\\a'), 'C:\\work\\a')
    eq('含空格 → 包起来', quoteForCmd('C:\\Program Files\\a'), '"C:\\Program Files\\a"')
    eq('含 & → 包起来', quoteForCmd('a&b'), '"a&b"')
    eq('含 | → 包起来', quoteForCmd('a|b'), '"a|b"')
    eq('含 ^ → 包起来', quoteForCmd('a^b'), '"a^b"')
    // P17 加固：% 与 ! 也纳入引号条件（命令行里不展开，但包上没坏处；万一走 .bat 就靠它）
    eq('含 % → 包起来', quoteForCmd('a%b'), '"a%b"')
    eq('含 ! → 包起来（延迟展开）', quoteForCmd('a!b'), '"a!b"')
    eq('引号被双写（cmd 的转义方式）', quoteForCmd('say "hi"'), '"say ""hi"""')
  }

  console.log('\n=== ③ resolveSpawn：Windows 上谁走 shell ===')
  {
    if (!isWin) {
      // 非 Windows：一律不 shell
      eq('非 Windows 一律 shell:false', resolveSpawn('npm', ['run', 't']).shell, false)
      chk('  args 原样保留', Array.isArray(resolveSpawn('npm', ['run', 't']).args))
    } else {
      const npm = resolveSpawn('npm', ['run', 'test'])
      eq('不带扩展名的命令（npm）→ 走 shell', npm.shell, true)
      eq('  整条拼成 bin，args 清空（避免 DEP0190）', [Array.isArray(npm.args), npm.args.length], [true, 0])
      chk('  拼出来的命令行含 npm 与 run', /npm/.test(npm.bin) && /run/.test(npm.bin), npm.bin)

      const cmd = resolveSpawn('opencode.cmd', ['run'])
      eq('.cmd → 走 shell', cmd.shell, true)
      const exe = resolveSpawn('C:\\tools\\x.exe', ['--v'])
      eq('★ 明确的 .exe → **不**走 shell（少一层 cmd）', exe.shell, false)
      eq('  参数仍是数组（不会被再转义）', exe.args, ['--v'])

      const spaced = resolveSpawn('npm', ['--prefix', 'C:\\Program Files\\p'])
      chk('★ 带空格的参数被引起来', /"C:\\Program Files\\p"/.test(spaced.bin), spaced.bin)
    }
  }

  console.log('\n=== ④ 参数里的控制字符 → 在 resolveSpawn 入口就被拒 ===')
  {
    let threw = false
    try { resolveSpawn('npm', ['install', 'evil\nrm -rf /']) } catch (e) { threw = true }
    chk('★ 参数含换行 → 抛（不会拼进命令行）', threw)
    let threw2 = false
    try { resolveSpawn('npm', ['a\u0000b']) } catch (e) { threw2 = true }
    chk('参数含 NUL → 抛', threw2)
  }

  console.log('\n=== ⑤ 拼接结果里不该出现裸的控制字符 ===')
  {
    if (isWin) {
      const r = resolveSpawn('node', ['-e', 'console.log(1)'])
      chk('★ 拼出来的命令行只有一行（没有换行注入）', !/[\r\n]/.test(r.bin), JSON.stringify(r.bin))
    } else {
      const r = resolveSpawn('node', ['-e', 'x'])
      chk('非 Windows 下 bin 就是原始命令名', typeof r.bin === 'string')
    }
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
