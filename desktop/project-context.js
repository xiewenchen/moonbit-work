'use strict'

/**
 * ProjectContext —— 全 IDE 的**单一工程上下文**（Phase 2 / MBW-P2-02、P2-03、P2-05）
 *
 * 存在的原因（P2-01 盘点结论，见 docs/changes/phase2-p2-context-inventory.md）：
 *   同一个事实「当前项目是什么」此前散在**四处**，且互不同步：
 *     · `cwdInput.value`        —— 真正喂给各 IPC 的根（读取点 14 处）
 *     · `rootDir`               —— 只在内存里存一份，且**只被读过一次**（renderer.js:82）
 *     · `projectInfoCache.root` —— `project:info` 的结果
 *     · `lspRoot`               —— 启动 LSP 时的根（又一份）
 *   而且 main.js 里 `cwd || DEFAULT_CWD` 这段回退**被复制了近十次**，各 handler 各自为政。
 *   本模块把它收敛成唯一结构，供 Runner / LSP / Terminal / API / Problems / Agent 共用。
 *
 * 本文件只做「定义 + 纯函数推导」：不碰文件系统、不 require electron ——
 * 所以能纯 Node 单测（也就能在 Linux CI 上守）。**本轮只建接口，不迁移调用点**（RULE-04）。
 */

// ── P2-03 项目类型 ────────────────────────────────────────────────────────────
const PROJECT_TYPE = Object.freeze({
  MOONBIT: 'moonbit',
  NODE: 'node',
  PYTHON: 'python',
  RUST: 'rust',
  GO: 'go',
  JAVA: 'java',
  STATIC: 'static',
  UNKNOWN: 'unknown',
})

const ALL_TYPES = Object.freeze(Object.values(PROJECT_TYPE))

/** 每种类型的缺省语言 / 包管理器 / 三条命令（调用方可用 overrides 覆盖）*/
const TYPE_SPEC = Object.freeze({
  [PROJECT_TYPE.MOONBIT]: {
    label: 'MoonBit 模块', language: 'moonbit', packageManager: 'moon',
    buildCommand: 'moon build --target native', runCommand: 'moon run --target native <entry>', testCommand: 'moon test --target native',
  },
  [PROJECT_TYPE.NODE]: {
    label: 'Node / JavaScript 项目', language: 'javascript', packageManager: 'npm',
    buildCommand: 'npm run build', runCommand: 'npm start', testCommand: 'npm test',
  },
  [PROJECT_TYPE.PYTHON]: {
    label: 'Python 项目', language: 'python', packageManager: 'pip',
    buildCommand: '', runCommand: 'python main.py', testCommand: 'pytest',
  },
  [PROJECT_TYPE.RUST]: {
    label: 'Rust 项目', language: 'rust', packageManager: 'cargo',
    buildCommand: 'cargo build', runCommand: 'cargo run', testCommand: 'cargo test',
  },
  [PROJECT_TYPE.GO]: {
    label: 'Go 项目', language: 'go', packageManager: 'go',
    buildCommand: 'go build ./...', runCommand: 'go run .', testCommand: 'go test ./...',
  },
  [PROJECT_TYPE.JAVA]: {
    label: 'Java 项目', language: 'java', packageManager: 'maven',
    buildCommand: 'mvn package', runCommand: 'mvn spring-boot:run', testCommand: 'mvn test',
  },
  [PROJECT_TYPE.STATIC]: {
    label: '静态站点', language: 'html', packageManager: '',
    buildCommand: '', runCommand: 'python -m http.server', testCommand: '',
  },
  [PROJECT_TYPE.UNKNOWN]: {
    label: '未知类型', language: '', packageManager: '',
    buildCommand: '', runCommand: '', testCommand: '',
  },
})

/** 把各种写法（'MoonBit' / 'MOONBIT' / 'node' / 未知串）归一到 PROJECT_TYPE 之一 */
function normalizeType(kind) {
  if (kind == null) return PROJECT_TYPE.UNKNOWN
  const s = String(kind).trim().toLowerCase()
  return ALL_TYPES.includes(s) ? s : PROJECT_TYPE.UNKNOWN
}

