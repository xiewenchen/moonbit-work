'use strict'

/**
 * Command Registry（Phase 2 / MBW-P3-01 ～ P3-08、P3-13 ～ P3-15）
 *
 * 目的（清单 Gate P3）：**同一个动作**（UI 按钮 / 菜单 / 快捷键 / 未来的 Agent）
 * 最终都走**同一个 Command** —— 不再各自实现一份。
 *
 * 本文件是**纯逻辑**：不 require electron、不直接 spawn。
 * 外部能力（runner、跑命令、判目录存在）全部由参数注入 —— 所以能纯 Node 单测，
 * 也就能进 Linux CI（真跑 `moon build` 的环境不在 CI 上，这点很重要）。
 */

/** 权限等级（与 P5.5 的 READ / EXECUTE / WRITE 对齐）*/
const COMMAND_PERMISSIONS = Object.freeze(['read', 'execute', 'write'])

/** 命令缺省超时：60s（单个命令可在注册时覆盖）*/
const DEFAULT_TIMEOUT_MS = 60000

// ── P3-03 CommandResult ───────────────────────────────────────────────────────
/** 把任意 handler 返回值规范成统一结果 */
function commandResult(input = {}) {
  const ok = !!input.ok
  return {
    ok,
    code: typeof input.code === 'number' ? input.code : (ok ? 0 : 1),
    data: input.data === undefined ? null : input.data,
    stdout: String(input.stdout == null ? '' : input.stdout),
    stderr: String(input.stderr == null ? '' : input.stderr),
    duration: typeof input.duration === 'number' ? input.duration : null,
    error: input.error == null ? null : String(input.error),
  }
}

// ── P3-14 超时 ────────────────────────────────────────────────────────────────
/** 给一个 Promise 套执行超时；超时抛错（由 execute 统一转成失败结果）*/
function withTimeout(promise, ms, name) {
  if (!(ms > 0)) return Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`命令超时（${ms}ms）：${name}`)), ms)
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

// ── P3-01 / P3-02 注册表 ──────────────────────────────────────────────────────
/**
 * @param {{logger?: (entry: object) => void}} [opts]
 */
function createCommandRegistry({ logger } = {}) {
  const commands = new Map()
  const log = typeof logger === 'function' ? logger : () => {}

  /** 注册一个命令。name / handler 必填；重复注册直接报错（早暴露比晚发现好）*/
  function register(spec) {
    if (!spec || typeof spec.name !== 'string' || spec.name.trim() === '') {
      throw new Error('command 必须有非空的 name')
    }
    const name = spec.name.trim()
    if (typeof spec.handler !== 'function') {
      throw new Error('command ' + name + ' 必须有 handler')
    }
    if (commands.has(name)) {
      throw new Error('command 已注册：' + name)
    }
    const perms = Array.isArray(spec.permissions) && spec.permissions.length ? spec.permissions : ['read']
    for (const p of perms) {
      if (!COMMAND_PERMISSIONS.includes(p)) throw new Error('未知权限：' + p + '（可用：' + COMMAND_PERMISSIONS.join('/') + '）')
    }
    const cmd = Object.freeze({
      name,
      title: spec.title || name,
      permissions: Object.freeze(perms.slice()),
      timeoutMs: typeof spec.timeoutMs === 'number' ? spec.timeoutMs : DEFAULT_TIMEOUT_MS,
      danger: spec.danger === true,
      handler: spec.handler,
    })
    commands.set(name, cmd)
    log({ phase: 'register', command: name, permissions: cmd.permissions, timeoutMs: cmd.timeoutMs })
    return cmd
  }

  /** 清单（给 UI / Agent 看的能力清单；不含 handler）*/
  function list() {
    return Array.from(commands.values()).map((c) => ({
      name: c.name,
      title: c.title,
      permissions: c.permissions.slice(),
      timeoutMs: c.timeoutMs,
      danger: c.danger,
    }))
  }

  function has(name) { return commands.has(name) }
  function get(name) { return commands.get(name) || null }

  /**
   * 执行一个命令。**永不抛错** —— 任何异常都转成 { ok:false, error }，
   * 这样 UI / Agent 侧只有一条处理路径。
   */
  async function execute(name, args = {}, opts = {}) {
    const started = Date.now()
    const cmd = commands.get(name)
    if (!cmd) {
      const r = commandResult({ ok: false, error: '未知命令：' + name, duration: Date.now() - started })
      log({ phase: 'unknown', command: name })
      return r
    }
    log({ phase: 'start', command: name, args })

    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : cmd.timeoutMs
    try {
      const raw = await withTimeout(Promise.resolve().then(() => cmd.handler(args, opts)), timeoutMs, name)
      const r = (raw && typeof raw === 'object' && 'ok' in raw) ? commandResult(raw) : commandResult({ ok: true, data: raw === undefined ? null : raw })
      r.duration = Date.now() - started
      log({ phase: 'finish', command: name, ok: r.ok, duration: r.duration })
      return r
    } catch (e) {
      const r = commandResult({ ok: false, error: String((e && e.message) || e), duration: Date.now() - started })
      log({ phase: 'error', command: name, ok: false, duration: r.duration, error: r.error })
      return r
    }
  }

  return { register, list, has, get, execute }
}

