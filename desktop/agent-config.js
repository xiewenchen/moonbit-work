// 自研 Agent 的**配置**：一个 OpenAI 兼容端点（云端 API 或本地 Ollama）
//
// 存到 ~/.moonbit-agent.json。这样"兼容性第二"就落到实处：
//   · 云端：DeepSeek / 通义 / Kimi / OpenAI …… 都是 OpenAI 兼容协议
//   · 本地：Ollama 也提供 OpenAI 兼容接口 http://127.0.0.1:11434/v1
//     （apiKey 随便填，例如 "ollama"）
const os = require('os')
const fs = require('fs')
const path = require('path')

const CFG = path.join(os.homedir(), '.moonbit-agent.json')

const DEFAULTS = {
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxToolRounds: 25,      // 一次提问最多允许多少轮工具调用
  confirmWrites: true,    // 写文件/改文件/跑命令是否要用户确认（安全底线）
}

// 一些现成的预设，界面上可以直接选（也能手填）
const PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'dashscope', label: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', label: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'ollama', label: '本地 Ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
]

function read() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG, 'utf8')) } }
  catch (_) { return { ...DEFAULTS } }
}

function write(patch) {
  const next = { ...read(), ...patch }
  try { fs.writeFileSync(CFG, JSON.stringify(next, null, 2), 'utf8') } catch (_) {}
  return next
}

// 给界面用的：不把完整 apiKey 带出去（只回显是否已配置）
function safeView() {
  const c = read()
  return { ...c, apiKey: c.apiKey ? '******' : '', hasKey: !!c.apiKey }
}

module.exports = { CFG, DEFAULTS, PRESETS, read, write, safeView }
