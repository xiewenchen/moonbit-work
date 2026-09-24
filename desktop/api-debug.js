// 接口调试器（后端主进程侧）
//
// 目的：让 IDE 能**直接调后端接口并看到结果** —— 这是「能开发和验证后端」的核心。
// 没有它，改完后端只能靠命令行 curl，开发闭环是断的。
//
// 设计：
//   • 端点清单从 `conduit/openapi.yml` 解析（规范与实现是对齐的，改一处就够）
//   • 请求由**主进程**发出：绕过浏览器 CORS、可跳过自签证书、能保留 token
//   • 返回状态码 / 响应头 / 耗时 / 响应体，便于判断"到底是哪一层不对"

const fs = require('fs')
const http = require('http')
const { rootOfInput } = require('./project-context')
const https = require('https')
const path = require('path')

// 极简 OpenAPI paths 解析：只取「路径 + 方法 + summary」，够生成调试面板即可
function parseOpenApiEndpoints(specPath) {
  if (!fs.existsSync(specPath)) return []
  const lines = fs.readFileSync(specPath, 'utf8').split(/\r?\n/)
  const out = []
  let curPath = null
  let curSummary = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const mPath = /^  (\/[^:]+):\s*$/.exec(line)
    if (mPath) {
      curPath = mPath[1]
      curSummary = ''
      continue
    }
    const mMethod = /^    (get|post|put|delete|patch):\s*$/.exec(line)
    if (mMethod && curPath) {
      // 往后找 summary
      let summary = ''
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const mS = /^\s+summary:\s*(.+)$/.exec(lines[j])
        if (mS) {
          summary = mS[1].trim()
          break
        }
      }
      out.push({ method: mMethod[1].toUpperCase(), path: curPath, summary })
      continue
    }
  }
  // 去掉 OpenAPI 里 servers 带来的 /api 前缀重复问题：规范里 path 不含 /api
  return out
}

// 从 openapi.yml 里猜该端点是否需要请求体（看 requestBody 是否存在）
function parseOpenApiBodies(specPath) {
  const text = fs.readFileSync(specPath, 'utf8')
  const lines = text.split(/\r?\n/)
  const bodies = {}
  let curPath = null
  let curMethod = null
  for (let i = 0; i < lines.length; i++) {
    const mPath = /^  (\/[^:]+):\s*$/.exec(lines[i])
    if (mPath) {
      curPath = mPath[1]
      curMethod = null
      continue
    }
    const mMethod = /^    (get|post|put|delete|patch):\s*$/.exec(lines[i])
    if (mMethod) {
      curMethod = mMethod[1].toUpperCase()
      continue
    }
    if (curMethod && curPath && /^\s+requestBody:\s*$/.test(lines[i])) {
      // 往后找 example（我们规范里都写了 example）
      let example = ''
      for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
        if (/^\s+example:\s*$/.test(lines[j])) {
          const baseIndent = lines[j].search(/\S/)
          const buf = []
          for (let k = j + 1; k < lines.length; k++) {
            const l = lines[k]
            if (l.trim() === '') continue
            const ind = l.search(/\S/)
            if (ind <= baseIndent) break
            buf.push(l.slice(baseIndent + 2))
          }
          example = buf.join('\n')
          break
        }
      }
      bodies[`${curMethod} ${curPath}`] = example
      curMethod = null // 一个操作只取一次
    }
  }
  return bodies
}

function request({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      return resolve({ error: 'URL 无效：' + url })
    }
    const isHttps = u.protocol === 'https:'
    const mod = isHttps ? https : http
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: headers || {},
      timeout: timeoutMs || 15000,
      // 自签证书：调试用，跳过校验（仅本机开发）
      rejectUnauthorized: false,
    }
    const started = Date.now()
    const req = mod.request(opts, (res) => {
      let data = ''
      res.on('data', (d) => {
        data += d.toString('utf8')
        // 防止超大响应把界面拖死
        if (data.length > 512 * 1024) {
          data = data.slice(0, 512 * 1024) + '\n…(已截断 512KB)'
          res.destroy()
        }
      })
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          body: data,
          ms: Date.now() - started,
        }),
      )
    })
    req.on('error', (e) => resolve({ error: e.message, ms: Date.now() - started }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ error: `请求超时（${opts.timeout}ms）`, ms: Date.now() - started })
    })
    if (body && method !== 'GET' && method !== 'HEAD') req.write(body)
    req.end()
  })
}

function registerApiDebugIpc({ ipcMain, DEFAULT_CWD }) {
  // P2-12：端点清单要跟**当前项目**走。
  // 之前写死 DEFAULT_CWD（完全忽略传入的路径），导致「打开别的项目时接口面板仍列本仓库的端点」。
  const specPath = (input) => path.join(rootOfInput(input) || DEFAULT_CWD, 'conduit', 'openapi.yml')

  ipcMain.handle('apidbg:endpoints', async (_e, input) => {
    const p = specPath(input)
    if (!fs.existsSync(p)) return { ok: false, error: '找不到 conduit/openapi.yml', endpoints: [] }
    return {
      ok: true,
      endpoints: parseOpenApiEndpoints(p),
      bodies: parseOpenApiBodies(p),
    }
  })

  ipcMain.handle('apidbg:send', async (_e, { baseUrl, method, path: reqPath, token, body }) => {
    const url = (baseUrl || 'http://127.0.0.1:8110') + reqPath
    const headers = {}
    if (token) headers['Authorization'] = 'Token ' + token
    if (body && body.trim() !== '') headers['Content-Type'] = 'application/json'
    return request({ url, method, headers, body })
  })
}

module.exports = { registerApiDebugIpc, parseOpenApiEndpoints }
