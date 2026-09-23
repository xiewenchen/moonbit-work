// 给 opencode 配一份**自己的模型额度**（provider）—— 用法：node tools/setup-provider.js
//
// 为什么需要它：内置的 opencode 用的是它的**免费额度，很容易限流**（429 FreeUsageLimitError，
// 实测调用几次就撞上）。评委试用 / 现场演示时撞上会很尴尬。
// 配一份自己的额度（DeepSeek / 通义 / Kimi 等都很便宜）就稳定了。
//
// ⚠️ 安全：key 只写进**本机**的 ~/.config/opencode/opencode.jsonc。
//    千万不要提交到公开仓库、也不要打进安装包 —— 作品是公开的，key 一泄露就会被盗刷。
//    要给评委"开箱即用"，正确做法是你自己配好后**在构建/首次启动时写入用户目录**，
//    而不是把 key 放进代码或仓库里。
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')

const CFG_DIR = path.join(os.homedir(), '.config', 'opencode')
const CFG_FILE = path.join(CFG_DIR, 'opencode.jsonc')

const PRESETS = [
  { id: 'deepseek', label: 'DeepSeek（便宜、够用）', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', npm: '@ai-sdk/openai-compatible' },
  { id: 'dashscope', label: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', npm: '@ai-sdk/openai-compatible' },
  { id: 'moonshot', label: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', npm: '@ai-sdk/openai-compatible' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', npm: '@ai-sdk/openai-compatible' },
  { id: 'ollama', label: '本地 Ollama（http://127.0.0.1:11434/v1）', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', npm: '@ai-sdk/openai-compatible' },
]

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\s*\/\/.*$/gm, '')) } catch (_) { return {} }
}
function ask(rl, q) { return new Promise((res) => rl.question(q, (a) => res(String(a || '').trim()))) }

async function main() {
  const cfg = readCfg()
  console.log('配置文件：' + CFG_FILE)
  console.log('当前 provider：' + (cfg.provider ? Object.keys(cfg.provider).join(', ') || '(空)' : '(无)'))
  console.log('当前 model：' + (cfg.model || '(无)'))
  console.log()
  if (process.argv.includes('--list')) return 0

  console.log('选一个（回车用默认 1）：')
  PRESETS.forEach((p, i) => console.log('  ' + (i + 1) + ') ' + p.label))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const pick = (await ask(rl, '> ')) || '1'
  const preset = PRESETS[Number(pick) - 1] || PRESETS[0]

  const baseURL = (await ask(rl, 'baseURL（回车用 ' + preset.baseURL + '）：')) || preset.baseURL
  const model = (await ask(rl, 'model（回车用 ' + preset.model + '）：')) || preset.model
  const apiKey = await ask(rl, 'API Key（本地 Ollama 随便填，如 ollama）：')
  rl.close()
  if (!apiKey) { console.error('✗ 没填 apiKey，已取消'); return 1 }

  const next = {
    ...cfg,
    provider: {
      ...(cfg.provider || {}),
      [preset.id]: {
        npm: preset.npm,
        options: { baseURL, apiKey },
        models: { [model]: {} },
      },
    },
    model: preset.id + '/' + model,   // opencode 用 provider/model 定位
  }
  fs.mkdirSync(CFG_DIR, { recursive: true })
  fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2), 'utf8')
  console.log()
  console.log('✓ 已写入：' + CFG_FILE)
  console.log('  provider = ' + preset.id + '   model = ' + next.model)
  console.log('  下一步：重启 IDE（或重开 AI Agent 标签），然后在面板里发一句话验证。')
  console.log('  提示：确认写的是本机用户目录，别把它提交进 git。')
  return 0
}

main().then((c) => process.exit(c)).catch((e) => { console.error(String(e && e.stack || e)); process.exit(1) })
