'use strict'

/**
 * BackendProjectContext 单测（Phase 2.1 / P14-01）
 *
 * 纯 Node。断言用公共 verify-harness。
 * 重点是两条"不猜"：**端口推不出就是 null（且记来源）**、**没探过活就不假定健康**。
 */

const { createHarness } = require('./verify-harness')
const {
  extractPortFromCommand,
  isBackendLike,
  inferPort,
  createBackendContext,
  healthUrl,
  describeBackendContext,
} = require('./backend-context')
const { createProjectContext } = require('./project-context')

const H = createHarness()
const { chk, eq } = H

async function main() {
  console.log('\n=== ① 从命令里抽端口 ===')
  {
    eq('--port 8080', extractPortFromCommand('moon run ./cmd/main --port 8080'), 8080)
    eq('-p 3000', extractPortFromCommand('node server.js -p 3000'), 3000)
    eq('★ 不把 `:` 当端口（否则 12:30 这种时间会被当端口）', extractPortFromCommand('curl http://127.0.0.1:8123'), null)
    eq('时间形式不会被当端口', extractPortFromCommand('会议 12:30 开始'), null)
    eq('没有端口 → null', extractPortFromCommand('moon build --release'), null)
    eq('空 → null', extractPortFromCommand(''), null)
    eq('null → null', extractPortFromCommand(null), null)
    eq('超范围 → null', extractPortFromCommand('--port 99999'), null)
    eq('不误抓普通数字', extractPortFromCommand('moon test -v 2026'), null)
  }

  console.log('\n=== ② 判断"像不像后端项目"（只凭能指出来的依据）===')
  {
    const svc = createProjectContext({ root: 'C:/p/svc', kind: 'moonbit' })
    chk('moonbit + runCommand → 是', isBackendLike(svc) === true)

    // 没有 runCommand 的类型（比如 static）不算
    const stat = createProjectContext({ root: 'C:/p/site', kind: 'static' })
    chk('static 类型 → 否', isBackendLike(stat) === false)

    chk('没打开项目 → 否', isBackendLike(null) === false)
    chk('空对象 → 否', isBackendLike({}) === false)

    // java/静态站之类的：有 runCommand 也算
    const node = createProjectContext({ root: 'C:/p/api', kind: 'node' })
    chk('node 后端 → 是', isBackendLike(node) === true)
  }

  console.log('\n=== ③ 端口推断：每一步都记来源（不猜）===')
  {
    const pc = createProjectContext({ root: 'C:/p/svc', kind: 'moonbit' })
    eq('① 显式传入优先', inferPort(pc, { port: 9999 }), { port: 9999, source: 'explicit' })

    const withRun = Object.assign({}, pc, { runCommand: 'bundle exec rails server -p 4000' })
    eq('② 从 runCommand 抽', inferPort(withRun), { port: 4000, source: 'runCommand' })

    const withBuild = Object.assign({}, pc, { buildCommand: 'docker build --port 5001' })
    eq('③ 退到 buildCommand', inferPort(withBuild), { port: 5001, source: 'buildCommand' })

    eq('④ 兜底默认值（会标明 default）', inferPort(pc, { defaultPort: 8080 }), { port: 8080, source: 'default' })
    eq('★ 推不出就是 null（不编一个）', inferPort(pc), { port: null, source: 'unknown' })
  }

  console.log('\n=== ④ 组装 BackendProjectContext ===')
  {
    const pc = createProjectContext({ root: 'C:/p/svc', kind: 'moonbit' })
    const ctx = createBackendContext(pc, { port: 8123 })
    chk('对象被冻结', Object.isFrozen(ctx))
    eq('绑定了根目录', ctx.rootDir, 'C:/p/svc')
    eq('标出像后端', ctx.backendLike, true)
    eq('端口与来源', [ctx.port, ctx.portSource], [8123, 'explicit'])
    eq('★ 没探过活 → health 为 null（不假定健康）', ctx.health, null)
    eq('没查过 PG → database 为 null（不是"ok"）', ctx.database, null)
    eq('没查过 Redis → redis 为 null', ctx.redis, null)
    chk('命令三件套在里面', typeof ctx.commands === 'object' && 'run' in ctx.commands)
  }

  console.log('\n=== ⑤ 健康检查结果被归一（含失败）===')
  {
    const pc = createProjectContext({ root: 'C:/p/svc', kind: 'moonbit' })
    const ok = createBackendContext(pc, { port: 8123, health: { ok: true, status: 200, latencyMs: 12, url: 'http://127.0.0.1:8123/health' } })
    eq('健康时 ok=true', [ok.health.ok, ok.health.status, ok.health.latencyMs], [true, 200, 12])

    const bad = createBackendContext(pc, { port: 8123, health: { ok: false, status: 500, error: 'boom' } })
    eq('★ 不健康时如实（ok=false）', [bad.health.ok, bad.health.status], [false, 500])
    chk('  带上原因', /boom/.test(String(bad.health.error)))

    // 依赖服务
    const withDeps = createBackendContext(pc, { database: { ok: true }, redis: { ok: false, note: 'no container' } })
    eq('PG 状态被记下', withDeps.database, { kind: 'postgresql', ok: true, note: null })
    eq('Redis 状态被记下（含备注）', [withDeps.redis.ok, withDeps.redis.note], [false, 'no container'])
  }

  console.log('\n=== ⑥ 健康检查 URL 与一行摘要 ===')
  {
    const pc = createProjectContext({ root: 'C:/p/svc', kind: 'moonbit' })
    const ctx = createBackendContext(pc, { port: 8123 })
    eq('拼出 URL', healthUrl(ctx), 'http://127.0.0.1:8123/health')
    eq('可换路径', healthUrl(ctx, 'api/tags'), 'http://127.0.0.1:8123/api/tags')
    eq('★ 没端口就拼不出（返回 null，不瞎拼）', healthUrl(createBackendContext(pc)), null)

    const line = describeBackendContext(ctx)
    chk('摘要含端口与来源', /端口=8123\(explicit\)/.test(line), line)
    chk('摘要含"未探活"', /未探活/.test(line), line)
    chk('摘要标明 pg/redis 未检', /pg未检/.test(line) && /redis未检/.test(line), line)
    chk('无换行', !/[\r\n]/.test(line))
    eq('null 也不崩', describeBackendContext(null), '（无后端上下文）')
  }

  console.log('\n' + H.summary())
  process.exit(H.exitCode())
}

main().catch((e) => {
  console.log('\n[FATAL] ' + String((e && e.stack) || e))
  process.exit(1)
})
