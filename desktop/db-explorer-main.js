'use strict'

/**
 * 数据库工作台的执行层（Phase 2.1 / P15-01 ～ P15-06）
 *
 * 与 `db-explorer.js`（构造层）分工：
 *   · 构造层是**纯逻辑** —— 把"想看的"翻成 SQL / Redis 命令，可穷举测试；
 *   · 这一层负责**跑** —— 用注入的 `runCommand` 去调 `psql` / `redis-cli`。
 *
 * 两条原则：
 *   ① **每一句都再过一遍安全闸**（构造层已经过了一次，这里是第二道；
 *      同时也挡住了"界面直接塞一条 SQL 过来"）。
 *   ② **没装客户端就如实说** —— 返回"未找到 psql"，而不是一个空结果集
 *      （空结果会被误读成"这张表是空的"）。
 *
 * 连接参数走环境变量（`PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`、`REDIS_HOST`/`REDIS_PORT`），
 * 不在这里落任何凭据；日志里也不会出现密码。
 */

const {
  sqlListTables,
  sqlColumns,
  sqlSelect,
  sqlSearch,
  redisScanKeys,
  redisReadKey,
} = require('./db-explorer')
const { analyzeSql, analyzeRedisCommand } = require('./sql-guard')

/** 把 psql 的输出（默认是表格）粗解析成对象数组；解析不出就把原文带回去 */
function parsePsqlTable(text) {
  const lines = String(text == null ? '' : text).trim().split('\n').filter((l) => l.trim())
  if (!lines.length) return { rows: [], raw: '' }
  // 去掉可能的分隔行（---+---）
  const data = lines.filter((l) => !/^[-+\s|]+$/.test(l))
  if (data.length < 2) return { rows: [], raw: String(text) }
  const header = data[0].split('|').map((s) => s.trim())
  const rows = []
  for (const l of data.slice(1)) {
    const cells = l.split('|').map((s) => s.trim())
    if (cells.length !== header.length) continue
    const o = {}
    header.forEach((h, i) => { o[h] = cells[i] })
    rows.push(o)
  }
  return { rows, raw: String(text) }
}

/**
 * 判断是不是"客户端根本没装上"。
 *
 * ⚠️ 不能只看 `code === -1`：Windows 上 cmd 找不到命令时返回的是 **code 1**，
 * 而且错误文案是本地化的（本机是 GBK 的"不是内部或外部命令"，在终端里还会显示成乱码）。
 * 所以既看 code，也看几种已知的文案。
 */
function looksLikeMissingClient(r, out) {
  if (!r) return false
  if (r.code === -1) return true
  const s = String(out || '')
  if (/not recognized|command not found|No such file or directory|ENOENT/i.test(s)) return true
  if (/不是内部或外部命令|系统找不到指定的文件|无法将/.test(s)) return true
  // 兜底：**不看具体码值** —— 不同 shell / 不同 Windows 版本给的不一样
  // （psql 是 1、redis-cli 又是别的）。判据改成"非零退出 + 输出很短 + 完全不像数据库自己的错误"。
  if (r.code !== 0 && s.trim().length > 0 && s.trim().length < 300
      && !/ERROR|FATAL|DETAIL|HINT/i.test(s)) return true
  return false
}

function psqlArgs(sql) {
  // -t 去表头装饰？不：我们要表头来当字段名。用默认对齐格式 + 管道分隔靠 -A -F
  return ['-X', '-A', '-F', '|', '-c', sql]
}

