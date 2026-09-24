'use strict'

/**
 * Agent 安全门单测（Phase 2 / MBW-P5.5-02 ～ P5.5-09）
 *
 * 纯 Node：文件系统与命令执行全靠注入 —— 所以**逃逸用例**（`..` / 绝对路径 / 符号链接）
 * 可以在这里彻底跑一遍，而不需要真的去碰 workspace 外的文件。
 *
 * 这批断言的性质是**安全测试**：每一条都对应一个"如果不拦会怎样"。
 */

const os = require('node:os')
const path = require('node:path')
const {
  PERMISSION,
  DEFAULT_ALLOWED_BINS,
  FORBIDDEN_BINS,
  createToolManifest,
  isInsideWorkspace,
  resolveInsideWorkspace,
  isDestructiveTarget,
  checkCommand,
  createBudget,
  runTool,
} = require('./agent-sandbox')

let pass = 0
let fail = 0
const failures = []
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
}

const WS = path.join(os.tmpdir(), 'ws-sandbox-test')

async function main() {
  console.log('\n=== P5.5-02/03 Tool Manifest ===')
  {
    const base = { name: 'readFile', permission: PERMISSION.READ, timeoutMs: 5000, maxOutputBytes: 1024 }
    const m = createToolManifest(base)
    chk('正常声明', [m.name, m.permission, m.timeoutMs, m.maxOutputBytes], ['readFile', 'read', 5000, 1024])
    chk('**workspaceOnly 默认 true**（默认收紧）', m.workspaceOnly, true)
    chk('network 默认 false', m.network, false)
    chk('danger 默认 low', m.danger, 'low')

    for (const [label, spec] of [
      ['缺 name', { permission: 'read', timeoutMs: 1, maxOutputBytes: 1 }],
      ['缺 permission', { name: 'x', timeoutMs: 1, maxOutputBytes: 1 }],
      ['缺 timeoutMs', { name: 'x', permission: 'read', maxOutputBytes: 1 }],
      ['缺 maxOutputBytes', { name: 'x', permission: 'read', timeoutMs: 1 }],
    ]) {
      let threw = ''
      try { createToolManifest(spec) } catch (e) { threw = String(e && e.message) }
      chk(label + ' → 报错（不允许默认宽松）', threw.length > 0, true)
    }
  }

  console.log('\n=== P5.5-04 路径沙箱：正常路径 ===')
  {
    chk('workspace 内的相对路径 → 允许', isInsideWorkspace(WS, 'src/a.mbt'), true)
    chk('workspace 根本身 → 允许', isInsideWorkspace(WS, '.'), true)
    const r = resolveInsideWorkspace(WS, 'src/a.mbt')
    chk('解析出绝对路径', [r.ok, path.resolve(r.path)], [true, path.join(WS, 'src', 'a.mbt')])
  }

  console.log('\n=== P5.5-04 路径沙箱：逃逸用例（安全测试）===')
  {
    chk('`../secret` → 拒', isInsideWorkspace(WS, '../secret'), false)
    chk('`a/../../b` → 拒（多次回退）', isInsideWorkspace(WS, path.join('a', '..', '..', 'b')), false)
    chk('绝对路径在 workspace 外 → 拒', isInsideWorkspace(WS, path.join(os.tmpdir(), 'other', 'x')), false)
    chk('**同前缀不同目录 → 拒**（防 startsWith 误判）', isInsideWorkspace(WS, WS + '-other/x'), false)
    chk('空 target → 拒', isInsideWorkspace(WS, ''), false)
    chk('空 root → 拒', isInsideWorkspace('', 'a'), false)

    const r1 = resolveInsideWorkspace(WS, '../secret')
    chk('越界时返回明确错误', [r1.ok, /越出 workspace/.test(String(r1.error))], [false, true])
    const r2 = resolveInsideWorkspace('', 'a')
    chk('未打开项目 → 拒', [r2.ok, /未打开项目/.test(String(r2.error))], [false, true])

    // 符号链接逃逸：workspace 里有个链接指向外部 → 字符串判断看不出，必须靠 realpath
    const fakeRealpath = (p) => (String(p).includes('link-out') ? path.join(os.tmpdir(), 'outside', 'secret.txt') : p)
    const r3 = resolveInsideWorkspace(WS, 'link-out', { realpath: fakeRealpath })
    chk('**符号链接指向外部 → 拒**（realpath 校验）', [r3.ok, /realpath/.test(String(r3.error))], [false, true])
    const r4 = resolveInsideWorkspace(WS, 'normal.txt', { realpath: fakeRealpath })
    chk('正常路径在 realpath 下仍允许', r4.ok, true)

    // 新建文件：目标不存在（realpath 抛错）→ 用父目录判定
    const throwForMissing = (p) => {
      if (String(p).endsWith('new.txt')) throw new Error('ENOENT')
      return p
    }
    const r5 = resolveInsideWorkspace(WS, 'new.txt', { realpath: throwForMissing })
    chk('新建文件（目标不存在）→ 用父目录判定通过', r5.ok, true)
  }

  console.log('\n=== P5.5-09 删除保护 ===')
  {
    chk('目标 = workspace 根 → 判为破坏性', isDestructiveTarget(WS, '.'), true)
    chk('目标 = 子目录 → 不算破坏整仓', isDestructiveTarget(WS, 'build'), false)
    chk('目标 = 上级 → 不算（会先被路径沙箱拦）', isDestructiveTarget(WS, '..'), false)
  }

  console.log('\n=== P5.5-05 命令沙箱 ===')
  {
    chk('白名单内（moon）→ 允许', checkCommand('moon', ['build']).ok, true)
    chk('白名单内（npm）→ 允许', checkCommand('npm', ['test']).ok, true)
    chk('带 .cmd 后缀也认（Windows）', checkCommand('npm.cmd', ['run', 'dev']).ok, true)

    for (const b of ['rm', 'del', 'format', 'shutdown']) {
      chk('禁用命令 ' + b + ' → 拒', checkCommand(b, []).ok, false)
    }
    chk('白名单外（curl）→ 拒', /白名单/.test(String(checkCommand('curl', []).error)), true)
    chk('破坏性参数 -rf → 拒', checkCommand('node', ['-rf', '/']).ok, false)
    chk('破坏性参数 --force → 拒', checkCommand('git', ['clean', '--force']).ok, false)
    chk('显式 allowDestructive 时放行（可配）', checkCommand('git', ['clean', '--force'], { allowDestructive: true }).ok, true)
    chk('自定义白名单生效', checkCommand('curl', ['-s', 'x'], { allow: ['curl'] }).ok, true)
    chk('DEFAULT_ALLOWED_BINS 不含危险命令', FORBIDDEN_BINS.every((b) => !DEFAULT_ALLOWED_BINS.includes(b)), true)
  }

  console.log('\n=== P5.5-08 预算（次数 + 总时长）===')
  {
    const b = createBudget({ maxCalls: 2, maxTotalMs: 1000 })
    chk('第 1 次允许', b.tryConsume().ok, true)
    chk('第 2 次允许', b.tryConsume().ok, true)
    chk('第 3 次拒绝', /最大调用次数/.test(String(b.tryConsume().error)), true)

    let t = 0
    const b2 = createBudget({ maxCalls: 10, maxTotalMs: 1000, now: () => t })
    chk('时间未到时允许', b2.tryConsume().ok, true)
    t = 1500
    chk('超过总时长 → 拒（不是跑完再说）', /最大总时长/.test(String(b2.tryConsume().error)), true)
  }

  console.log('\n=== P5.5-06/07 runTool（超时 + 输出限额）===')
  {
    const manifest = createToolManifest({ name: 'build', permission: PERMISSION.EXECUTE, timeoutMs: 100, maxOutputBytes: 10, danger: 'high' })

    const ok = await runTool(manifest, {}, { runCommand: async () => ({ code: 0, stdout: 'hi', stderr: '' }) })
    chk('正常执行', [ok.ok, ok.code, ok.stdout], [true, 0, 'hi'])

    const big = await runTool(manifest, {}, { runCommand: async () => ({ code: 0, stdout: 'X'.repeat(500), stderr: 'Y'.repeat(500) }) })
    chk('**输出超限 → 截断**', [big.stdout.length, big.stderr.length, big.clipped], [10, 10, true])

    const to = await runTool(manifest, {}, { runCommand: async () => { throw new Error('命令超时（100ms）：build') } })
    chk('超时 → ok:false + 原因', [to.ok, /超时/.test(String(to.error))], [false, true])

    let called = 0
    const budget = createBudget({ maxCalls: 1, maxTotalMs: 10000 })
    await runTool(manifest, {}, { runCommand: async () => { called++; return { code: 0 } }, budget })
    const blocked = await runTool(manifest, {}, { runCommand: async () => { called++; return { code: 0 } }, budget })
    chk('**预算耗尽后不再真的执行**', [blocked.ok, called], [false, 1])

    const noRun = await runTool(manifest, {}, {})
    chk('没注入 runCommand → 明确报错', [noRun.ok, /runCommand/.test(String(noRun.error))], [false, true])
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('单测异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
