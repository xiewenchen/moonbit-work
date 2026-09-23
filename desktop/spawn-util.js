// 子进程启动的公共处理。
//
// 存在的原因（实测踩到的真坑）：
//   Node 在 Windows 上**不能直接 spawn 一个 .cmd/.bat** —— 会抛 `spawn EINVAL`。
//   而 npm、以及 npm 全局安装的 CLI（如 opencode.cmd）在 Windows 上都是 .cmd 包装脚本。
//   所以 `spawn('npm', ...)` / `spawn('...opencode.cmd', ...)` 会直接失败，
//   表现就是「IDE 里跑不起任何 npm 项目 / AI Agent 起不来」。
//
//   还有第二种情况同样要交给 shell：**不带扩展名的命令名**（如 'npm'）。
//   磁盘上其实是 npm.cmd，直接 spawn('npm') 在 Windows 上找不到它，报 ENOENT
//   （用户报过：运行 Node 项目报 `无法执行 npm：spawn npm ENOENT`）。
//
// 处理方式经过两轮实测修正：
//   ① 只把可执行文件换成 cmd.exe、参数仍用数组传 —— 失败：
//      cmd 拿路径里的空格当分隔符，`C:\Program Files\...` 被切成 `C:\Program`。
//   ② 自己拼命令行再按数组传 —— 仍然失败：Node 会**再转义一次**参数，引号被加倍。
//   ③ 最终方案：整条命令作为一个字符串放进 `bin`，args 传空数组，用 shell:true 交给系统。
//      这样 Node 不参与参数转义（引号不会被加倍），也不会触发 DEP0190
//      （那条告警针对的是「args 非空 + shell:true」）。
const path = require('node:path')

function quoteForCmd(s) {
  const str = String(s)
  if (/[\s"&|<>^()]/.test(str)) return '"' + str.replace(/"/g, '""') + '"'
  return str
}

function resolveSpawn(bin, args) {
  const list = Array.isArray(args) ? args : []
  if (process.platform !== 'win32') return { bin, args: list, shell: false }
  const s = String(bin)
  // Windows 上交给 shell 的两种：
  //   ① .cmd / .bat（npm、npm 全局装的 CLI）—— Node 不能直接 spawn
  //   ② 不带扩展名的命令名（'npm' / 'npx' / 'cargo'…）—— 让 shell 去 PATH 里解析出 .cmd
  // 反过来，明确的 .exe 直接 spawn，少一层 cmd。
  const needsShell = /\.(cmd|bat)$/i.test(s) || !path.extname(s)
  if (!needsShell) return { bin: s, args: list, shell: false }
  const cmdline = [quoteForCmd(s), ...list.map(quoteForCmd)].join(' ')
  return { bin: cmdline, args: [], shell: true }
}

module.exports = { resolveSpawn, quoteForCmd }
