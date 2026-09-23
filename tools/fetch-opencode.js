// 把 opencode 二进制放进 desktop/vendor/opencode/ —— 供「开箱即用」打包用。
//
// 为什么需要这个脚本：内置二进制约 180MB，**不进 git**（desktop/vendor/ 已在 .gitignore）。
// 别人 clone 后、或换一台机器构建前，跑一次 `npm run fetch:opencode` 即可填上。
//
// 策略（从省事到麻烦）：
//   ① 已经存在 → 直接跳过
//   ② 本机 npm 全局装过 opencode-ai → 直接复制它的二进制
//   ③ 都没有 → 用 npm 临时装一份再复制（需要网络）
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const DEST_DIR = path.join(__dirname, '..', 'desktop', 'vendor', 'opencode')
const EXE = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
const DEST = path.join(DEST_DIR, EXE)

function exists(p) { try { return fs.statSync(p).isFile() } catch (_) { return false } }

function copyIn(src) {
  fs.mkdirSync(DEST_DIR, { recursive: true })
  fs.copyFileSync(src, DEST)
  try { fs.chmodSync(DEST, 0o755) } catch (_) {}
  const mb = (fs.statSync(DEST).size / 1048576).toFixed(0)
  console.log('✓ 已放入内置 opencode：' + DEST + '（' + mb + 'MB）')
}

// 在 npm 全局 node_modules 里找 opencode-ai 的二进制
function fromGlobal() {
  const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true })
  const g = String(root.stdout || '').trim()
  if (!g) return null
  const candidates = [
    path.join(g, 'opencode-ai', 'bin', EXE),
    path.join(g, 'opencode-ai', 'bin', 'opencode.exe'),
  ]
  return candidates.find(exists) || null
}

// 兜底：临时装一份
function fromNpm() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fetch-'))
  console.log('· 用 npm 临时安装 opencode-ai 到 ' + tmp + '（需要网络）…')
  const r = spawnSync('npm', ['i', '--no-save', '--prefix', tmp, 'opencode-ai'], { encoding: 'utf8', shell: true, timeout: 600000 })
  if (r.status !== 0) { console.error('npm 安装失败：' + String(r.stderr || '').slice(0, 300)); return null }
  const p = path.join(tmp, 'node_modules', 'opencode-ai', 'bin', EXE)
  return exists(p) ? p : null
}

function main() {
  if (exists(DEST)) { console.log('· 已存在，跳过：' + DEST); return 0 }
  console.log('· 目标：' + DEST)
  const g = fromGlobal()
  if (g) { console.log('· 从本机 npm 全局复制：' + g); copyIn(g); return 0 }
  const n = fromNpm()
  if (n) { copyIn(n); return 0 }
  console.error('✗ 没能拿到 opencode 二进制。请先 `npm i -g opencode-ai`，再重跑本脚本。')
  return 1
}

process.exit(main())
