///|
/// MoonBit → Node.js 的 FFI 层（手册 0.2 / 0.3）。
///
/// 核心语法：`extern "js" fn`，等号右边是原生 JS 代码，会被**原样嵌入**生成的 .js。
/// ⚠ 必须写 `extern "js"` —— 漏了的话 MoonBit 会把那个字符串当成 **wasm 内联汇编**去解析，
/// 报 "Inline wasm syntax error: unknown operator =>"（这个坑踩过一次）。
///
/// 这一层让 MoonBit 能直接调用 Node 的 child_process / fs ——
/// 也就是手册说的「后端逻辑用 MoonBit 写，通过 FFI 调 Node.js 生态」。

///|
/// 执行命令并取回 stdout（同步）。与手册 0.2 的写法一致。
pub extern "js" fn exec_sync(cmd : String) -> String = "(cmd) => require('child_process').execSync(cmd, { encoding: 'utf8' })"

///|
/// 执行命令并拿到 { code, stdout, stderr }，**命令失败也不抛异常**而是回传 code。
/// 直接 execSync 在命令失败时会 throw，做 IDE 后端时需要拿到失败信息而不是崩掉。
pub extern "js" fn exec_try(cmd : String) -> String = "(cmd) => { try { const out = require('child_process').execSync(cmd, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); return JSON.stringify({ code: 0, stdout: String(out), stderr: '' }) } catch (e) { return JSON.stringify({ code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || '') }) } }"

///|
/// 读文件（UTF-8）。
pub extern "js" fn read_file(path : String) -> String = "(p) => require('fs').readFileSync(p, 'utf8')"

///|
/// 写文件（UTF-8）。
pub extern "js" fn write_file(path : String, content : String) -> Unit = "(p, c) => { require('fs').writeFileSync(p, c, 'utf8'); }"

///|
/// 列目录，返回 JSON 字符串：`[{"name":..,"dir":true|false}, ...]`。
/// 用 JSON 回传而不是数组，因为跨 FFI 边界传结构化数据最省事的办法就是字符串。
pub extern "js" fn list_dir(path : String) -> String = "(p) => { const fs = require('fs'); const es = fs.readdirSync(p, { withFileTypes: true }); return JSON.stringify(es.map(e => ({ name: e.name, dir: e.isDirectory() }))) }"

///|
/// 当前工作目录。
pub extern "js" fn cwd() -> String = "() => process.cwd()"

///|
/// 打印到 stdout（用于验证 FFI 与运行链路）。
pub extern "js" fn println_js(s : String) -> Unit = "(s) => { process.stdout.write(String(s) + '\\n') }"