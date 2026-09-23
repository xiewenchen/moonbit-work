// 自研轻量 Agent 的**工具集**（纯 Node，零依赖）
//
// 设计原则：
//   1. 能力优先但可控 —— 每个工具都能干实事，但危险动作（写/改/跑命令）默认要用户确认
//   2. **路径一律锁在项目根目录内** —— 越界直接拒绝，不让 agent 碰系统文件
//   3. 输出一律截断 —— 防止把上下文撑爆（agent 最怕的就是"读了 5 万行日志"）
//
// 每个工具的形状：
//   { name, description, parameters(JSON Schema), requiresConfirm, run(args, ctx) -> string }
// run 的返回值就是喂回模型的工具结果（字符串）。
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const MAX_READ_LINES = 400         // 单次读文件最多返回多少行
const MAX_LIST_ENTRIES = 400       // 单次列目录最多多少条
const MAX_GREP_HITS = 120          // 单次搜索最多多少条
const MAX_CMD_OUTPUT = 20000       // 命令输出截断（字符）
const CMD_TIMEOUT_MS = 60000       // 命令超时

// ── 路径安全：一切都必须在 root 之内 ─────────────────────────────────
function safeResolve(root, p) {
  const abs = path.resolve(root, String(p == null ? '.' : p))
  const r = path.resolve(root)
  const rel = path.relative(r, abs)
  if (rel === '') return { ok: true, abs }                       // 就是 root 本身
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: '路径越界（只允许操作项目目录内的文件）：' + p }
  }
  return { ok: true, abs }
}

function truncate(s, n) {
  s = String(s == null ? '' : s)
  return s.length > n ? s.slice(0, n) + `\n…（已截断，共 ${s.length} 字符）` : s
}

// ── 工具实现 ────────────────────────────────────────────────────────
function listDir(args, ctx) {
  const r = safeResolve(ctx.root, args.path || '.')
  if (!r.ok) return r.error
  let entries
  try { entries = fs.readdirSync(r.abs, { withFileTypes: true }) } catch (e) { return '读取目录失败：' + e.message }
  const skip = new Set(['node_modules', '.git', '_build', '.mooncakes', 'target', 'dist'])
  const lines = []
  for (const e of entries) {
    if (lines.length >= MAX_LIST_ENTRIES) { lines.push('…（条目过多，已截断）'); break }
    if (skip.has(e.name)) { lines.push('[目录] ' + e.name + '/  （已忽略）'); continue }
    if (e.isDirectory()) { lines.push('[目录] ' + e.name + '/'); continue }
    let sz = ''
    try { sz = '  ' + fs.statSync(path.join(r.abs, e.name)).size + 'B' } catch (_) {}
    lines.push('[文件] ' + e.name + sz)
  }
  return lines.length ? lines.join('\n') : '（空目录）'
}

function readFileTool(args, ctx) {
  const r = safeResolve(ctx.root, args.path)
  if (!r.ok) return r.error
  let text
  try { text = fs.readFileSync(r.abs, 'utf8') } catch (e) { return '读取失败：' + e.message }
  const offset = Math.max(0, Number(args.offset) || 0)
  const limit = Math.min(MAX_READ_LINES, Math.max(1, Number(args.limit) || MAX_READ_LINES))
  const all = text.split(/\r?\n/)
  const slice = all.slice(offset, offset + limit)
  const body = slice.map((l, i) => String(offset + i + 1).padStart(5) + '| ' + l).join('\n')
  const more = all.length > offset + limit ? `\n…（还有 ${all.length - offset - limit} 行，可用 offset 继续读）` : ''
  return `文件：${path.relative(ctx.root, r.abs)}（共 ${all.length} 行）\n` + body + more
}

function grepTool(args, ctx) {
  const r = safeResolve(ctx.root, args.path || '.')
  if (!r.ok) return r.error
  let re
  try { re = new RegExp(String(args.pattern), args.ignoreCase ? 'i' : '') } catch (e) { return '正则不合法：' + e.message }
  const skip = new Set(['node_modules', '.git', '_build', '.mooncakes', 'target', 'dist'])
  const hits = []
  const walk = (dir, depth) => {
    if (hits.length >= MAX_GREP_HITS || depth > 8) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      if (hits.length >= MAX_GREP_HITS) return
      if (skip.has(e.name) || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!e.isFile()) continue
      let text
      try {
        const st = fs.statSync(full)
        if (st.size > 2 * 1024 * 1024) continue           // 跳过 >2MB 的文件
        text = fs.readFileSync(full, 'utf8')
      } catch (_) { continue }
      if (text.indexOf('\u0000') >= 0) continue           // 二进制跳过
      text.split(/\r?\n/).forEach((line, i) => {
        if (hits.length >= MAX_GREP_HITS) return
        if (re.test(line)) hits.push(path.relative(ctx.root, full) + ':' + (i + 1) + ': ' + line.trim().slice(0, 220))
      })
    }
  }
  walk(r.abs, 0)
  return hits.length ? hits.join('\n') + (hits.length >= MAX_GREP_HITS ? '\n…（已截断）' : '') : '（没有匹配）'
}