/** 去尾部斜杠；但别把驱动器根截掉（`C:\` 不能变成 `C:`）*/
function normalizeRoot(root) {
  if (root == null) return ''
  let s = String(root).trim().replace(/[\\/]+$/, '')
  if (/^[A-Za-z]:$/.test(s)) s += '\\'   // 驱动器根补反斜杠（Windows）
  return s
}

// ── P2-02 / P2-05 ProjectContext 与 Factory ───────────────────────────────────
/**
 * 由「识别结果」造出上下文。
 * @param {{root?:string, kind?:string, label?:string, features?:object}} info  —— detectProject() 的产物
 * @param {object} [overrides] —— 调用方已知更精确的信息（entry / activeFile / 自定义命令…）
 */
function createProjectContext(info = {}, overrides = {}) {
  const rootDir = normalizeRoot(overrides.rootDir != null ? overrides.rootDir : info.root)
  const projectType = normalizeType(overrides.projectType != null ? overrides.projectType : info.kind)
  const spec = TYPE_SPEC[projectType]
  const features = Object.assign({}, info.features || {}, overrides.features || {})

  return Object.freeze({
    rootDir,
    projectType,
    label: overrides.label || info.label || spec.label,
    entry: overrides.entry != null ? overrides.entry : null,
    language: overrides.language || spec.language,
    packageManager: overrides.packageManager || spec.packageManager,
    buildCommand: overrides.buildCommand || spec.buildCommand,
    runCommand: overrides.runCommand || spec.runCommand,
    testCommand: overrides.testCommand || spec.testCommand,
    activeFile: overrides.activeFile != null ? overrides.activeFile : null,
    features: Object.freeze(features),
    createdAt: typeof overrides.createdAt === 'number' ? overrides.createdAt : Date.now(),
  })
}

/** 空上下文（对应「无项目态」，P2-16）*/
function emptyContext(overrides = {}) {
  return createProjectContext({ root: '', kind: PROJECT_TYPE.UNKNOWN }, overrides)
}

/** 是否真的打开了项目 —— 「无项目态」的唯一判据（P2-16）*/
function hasProject(ctx) {
  return !!ctx && typeof ctx.rootDir === 'string' && ctx.rootDir.length > 0
}

/** 两个上下文是否指向同一个项目（多项目切换时判断「要不要重新初始化」，P2-17）*/
function isSameProject(a, b) {
  if (!a || !b) return false
  return normalizeRoot(a.rootDir) === normalizeRoot(b.rootDir) && a.projectType === b.projectType
}

/** 换一个 activeFile，其余保持（不可变对象 → 换出新的）*/
function withActiveFile(ctx, file) {
  return createProjectContext(
    { root: ctx && ctx.rootDir, kind: ctx && ctx.projectType, label: ctx && ctx.label, features: ctx && ctx.features },
    {
      rootDir: ctx && ctx.rootDir,
      projectType: ctx && ctx.projectType,
      label: ctx && ctx.label,
      entry: ctx ? ctx.entry : null,
      language: ctx && ctx.language,
      packageManager: ctx && ctx.packageManager,
      buildCommand: ctx && ctx.buildCommand,
      runCommand: ctx && ctx.runCommand,
      testCommand: ctx && ctx.testCommand,
      activeFile: file,
      createdAt: ctx ? ctx.createdAt : undefined,
    },
  )
}

/** 一行摘要（日志 / 状态栏 / 调试用）*/
function describeContext(ctx) {
  if (!hasProject(ctx)) return '（无项目）'
  return `${ctx.label}（${ctx.projectType}）@ ${ctx.rootDir}`
}

const API = {
  PROJECT_TYPE,
  ALL_TYPES,
  TYPE_SPEC,
  normalizeType,
  normalizeRoot,
  createProjectContext,
  emptyContext,
  hasProject,
  isSameProject,
  withActiveFile,
  describeContext,
}

// 双环境导出：
//   · Node（单测 / CI / 主进程）走 CommonJS；
//   · 渲染进程通过 index.html 的 <script> 引入后取全局 —— 因为 preload 是 sandbox:true，
//     **不能 require 本地文件**（实测：那样会让整个 preload 挂掉、window.moonAPI 变 undefined）。
if (typeof module !== 'undefined' && module.exports) module.exports = API
if (typeof window !== 'undefined') window.moonbitProjectContext = API
