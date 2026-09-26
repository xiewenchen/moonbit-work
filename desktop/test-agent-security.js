// PH3-SEC-10～13：Agent 安全的**行为**测试（不是文档、也不是再数一遍漏洞）。
//
// 这四项容易只写文档不写测试，所以单独拎出来做：
//   SEC-10 Command 参数 Injection
//   SEC-11 Tool 超时
//   SEC-12 无限循环（必须有硬上限）
//   SEC-13 Cancel（预算/上限用尽后必须**真的停**，不能"再跑一次看看"）
//
// 纯 Node、全注入 —— 不起真进程、不联网，所以能进 CI。
async function main() {
const { createHarness } = require('./verify-harness')
const { quoteForCmd, resolveSpawn } = require('./spawn-util')
const { createToolManifest, createBudget, runTool } = require('./agent-sandbox')
const { runToolLoop } = require('./agent-adapter')
const { createMockLlm } = require('./mock-llm')

const H = createHarness()
const { chk, eq } = H

console.log('=== ① SEC-10 命令注入：控制字符必须被拒 ===')
{
  // 换行/回车/NUL 是"把一条命令拆成两条"的经典手法
  for (const bad of ['a\nb', 'a\rb', 'a\r\nb', 'a\u0000b']) {
    let threw = false
    try { quoteForCmd(bad) } catch (e) { threw = true }
    chk('★ 拒 ' + JSON.stringify(bad), threw === true)
  }
  // resolveSpawn 的**先验参**：不管走不走 shell、哪个平台都拒
  let t2 = false
  try { resolveSpawn('node', ['x\nrm -rf /']) } catch (e) { t2 = true }
  chk('★ resolveSpawn 也拒换行参数（先验参，与平台无关）', t2 === true)

  chk('普通参数原样', quoteForCmd('main.mbt') === 'main.mbt')
  chk('带空格 → 加引号', quoteForCmd('my file.mbt') === '"my file.mbt"')
}

console.log('\n=== ② SEC-10 shell 元字符必须被引号包住（否则能拼出第二条命令）===')
{
  // 这些字符在 cmd.exe / sh 下都可能变成"命令分隔/重定向"
  const metas = ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a(b)', 'a%PATH%b', 'a!b', 'a"b']
  for (const m of metas) {
    const q = quoteForCmd(m)
    chk('★ ' + JSON.stringify(m) + ' 被包起来', q.startsWith('"') && q.endsWith('"'), q)
  }
  // 最有攻击性的：`x & del /f /q C:\*`
  const evil = 'x & del /f /q C:\\*'
  const quoted = quoteForCmd(evil)
  chk('★ 典型注入串 `x & del …` 整串被引号包住', quoted === '"' + evil + '"', quoted)
  chk('  引号内的引号被加倍（cmd 的转义约定）', quoteForCmd('a"b') === '"a""b"', quoteForCmd('a"b'))
}

console.log('\n=== ③ SEC-11 工具必须有正的超时（不允许"没有超时"的工具）===')
{
  chk('缺 timeoutMs → 建 manifest 就抛', (() => { try { createToolManifest({ name: 'x' }); return false } catch (_) { return true } })())
  chk('timeoutMs=0 → 抛', (() => { try { createToolManifest({ name: 'x', permission: 'read', timeoutMs: 0 }); return false } catch (_) { return true } })())
  chk('timeoutMs=-1 → 抛', (() => { try { createToolManifest({ name: 'x', permission: 'read', timeoutMs: -1 }); return false } catch (_) { return true } })())
  chk('timeoutMs 非数字 → 抛', (() => { try { createToolManifest({ name: 'x', permission: 'read', timeoutMs: 'soon' }); return false } catch (_) { return true } })())
  const ok = createToolManifest({ name: 'readFile', permission: 'read', timeoutMs: 5000, maxOutputBytes: 1024 })
  eq('正的 timeoutMs 被保留', ok.timeoutMs, 5000)
  chk('  且缺 maxOutputBytes 也会抛（输出必须限额）', (() => { try { createToolManifest({ name: 'x', permission: 'read', timeoutMs: 100 }); return false } catch (_) { return true } })())
}

console.log('\n=== ④ SEC-11 timeoutMs 必须真的传到底层执行器 ===')
{
  let seen = null
  const m = createToolManifest({ name: 'slow', permission: 'read', timeoutMs: 12345, maxOutputBytes: 100 })
  const r = await runTool(m, { bin: 'x' }, {
    runCommand: async (spec, opts) => { seen = opts && opts.timeoutMs; return { code: 0, stdout: 'ok' } },
  })
  eq('★ 底层收到的正是 manifest 里的 timeoutMs', seen, 12345)
  eq('  执行成功如实返回', r.ok, true)

  // 执行器抛（比如它自己超时了）→ runTool 如实失败，不假装成功
  const r2 = await runTool(m, {}, { runCommand: async () => { throw new Error('超时被杀掉') } })
  eq('★ 执行器抛错 → ok:false', r2.ok, false)
  chk('  错误信息带出来', /被杀掉/.test(String(r2.error)), String(r2.error))
  chk('  带耗时（便于判断是不是超时）', typeof r2.duration === 'number', String(r2.duration))

  // 输出超过限额 → 必须被裁剪，并**标记** clipped
  const m2 = createToolManifest({ name: 'chatty', permission: 'read', timeoutMs: 100, maxOutputBytes: 10 })
  const r3 = await runTool(m2, {}, { runCommand: async () => ({ code: 0, stdout: 'x'.repeat(500) }) })
  eq('★ 输出被裁到限额', r3.stdout.length, 10)
  eq('  ★ 且标了 clipped（不假装输出就这么短）', r3.clipped, true)
}

console.log('\n=== ⑤ SEC-12 无限循环：必须有硬上限（maxSteps）===')
{
  // 一个"永远想调工具"的模型 —— 没有上限的话会转到天荒地老
  let calls = 0
  const greedy = {
    async generate() {
      calls++
      return { ok: true, text: '', toolCalls: [{ name: 'readFile', args: { path: 'a' } }] }
    },
  }
  const r = await runToolLoop({
    llm: greedy,
    tools: { call: async () => ({ ok: true, data: 'x' }) },
    messages: [{ role: 'user', content: 'go' }],
    maxSteps: 3,
  })
  eq('★ 到上限就停（stopped=maxSteps）', r.stopped, 'maxSteps')
  eq('  模型调用次数正好等于上限', r.modelCalls, 3)
  eq('★ 没有无限转下去', calls, 3)
  chk('  且 ok:false（不伪装成功）', r.ok === false, String(r.ok))
  chk('  错误信息说明是达到上限', /最大步数/.test(String(r.error)), String(r.error))

  // 默认上限是 8 —— 不传也不能无限
  const r2 = await runToolLoop({
    llm: greedy,
    tools: { call: async () => ({ ok: true }) },
    messages: [{ role: 'user', content: 'go' }],
  })
  eq('★ 不传 maxSteps 也有默认上限 8', r2.stopped, 'maxSteps')
  eq('  恰好 8 次', r2.modelCalls, 8)
}

console.log('\n=== ⑥ SEC-12/13 预算用尽 = 一种 Cancel：必须真的停 ===')
{
  // 工具预算 2 次：第 3 次前就该被拦
  const budget = createBudget({ maxCalls: 2, maxTotalMs: 60000 })
  let toolRuns = 0
  const r = await runToolLoop({
    llm: {
      async generate() {
        return { ok: true, text: '', toolCalls: [{ name: 'readFile', args: {} }] }
      },
    },
    tools: {
      call: async () => { toolRuns++; return { ok: true } },
    },
    messages: [{ role: 'user', content: 'go' }],
    maxSteps: 50,          // 故意给很大的步数，看**预算**能不能独立拦住
    budget,
  })
  eq('★ 预算拦住（stopped=budget）—— 不是靠 maxSteps 兜', r.stopped, 'budget')
  chk('  错误说明是预算问题', /最大调用次数/.test(String(r.error)), String(r.error))
  eq('★ 工具只真的跑了 2 次（第 3 次前就被拒）', toolRuns, 2)
  chk('  ★ 没有"再跑一次看看"', toolRuns <= 2, String(toolRuns))

  // 预算拒绝后不执行：直接测 budget + runTool 的组合
  const b2 = createBudget({ maxCalls: 1 })
  const m = createToolManifest({ name: 'x', permission: 'read', timeoutMs: 100, maxOutputBytes: 10 })
  let ran = 0
  const run1 = await runTool(m, {}, { budget: b2, runCommand: async () => { ran++; return { code: 0, stdout: '' } } })
  const run2 = await runTool(m, {}, { budget: b2, runCommand: async () => { ran++; return { code: 0, stdout: '' } } })
  eq('第一次允许', run1.ok, true)
  eq('★ 第二次被预算拒', run2.ok, false)
  eq('★ 被拒时**底层根本没被调用**', ran, 1)
  chk('  错误说明原因', /最大调用次数/.test(String(run2.error)), String(run2.error))
}

console.log('\n=== ⑦ SEC-13 Cancel：总时长预算也能停（不是只有次数）===')
{
  // 用注入的时钟：不真等，但语义是真的
  let now = 0
  const budget = createBudget({ maxCalls: 100, maxTotalMs: 1000, now: () => now })
  eq('开始时可消费', budget.tryConsume().ok, true)
  now = 5000                      // 时间跳过去
  const over = budget.tryConsume()
  eq('★ 总时长超了 → 拒绝', over.ok, false)
  chk('  原因写明是时长', /最大总时长/.test(String(over.error)), String(over.error))

  // runToolLoop 走时间预算也会停
  const budget2 = createBudget({ maxCalls: 100, maxTotalMs: 0 })
  const r = await runToolLoop({
    llm: { async generate() { return { ok: true, text: '', toolCalls: [{ name: 'readFile', args: {} }] } } },
    tools: { call: async () => ({ ok: true }) },
    messages: [{ role: 'user', content: 'go' }],
    maxSteps: 50,
    budget: budget2,
  })
  eq('★ 时间预算 0 → 立刻停（stopped=budget）', r.stopped, 'budget')
  chk('  不是无限转', r.modelCalls <= 1, String(r.modelCalls))
}

console.log('\n=== ⑧ SEC-12 正常任务不受影响（上限定得再严也不能误伤）===')
{
  // 模型一次就给答案 → 不该触到任何上限
  const oneShot = createMockLlm({ scenario: 'plain' })
  const r = await runToolLoop({
    llm: oneShot,
    tools: { call: async () => ({ ok: true }) },
    messages: [{ role: 'user', content: 'hi' }],
    maxSteps: 8,
    budget: createBudget({ maxCalls: 8 }),
  })
  chk('★ 直接给答案 → stopped=done', r.stopped === 'done', String(r.stopped))
  chk('  且 ok:true', r.ok === true, String(r.ok))
  eq('  只调了一次模型', r.modelCalls, 1)
  eq('  一次工具都没调', (r.steps || []).length, 0)
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
