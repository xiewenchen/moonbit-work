const { contextBridge, ipcRenderer } = require('electron')

// 渲染进程可用的能力（contextIsolation 开启，只暴露这些）
contextBridge.exposeInMainWorld('moonAPI', {
  // 运行 moon 命令
  run: (args, cwd) => ipcRenderer.invoke('moon', { args, cwd }),
  defaultCwd: () => ipcRenderer.invoke('defaultCwd'),
  startInfo: () => ipcRenderer.invoke('startInfo'),
  // 文件系统
  listDir: (dir) => ipcRenderer.invoke('fs:list', dir),
  readFile: (file) => ipcRenderer.invoke('fs:read', file),
  writeFile: (file, content, confirmed) => ipcRenderer.invoke('fs:write', { file, content, confirmed }),
  findModule: (dir) => ipcRenderer.invoke('module', dir),
  pickDir: () => ipcRenderer.invoke('pickDir'),

  // ---- LSP 能力（基于 moon check / moon ide）----
  runCheck: (cwd) => ipcRenderer.invoke('diag:check', { cwd }),
  getOutline: (cwd, file) => ipcRenderer.invoke('outline:get', { cwd, file }),

  // ---- 后端面板（转发到本地管理接口）----
  adminGet: (path) => ipcRenderer.invoke('admin:get', { path }),

  // ---- 符号索引（补全 / 跳转定义）----
  loadSymbols: (cwd, force) => ipcRenderer.invoke('symbols:load', { cwd, force }),
  hoverSymbol: (cwd, word) => ipcRenderer.invoke('symbols:hover', { cwd, word }),

  // ---- 后端服务控制（IDE 内一键启停）----
  backendStatus: (cwd, port) => ipcRenderer.invoke('backend:status', { cwd, port }),
  // P14-06：一键健康检查（含 PG/Redis 依赖状态 —— P14-09/10）
  backendHealth: (cwd, port, path) => ipcRenderer.invoke('backend:health', { cwd, port, path }),
  backendDeps: () => ipcRenderer.invoke('backend:deps'),
  backendBuild: () => ipcRenderer.invoke('backend:build'),
  backendStart: (cwd, port, build) => ipcRenderer.invoke('backend:start', { cwd, port, build }),
  backendStop: () => ipcRenderer.invoke('backend:stop'),
  onBackendLog: (cb) => ipcRenderer.on('backend:log', (_e, p) => cb(p)),
  onBackendState: (cb) => ipcRenderer.on('backend:state', (_e, p) => cb(p)),
  notifyExit: () => ipcRenderer.send('backend:kill-on-exit'),

  // ── 文件中转站（Office 文档备份 / 版本回滚）—— 见 relay-main.js ──
  relayStatus: () => ipcRenderer.invoke('relay:status'),
  relayTouch: (file) => ipcRenderer.invoke('relay:touch', file),
  relayList: () => ipcRenderer.invoke('relay:list'),
  relayMeta: (file) => ipcRenderer.invoke('relay:meta', file),
  relayBackup: (file, note) => ipcRenderer.invoke('relay:backup', { file, note }),
  relayVersions: (file) => ipcRenderer.invoke('relay:versions', file),
  relayRestore: (file, stamp) => ipcRenderer.invoke('relay:restore', { file, stamp }),
  relayDelete: (file, stamp) => ipcRenderer.invoke('relay:delete', { file, stamp }),
  relayWatchAdd: (dir) => ipcRenderer.invoke('relay:watch:add', dir),
  relayWatchRemove: (dir) => ipcRenderer.invoke('relay:watch:remove', dir),
  relayOpen: (file) => ipcRenderer.invoke('relay:open', file),
  relayReveal: (file) => ipcRenderer.invoke('relay:reveal', file),
  relayExists: (file) => ipcRenderer.invoke('relay:exists', file),
  onRelayChanged: (cb) => ipcRenderer.on('relay:changed', (_e, p) => cb(p)),

  // ── 可执行入口（自动识别 + 运行，不写死 moon）── 见 runners.js ──
  runnerList: (root) => ipcRenderer.invoke('runner:list', root),
  runnerRun: (spec) => ipcRenderer.invoke('runner:run', spec),
  runnerStop: () => ipcRenderer.invoke('runner:stop'),
  onRunnerStart: (cb) => ipcRenderer.on('runner:start', (_e, p) => cb(p)),
  onRunnerData: (cb) => ipcRenderer.on('runner:data', (_e, p) => cb(p)),
  onRunnerEnd: (cb) => ipcRenderer.on('runner:end', (_e, p) => cb(p)),
  onRunnerUrl: (cb) => ipcRenderer.on('runner:url', (_e, p) => cb(p)),

  // ── AI Agent（opencode 作后端，见 agent.js）──
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  agentRun: (p) => ipcRenderer.invoke('agent:run', p),
  agentStop: () => ipcRenderer.invoke('agent:stop'),
  agentConfigGet: () => ipcRenderer.invoke('agent:config:get'),
  agentConfigSet: (j) => ipcRenderer.invoke('agent:config:set', j),
  agentOpenConfig: () => ipcRenderer.invoke('agent:open-config'),
  onAgentStart: (cb) => ipcRenderer.on('agent:start', (_e, p) => cb(p)),
  onAgentData: (cb) => ipcRenderer.on('agent:data', (_e, p) => cb(p)),
  onAgentEnd: (cb) => ipcRenderer.on('agent:end', (_e, p) => cb(p)),

  // ── LSP（接官方 moon-lsp）── 见 lsp-manager.js ──
  lspStart: (root) => ipcRenderer.invoke('lsp:start', root),
  lspStop: (root) => ipcRenderer.invoke('lsp:stop', root),
  lspStatus: (root) => ipcRenderer.invoke('lsp:status', root),
  lspOpen: (spec) => ipcRenderer.invoke('lsp:open', spec),
  lspChange: (spec) => ipcRenderer.invoke('lsp:change', spec),
  lspClose: (spec) => ipcRenderer.invoke('lsp:close', spec),
  lspDefinition: (spec) => ipcRenderer.invoke('lsp:definition', spec),
  lspHover: (spec) => ipcRenderer.invoke('lsp:hover', spec),
  lspReferences: (spec) => ipcRenderer.invoke('lsp:references', spec),
  lspDocumentSymbol: (spec) => ipcRenderer.invoke('lsp:documentSymbol', spec),
  lspRename: (spec) => ipcRenderer.invoke('lsp:rename', spec),
  lspCompletion: (spec) => ipcRenderer.invoke('lsp:completion', spec),
  onLspDiagnostics: (cb) => ipcRenderer.on('lsp:diagnostics', (_e, p) => cb(p)),
  onLspLog: (cb) => ipcRenderer.on('lsp:log', (_e, p) => cb(p)),

  // ---- 接口调试器（IDE 内直接调后端）----
  apiEndpoints: () => ipcRenderer.invoke('apidbg:endpoints'),
  apiSend: (payload) => ipcRenderer.invoke('apidbg:send', payload),

  // ---- 项目类型识别 ----
  projectInfo: (cwd) => ipcRenderer.invoke('project:info', { cwd }),

  // ---- 命令表（P3）：同一个动作（UI / 菜单 / 快捷键 / 未来的 Agent）都走它 ----
  commandList: () => ipcRenderer.invoke('command:list'),
  commandExecute: (name, args, opts) => ipcRenderer.invoke('command:execute', { name, args, opts }),

  // ---- Agent 只读工具（P6）：只能读；workspace 由用户在打开项目时设定（Agent 碰不到）----
  agentToolsList: () => ipcRenderer.invoke('agentTools:list'),
  agentToolsCall: (name, args) => ipcRenderer.invoke('agentTools:call', { name, args }),
  agentToolsSetWorkspace: (root) => ipcRenderer.invoke('agentTools:setWorkspace', root),
  agentToolsGetWorkspace: () => ipcRenderer.invoke('agentTools:getWorkspace'),
  // P7 执行工具（build/test/run/stop/health/apiRequest）—— 一律经命令表
  agentToolsExecList: () => ipcRenderer.invoke('agentTools:execList'),
  agentToolsExecCall: (name, args) => ipcRenderer.invoke('agentTools:execCall', { name, args }),
  agentToolsExecAudit: () => ipcRenderer.invoke('agentTools:execAudit'),
  // ---- Patch（P8）：两阶段 —— propose 拿 token 与预览，**用户确认后**才 apply ----
  agentPatchPropose: (patch) => ipcRenderer.invoke('agentPatch:propose', patch),
  agentPatchApply: (token) => ipcRenderer.invoke('agentPatch:apply', { token }),
  agentPatchCancel: (token) => ipcRenderer.invoke('agentPatch:cancel', { token }),
  agentPatchAudit: () => ipcRenderer.invoke('agentPatch:audit'),
  // ---- 验证闭环（P9）：改完自动证明没改坏 ----
  agentVerifyRun: (file) => ipcRenderer.invoke('agentVerify:run', { file }),
  agentVerifyLast: () => ipcRenderer.invoke('agentVerify:last'),
  onAgentVerifyProgress: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('agentVerify:progress', h)
    return () => ipcRenderer.removeListener('agentVerify:progress', h)
  },
  onAgentVerifyDone: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('agentVerify:done', h)
    return () => ipcRenderer.removeListener('agentVerify:done', h)
  },
  // ---- AI Provider（P12）：增删改查 + 连通性；读回来的清单**已脱敏** ----
  aiProviderList: () => ipcRenderer.invoke('aiProvider:list'),
  aiProviderSave: (p) => ipcRenderer.invoke('aiProvider:save', p),
  aiProviderRemove: (name) => ipcRenderer.invoke('aiProvider:remove', { name }),
  aiProviderTest: (p) => ipcRenderer.invoke('aiProvider:test', p),
  aiProviderStorage: () => ipcRenderer.invoke('aiProvider:storage'),
  aiProviderActivate: (name) => ipcRenderer.invoke('aiProvider:activate', { name }),
  aiProviderActive: () => ipcRenderer.invoke('aiProvider:active'),
  // ---- P5A：AgentRequest（渲染侧收集真实状态 → 主进程校验/组装/快照）----
  agentBuildRequest: (payload) => ipcRenderer.invoke('agent:buildRequest', payload),
  agentLastSnapshot: () => ipcRenderer.invoke('agent:lastSnapshot'),
  // ---- P9A：可验证的任务理解（Ask/Understand）----
  agentUnderstand: (payload) => ipcRenderer.invoke('agent:understand', payload),
  agentLastUnderstanding: () => ipcRenderer.invoke('agent:lastUnderstanding'),
  // ---- P10：会话（按项目绑定；存用户目录）----
  sessionResume: (payload) => ipcRenderer.invoke('session:resume', payload),
  sessionSave: (session) => ipcRenderer.invoke('session:save', { session }),
  sessionAppend: (payload) => ipcRenderer.invoke('session:append', payload),
  sessionClear: (projectRoot) => ipcRenderer.invoke('session:clear', { projectRoot }),
  sessionEnd: (projectRoot) => ipcRenderer.invoke('session:end', { projectRoot }),
  // ---- P11：项目级记忆（.moonbit-work/；规则写入需 confirmed）----
  memoryEnsure: (projectRoot, projectContext) => ipcRenderer.invoke('memory:ensure', { projectRoot, projectContext }),
  memoryRules: (projectRoot) => ipcRenderer.invoke('memory:rules', { projectRoot }),
  memoryWriteRules: (projectRoot, raw, confirmed) => ipcRenderer.invoke('memory:writeRules', { projectRoot, raw, confirmed }),
  memoryExperiences: (projectRoot) => ipcRenderer.invoke('memory:experiences', { projectRoot }),
  memoryAdd: (projectRoot, experience) => ipcRenderer.invoke('memory:add', { projectRoot, experience }),
  memorySearch: (projectRoot, query, limit) => ipcRenderer.invoke('memory:search', { projectRoot, query, limit }),
  memoryCompress: (projectRoot, threshold) => ipcRenderer.invoke('memory:compress', { projectRoot, threshold }),
  memoryDelete: (projectRoot, id) => ipcRenderer.invoke('memory:delete', { projectRoot, id }),
  // ---- P16-10～12：工程状态（Quality Center）----
  qualitySnapshot: (opts) => ipcRenderer.invoke('quality:snapshot', opts || {}),
  qualityLog: (file) => ipcRenderer.invoke('quality:log', { file }),
  // ---- P15：数据库工作台（只读；每句都过 SQL/Redis 安全闸）----
  dbTables: (schema) => ipcRenderer.invoke('db:tables', { schema }),
  dbColumns: (table, schema) => ipcRenderer.invoke('db:columns', { table, schema }),
  dbQuery: (payload) => ipcRenderer.invoke('db:query', payload || {}),
  dbRaw: (sql) => ipcRenderer.invoke('db:raw', { sql }),
  dbRedisKeys: (pattern, cursor, count) => ipcRenderer.invoke('db:redisKeys', { pattern, cursor, count }),
  dbRedisValue: (key, type) => ipcRenderer.invoke('db:redisValue', { key, type }),
  // ---- P13：工作台（最近项目 / 待办 / 便签；存用户目录）----
  wbLoad: (projectRoot) => ipcRenderer.invoke('workbench:load', { projectRoot }),
  wbTouchRecent: (projectContext) => ipcRenderer.invoke('workbench:touchRecent', { projectContext }),
  wbForgetRecent: (projectRoot) => ipcRenderer.invoke('workbench:forgetRecent', { projectRoot }),
  wbAddTodo: (projectRoot, text) => ipcRenderer.invoke('workbench:addTodo', { projectRoot, text }),
  wbToggleTodo: (projectRoot, id, done) => ipcRenderer.invoke('workbench:toggleTodo', { projectRoot, id, done }),
  wbRemoveTodo: (projectRoot, id) => ipcRenderer.invoke('workbench:removeTodo', { projectRoot, id }),
  wbSetNote: (projectRoot, text) => ipcRenderer.invoke('workbench:setNote', { projectRoot, text }),
  wbFile: () => ipcRenderer.invoke('workbench:file'),
  // ---- P13-04～07：办公文件 ↔ 项目联动 ----
  officeLink: (payload) => ipcRenderer.invoke('office:link', payload || {}),
  officeUnlink: (file) => ipcRenderer.invoke('office:unlink', { file }),
  officeLinks: (projectRoot) => ipcRenderer.invoke('office:links', { projectRoot }),
  officeProjectOf: (file) => ipcRenderer.invoke('office:projectOf', { file }),
  officePreview: (payload) => ipcRenderer.invoke('office:preview', payload || {}),
  officeToAgent: (payload) => ipcRenderer.invoke('office:toAgent', payload || {}),
  officeSummaryToNote: (payload) => ipcRenderer.invoke('office:summaryToNote', payload || {}),
  // ---- P20：启动恢复 + 环境检查 ----
  startupPlan: () => ipcRenderer.invoke('startup:plan'),
  startupMarkRunning: () => ipcRenderer.invoke('startup:markRunning'),
  startupMarkCleanExit: () => ipcRenderer.invoke('startup:markCleanExit'),
  startupUpdate: (patch) => ipcRenderer.invoke('startup:update', patch || {}),
  startupFile: () => ipcRenderer.invoke('startup:file'),
  envCheck: () => ipcRenderer.invoke('env:check', {}),
  envLast: () => ipcRenderer.invoke('env:last'),

  // 注：ProjectContext 不在这里过桥 —— 本 preload 是 sandbox:true，
  // require 本地文件会让整个 preload 挂掉（实测踩过）。
  // 它改由 index.html 的 <script src="./project-context.js"> + window.moonbitProjectContext 提供。

  // ---- 依赖管理 / 任务流式输出 ----
  formatFile: (cwd, file) => ipcRenderer.invoke('moon:format', { cwd, file }),
  runMoonStream: (args, cwd, timeoutMs) =>
    ipcRenderer.invoke('moon:stream', { args, cwd, timeoutMs }),
  stopMoonStream: () => ipcRenderer.send('moon:stream-stop'),
  onMoonStreamData: (cb) => ipcRenderer.on('moon:stream-data', (_e, p) => cb(p)),
  onMoonStreamEnd: (cb) => ipcRenderer.on('moon:stream-end', (_e, p) => cb(p)),

  // ---- 新建项目模板 ----
  pickProjectPath: (parentDir, defaultName) => ipcRenderer.invoke('pickProjectPath', { parentDir, defaultName }),
  newProject: (dir) => ipcRenderer.invoke('newProject', { dir }),

  // ---- 跨文件搜索 ----
  searchFiles: (cwd, query, caseInsensitive) =>
    ipcRenderer.invoke('search:files', { cwd, query, caseInsensitive }),

  // ---- 集成终端 ----
  // 新建一个终端会话，返回会话 id（失败时返回 { error }）
  termCreate: (cwd) => ipcRenderer.invoke('term:create', { cwd }),
  // 向终端写入（键盘输入 / 粘贴）
  termInput: (id, data) => ipcRenderer.send('term:input', { id, data }),
  // 调整终端尺寸（行/列）
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  // 关闭终端
  termKill: (id) => ipcRenderer.send('term:kill', { id }),
  // 订阅终端输出（返回取消订阅函数）
  onTermData: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('term:data', handler)
    return () => ipcRenderer.removeListener('term:data', handler)
  },
  // 订阅终端退出
  onTermExit: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('term:exit', handler)
    return () => ipcRenderer.removeListener('term:exit', handler)
  },
})
