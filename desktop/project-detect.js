// 项目类型识别 —— 让 IDE 打开**任意项目**时能说清「哪些功能可用、哪些不适用」。
//
// 背景：这个 IDE 的智能能力（补全/跳转/悬停）是靠 MoonBit 的 symbols.jsonl 索引实现的，
// 后端面板与接口面板也是**特化**给本仓库那套 MoonBit 后端的。
// 用它打开一个 Node/Python 项目时（例如 Strapi），这些能力天然不适用 ——
// 问题不在于「不适用」，而在于**要明确告诉用户**，而不是静默失败或报错。

const fs = require('fs')
const path = require('path')
const { rootOfInput } = require('./project-context')

const has = (root, f) => {
  try {
    return fs.existsSync(path.join(root, f))
  } catch (_) {
    return false
  }
}

// 识别项目类型（按优先级：MoonBit > Node > Python > 其他）
function detectProject(root) {
  let kind = 'unknown'
  let label = '未知类型'
  if (has(root, 'moon.mod.json') || has(root, 'moon.mod')) {
    kind = 'moonbit'
    label = 'MoonBit 模块'
  } else if (has(root, 'package.json')) {
    kind = 'node'
    label = 'Node / JavaScript 项目'
  } else if (has(root, 'pyproject.toml') || has(root, 'requirements.txt') || has(root, 'manage.py')) {
    kind = 'python'
    label = 'Python 项目'
  } else if (has(root, 'Cargo.toml')) {
    kind = 'rust'
    label = 'Rust 项目'
  } else if (has(root, 'go.mod')) {
    kind = 'go'
    label = 'Go 项目'
  }

  // 各能力的可用性：能用的说能用，不能用的给出**原因**，便于界面直接显示
  const apiDebug = has(root, 'conduit/openapi.yml')
  const backendBin =
    has(root, '_build/native/release/build/conduit/cmd/main/main.exe') ||
    has(root, '_build/native/debug/build/conduit/cmd/main/main.exe')

  return {
    root,
    kind,
    label,
    features: {
      fileTree: { ok: true, why: '' },
      editor: { ok: true, why: '' },
      terminal: { ok: true, why: '' },
      search: { ok: true, why: '' },
      moonbitIntel: {
        ok: kind === 'moonbit',
        why:
          kind === 'moonbit'
            ? ''
            : `补全/跳转/悬停基于 MoonBit 的 symbols.jsonl 索引，当前是${label}，不适用`,
      },
      backendControl: {
        ok: backendBin || kind === 'moonbit',
        why:
          backendBin || kind === 'moonbit'
            ? ''
            : `一键启停针对本仓库的 MoonBit 后端（需要 _build 下的二进制），当前是${label}`,
      },
      apiDebug: {
        ok: apiDebug,
        why: apiDebug ? '' : '接口面板的端点清单来自 conduit/openapi.yml，当前项目下没有这个文件',
      },
    },
  }
}

function registerProjectIpc({ ipcMain, DEFAULT_CWD }) {
  ipcMain.handle('project:info', async (_e, { cwd } = {}) => {
    const root = rootOfInput(cwd) || DEFAULT_CWD
    try {
      if (!fs.existsSync(root)) return { ok: false, error: '目录不存在：' + root }
      return { ok: true, ...detectProject(root) }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
}

module.exports = { registerProjectIpc, detectProject }