function registerDbExplorerIpc({ ipcMain, runCommand, onLog }) {
  const log = typeof onLog === 'function' ? onLog : () => {}

  async function runPsql(sql) {
    const gate = analyzeSql(sql)
    if (gate.ok !== true) return { ok: false, error: 'SQL 被拒绝（' + gate.code + '）：' + gate.reason }
    const r = await runCommand({ bin: 'psql', args: psqlArgs(sql), cwd: process.cwd() })
    const out = String((r && (r.stdout || r.stderr)) || '')
    if (looksLikeMissingClient(r, out)) {
      // 起不来（没装 / 不在 PATH）—— 必须如实说，不能返回空结果
      return { ok: false, code: 'NO_CLIENT', error: '未找到 psql 客户端。装好 PostgreSQL 客户端（或把 psql 放进 PATH）再试。原始输出：' + out.slice(0, 160) }
    }
    if (r && r.code !== 0) return { ok: false, error: '数据库返回错误：' + out.slice(0, 300) }
    const parsed = parsePsqlTable(out)
    return { ok: true, rows: parsed.rows, rowCount: parsed.rows.length, raw: parsed.raw.slice(0, 2000) }
  }

  async function runRedis(cmd) {
    const gate = analyzeRedisCommand(cmd)
    if (gate.ok !== true) return { ok: false, error: 'Redis 命令被拒绝（' + gate.code + '）：' + gate.reason }
    const args = gate.args && gate.args.length ? [gate.command].concat(gate.args) : [gate.command]
    const r = await runCommand({ bin: 'redis-cli', args, cwd: process.cwd() })
    const out = String((r && (r.stdout || r.stderr)) || '')
    if (looksLikeMissingClient(r, out)) {
      return { ok: false, code: 'NO_CLIENT', error: '未找到 redis-cli 客户端。装好 Redis 客户端（或把它放进 PATH）再试。原始输出：' + out.slice(0, 160) }
    }
    if (r && r.code !== 0) return { ok: false, error: 'Redis 返回错误：' + out.slice(0, 300) }
    return { ok: true, command: gate.command, lines: out.split('\n').filter((x) => x.length > 0).slice(0, 200) }
  }

  // P15-01：表列表
  ipcMain.handle('db:tables', async (_e, { schema } = {}) => {
    const r = await runPsql(sqlListTables(schema))
    log({ at: 'db.tables', ok: r.ok === true, count: r.rowCount || 0 })
    return r
  })

  // P15-02：列信息
  ipcMain.handle('db:columns', async (_e, { table, schema } = {}) => {
    if (!table) return { ok: false, error: '缺少 table' }
    let sql = ''
    try { sql = sqlColumns(String(table), schema) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
    return runPsql(sql)
  })

  // P15-03/04：分页读取与搜索（都由构造层生成，再经闸）
  ipcMain.handle('db:query', async (_e, payload = {}) => {
    try {
      if (payload.mode === 'search') {
        if (!payload.term) return { ok: false, error: '缺少搜索词' }
        return runPsql(sqlSearch(String(payload.table), payload.term, payload.columns || []))
      }
      return runPsql(sqlSelect(String(payload.table), payload))
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  })

  /** 直接跑一条 SQL（界面高级模式 / Agent）—— 仍然过闸 */
  ipcMain.handle('db:raw', async (_e, { sql } = {}) => runPsql(String(sql || '')))

  // P15-05/06：Redis
  ipcMain.handle('db:redisKeys', async (_e, { pattern, cursor, count } = {}) => {
    let cmd = null
    try { cmd = redisScanKeys(pattern, cursor, count) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
    return runRedis(cmd)
  })

  ipcMain.handle('db:redisValue', async (_e, { key, type } = {}) => {
    if (!key) return { ok: false, error: '缺少 key' }
    // 先 TYPE，再按类型读值（两步都过闸）
    const t = await runRedis(['TYPE', String(key)])
    if (t.ok !== true) return t
    const realType = String((t.lines && t.lines[0]) || type || '').trim().toLowerCase()
    let cmd = null
    try { cmd = redisReadKey(String(key), realType) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
    const v = await runRedis(cmd)
    return Object.assign({}, v, { type: realType })
  })

  return { runPsql, runRedis }
}

module.exports = { registerDbExplorerIpc, parsePsqlTable, psqlArgs, looksLikeMissingClient }