// ── P3-04 ～ P3-08 六个项目命令 ───────────────────────────────────────────────
/** 按项目类型给出「编译 / 测试」的命令行 */
function buildCommandFor(kind) {
  const t = String(kind || '').toLowerCase()
  if (t === 'node') return { bin: 'npm', args: ['run', 'build'] }
  if (t === 'rust') return { bin: 'cargo', args: ['build'] }
  if (t === 'go') return { bin: 'go', args: ['build', './...'] }
  return { bin: 'moon', args: ['build', '--target', 'native'] }
}
function testCommandFor(kind) {
  const t = String(kind || '').toLowerCase()
  if (t === 'node') return { bin: 'npm', args: ['test'] }
  if (t === 'rust') return { bin: 'cargo', args: ['test'] }
  if (t === 'go') return { bin: 'go', args: ['test', './...'] }
  return { bin: 'moon', args: ['test', '--target', 'native'] }
}

/**
 * 把 6 个项目命令注册进去。依赖全部注入，便于单测：
 * @param {object} registry
 * @param {{
 *   runner: {start:Function, stop:Function, state?:string},
 *   runCmd: (spec: {bin:string,args:string[],cwd:string,timeoutMs?:number}) => Promise<{code:number,stdout:string,stderr:string}>,
 *   pathExists?: (p: string) => boolean,
 *   rootOf: (input: any) => string,
 * }} deps
 */