function writeFileTool(args, ctx) {
  const r = safeResolve(ctx.root, args.path)
  if (!r.ok) return r.error
  try {
    fs.mkdirSync(path.dirname(r.abs), { recursive: true })
    fs.writeFileSync(r.abs, String(args.content == null ? '' : args.content), 'utf8')
  } catch (e) { return '写入失败：' + e.message }
  return '已写入 ' + path.relative(ctx.root, r.abs) + '（' + Buffer.byteLength(String(args.content || '')) + ' 字节）'
}

function editFileTool(args, ctx) {
  const r = safeResolve(ctx.root, args.path)
  if (!r.ok) return r.error
  let text
  try { text = fs.readFileSync(r.abs, 'utf8') } catch (e) { return '读取失败：' + e.message }
  const oldS = String(args.old_string == null ? '' : args.old_string)
  const newS = String(args.new_string == null ? '' : args.new_string)
  if (!oldS) return 'old_string 不能为空'
  const first = text.indexOf(oldS)
  if (first < 0) return '没找到要替换的内容（old_string 必须与文件内容**逐字**一致，包括缩进）'
  if (text.indexOf(oldS, first + 1) >= 0) return '这段内容在文件里出现多次，请提供更长的上下文让它唯一'
  try { fs.writeFileSync(r.abs, text.slice(0, first) + newS + text.slice(first + oldS.length), 'utf8') } catch (e) { return '写入失败：' + e.message }
  return '已修改 ' + path.relative(ctx.root, r.abs)
}

function runCommandTool(args, ctx) {
  const cmd = String(args.command || '').trim()
  if (!cmd) return '命令为空'
  const cwdChk = safeResolve(ctx.root, args.cwd || '.')
  if (!cwdChk.ok) return cwdChk.error
  const r = spawnSync(cmd, { cwd: cwdChk.abs, shell: true, encoding: 'utf8', timeout: CMD_TIMEOUT_MS })
  const out = String(r.stdout || '') + (r.stderr ? '\n[stderr]\n' + String(r.stderr) : '')
  return '退出码：' + (r.status == null ? '(超时/被杀)' : r.status) + '\n' + truncate(out || '（无输出）', MAX_CMD_OUTPUT)
}

// ── 工具清单（JSON Schema 给模型看）──────────────────────────────────
const TOOLS = [
  {
    name: 'list_dir',
    description: '列出一个目录下的文件与子目录。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根的路径，默认 "."' } }, required: [] },
    requiresConfirm: false,
    run: listDir,
  },
  {
    name: 'read_file',
    description: '读取文本文件，返回带行号的内容。可用 offset/limit 分段读大文件。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number', description: '从第几行开始（0 基）' }, limit: { type: 'number', description: '最多读多少行' } }, required: ['path'] },
    requiresConfirm: false,
    run: readFileTool,
  },
  {
    name: 'grep',
    description: '在项目里按正则搜索文本，返回「文件:行号: 内容」。',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: '搜索的起点目录，默认 "."' }, ignoreCase: { type: 'boolean' } }, required: ['pattern'] },
    requiresConfirm: false,
    run: grepTool,
  },
  {
    name: 'write_file',
    description: '把内容写入文件（新建或整体覆盖）。**会改动磁盘，需要用户确认**。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    requiresConfirm: true,
    run: writeFileTool,
  },
  {
    name: 'edit_file',
    description: '在文件里把 old_string 精确替换成 new_string（old_string 必须在文件里唯一）。**会改动磁盘，需要用户确认**。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] },
    requiresConfirm: true,
    run: editFileTool,
  },
  {
    name: 'run_command',
    description: '在项目目录下执行一条 shell 命令（构建/测试/查看状态等）。**需要用户确认**。',
    parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: '相对项目根的目录' } }, required: ['command'] },
    requiresConfirm: true,
    run: runCommandTool,
  },
]

function byName(name) { return TOOLS.find((t) => t.name === name) || null }

// 给模型看的工具描述（OpenAI tools 格式）
function toOpenAITools(list) {
  return (list || TOOLS).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

module.exports = { TOOLS, byName, toOpenAITools, safeResolve, truncate,
  MAX_READ_LINES, MAX_CMD_OUTPUT }