function registerProjectCommands(registry, deps = {}) {
  const { runner, runCmd, rootOf } = deps
  const pathExists = typeof deps.pathExists === 'function' ? deps.pathExists : () => true
  // 命令启动的进程也必须能把输出/URL 推给界面 —— 与 runner:run IPC 共用同一套 handlers
  const runnerHandlers = deps.runnerHandlers || {}
  if (!registry || typeof registry.register !== 'function') throw new Error('registerProjectCommands 需要 registry')
  if (!runner) throw new Error('registerProjectCommands 需要 runner')
  if (typeof runCmd !== 'function') throw new Error('registerProjectCommands 需要 runCmd')
  if (typeof rootOf !== 'function') throw new Error('registerProjectCommands 需要 rootOf')

  // ① 打开项目：主进程侧只做「解析 + 校验」，真正的 UI 动作（加载树/切视图）在渲染侧。
  //    这样 Agent 也能拿到一个可调用的 open（P6）。
  registry.register({
    name: 'project.open',
    title: '打开项目',
    permissions: ['read'],
    timeoutMs: 10000,
    handler: async (args = {}) => {
      const dir = String(args.dir || args.path || '').trim()
      if (!dir) return commandResult({ ok: false, error: '缺少目录（args.dir）' })
      if (!pathExists(dir)) return commandResult({ ok: false, error: '目录不存在：' + dir })
      const rootDir = rootOf(dir)
      return commandResult({ ok: true, data: { rootDir } })
    },
  })

  // ② 关闭项目：主进程侧负责「停掉还活着的运行实例」，UI 动作同样在渲染侧。
  registry.register({
    name: 'project.close',
    title: '关闭项目',
    permissions: ['write'],
    timeoutMs: 10000,
    handler: async () => {
      const r = runner.stop()
      return commandResult({ ok: true, data: r })
    },
  })

  // ③ 编译（危险：会长时间占资源）
  registry.register({
    name: 'project.build',
    title: '编译项目',
    permissions: ['execute'],
    timeoutMs: 10 * 60 * 1000,
    danger: true,
    handler: async (args = {}) => {
      const cwd = rootOf(args.ctx || args.root)
      if (!cwd) return commandResult({ ok: false, error: '未打开项目' })
      const kind = args.projectType || (args.ctx && args.ctx.projectType)
      const spec = buildCommandFor(kind)
      const r = await runCmd({ bin: spec.bin, args: spec.args, cwd })
      return commandResult({
        ok: r.code === 0,
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        error: r.code === 0 ? null : '编译失败（退出码 ' + r.code + '）',
      })
    },
  })

  // ④ 运行（启动服务；"启动成功"不等于"服务就绪"，就绪由 URL 检测决定）
  registry.register({
    name: 'project.run',
    title: '运行项目',
    permissions: ['execute'],
    timeoutMs: 20000,
    handler: async (args = {}) => {
      const spec = args.spec || args
      if (!spec || !spec.bin) return commandResult({ ok: false, error: '缺少可运行入口（args.spec.bin）' })
      const r = runner.start(
        { bin: spec.bin, args: spec.args, cwd: spec.cwd, label: spec.label },
        args.handlers || runnerHandlers,
      )
      return commandResult({
        ok: r.ok !== false,
        data: { pid: r.pid, state: runner.state },
        error: r.ok === false ? (r.error || '启动失败') : null,
      })
    },
  })

  // ⑤ 停止
  registry.register({
    name: 'project.stop',
    title: '停止运行',
    permissions: ['execute'],
    timeoutMs: 15000,
    handler: async () => {
      const r = runner.stop()
      return commandResult({
        ok: r.ok !== false,
        data: r,
        error: r.ok === false ? (r.error || '没有正在运行的进程') : null,
      })
    },
  })

  // ⑥ 测试
  registry.register({
    name: 'project.test',
    title: '跑测试',
    permissions: ['execute'],
    timeoutMs: 10 * 60 * 1000,
    danger: true,
    handler: async (args = {}) => {
      const cwd = rootOf(args.ctx || args.root)
      if (!cwd) return commandResult({ ok: false, error: '未打开项目' })
      const kind = args.projectType || (args.ctx && args.ctx.projectType)
      const spec = testCommandFor(kind)
      const r = await runCmd({ bin: spec.bin, args: spec.args, cwd })
      return commandResult({
        ok: r.code === 0,
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        error: r.code === 0 ? null : '测试失败（退出码 ' + r.code + '）',
      })
    },
  })

  return registry
}

// ── P3-09 ～ P3-12 的接线入口：让渲染侧也能走命令表 ──────────────────────────
/**
 * 暴露两个 IPC：`command:list`（给 UI 与未来的 Agent 看能力清单）与 `command:execute`。
 * ipcMain 由参数注入 —— 本文件仍不 require electron，保持可纯 Node 测。
 */
function registerCommandIpc({ ipcMain, registry }) {
  if (!ipcMain || !registry) throw new Error('registerCommandIpc 需要 ipcMain 与 registry')
  ipcMain.handle('command:list', () => ({ ok: true, commands: registry.list() }))
  ipcMain.handle('command:execute', (_e, payload = {}) =>
    registry.execute(payload.name, payload.args || {}, payload.opts || {}))
}

module.exports = {
  COMMAND_PERMISSIONS,
  DEFAULT_TIMEOUT_MS,
  commandResult,
  withTimeout,
  createCommandRegistry,
  registerProjectCommands,
  registerCommandIpc,
  buildCommandFor,
  testCommandFor,
}
