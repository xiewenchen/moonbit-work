///|
/// 平台内核雏形：工程模型 + 构建编排（封装 `moon`）+ `moon ide` 客户端。
///
/// 这是「桌面 IDE 内核」的最小骨架：先用 MoonBit 把「认识一个工程、驱动构建、
/// 查询语义」的能力做出来，UI 层以后再接。

///|
/// 一条命令的执行结果。
pub(all) struct CommandOutput {
  code : Int
  stdout : String
  stderr : String
} derive(Debug)

///|
/// 运行一个进程并收集 stdout/stderr。
pub async fn run_capture(
  program : String,
  args : Array[String],
  cwd : String,
) -> CommandOutput {
  let (code, out, err) = @process.collect_output(program, args, cwd~)
  {
    code,
    stdout: @utf8.decode_lossy(out.binary()),
    stderr: @utf8.decode_lossy(err.binary()),
  }
}

///|
async fn read_text(path : String) -> String {
  let data = @fs.read_file(path)
  @utf8.decode_lossy(data.binary())
}

///|
/// 一个 MoonBit 模块（对应 `moon.mod`）。
pub(all) struct ModuleInfo {
  dir : String
  name : String
  version : String
} derive(Debug)

///|
fn unquote(s : String) -> String {
  let n = s.length()
  // 必须**首尾都是** `"` 才裁剪，否则会静默吞掉末尾一个字符（曾导致 name/version 解析错）
  if n >= 2 && s.get_char(0) == Some('"') && s.get_char(n - 1) == Some('"') {
    s[1:n - 1].to_owned()
  } else {
    s
  }
}

///|
/// 从 `moon.mod` 文本里抽出 `name` 与 `version`。
fn parse_mod(text : String) -> (String, String) {
  let mut name = ""
  let mut version = ""
  for line in text.split("\n") {
    match line.split_once("=") {
      Some((k, v)) =>
        match k.trim().to_owned() {
          "name" => name = unquote(v.trim().to_owned())
          "version" => version = unquote(v.trim().to_owned())
          _ => ()
        }
      None => ()
    }
  }
  (name, version)
}

///|
fn parent_of(dir : String) -> String? {
  // 同时识别 `/` 与 `\`（本工程 supported_targets = native，Windows 下分隔符为 `\`）
  let slash = dir.rev_find("/")
  let backslash = dir.rev_find("\\")
  let i = match (slash, backslash) {
    (Some(a), Some(b)) => Some(if a > b { a } else { b })
    (Some(a), None) => Some(a)
    (None, Some(b)) => Some(b)
    (None, None) => None
  }
  match i {
    Some(0) => None
    Some(i) => Some(dir[:i].to_owned())
    None => None
  }
}

///|
/// 向上查找的层数上限（防御性：即使路径处理异常也不会无限上溯）。
const MAX_ASCENT : Int = 64

///|
/// 从 `dir` 起向上查找 `moon.mod`，返回模块信息。
///
/// 安全说明：`dir` 来自调用方（IDE 宿主）。它不会被拼接进 shell 命令（仅做文件探测），
/// 但仍限制上溯层数，避免对畸形路径做无意义的大量文件系统探测。
pub async fn find_module(dir : String) -> ModuleInfo? {
  let mut d = dir
  let mut found : ModuleInfo? = None
  let mut going = true
  let mut depth = 0
  while going && depth < MAX_ASCENT {
    depth = depth + 1
    let candidate = d + "/moon.mod"
    if @fs.exists(candidate) {
      let (name, version) = parse_mod(read_text(candidate))
      found = Some({ dir: d, name, version, })
      going = false
    } else {
      match parent_of(d) {
        Some(p) => d = p
        None => going = false
      }
    }
  }
  found
}

// ---------------------------------------------------------------------------
// 构建编排
// ---------------------------------------------------------------------------

///|
/// `moon check`。
pub async fn moon_check(dir : String) -> CommandOutput {
  run_capture("moon", ["check"], dir)
}

///|
/// `moon build --target <target>`。
pub async fn moon_build(dir : String, target : String) -> CommandOutput {
  run_capture("moon", ["build", "--target", target], dir)
}

///|
/// `moon test --target <target>`。
pub async fn moon_test(dir : String, target : String) -> CommandOutput {
  run_capture("moon", ["test", "--target", target], dir)
}

///|
/// `moon fmt`。
pub async fn moon_fmt(dir : String) -> CommandOutput {
  run_capture("moon", ["fmt"], dir)
}

///|
/// `moon version`。
pub async fn moon_version() -> CommandOutput {
  run_capture("moon", ["version"], ".")
}

// ---------------------------------------------------------------------------
// 语言服务（moon ide）
// ---------------------------------------------------------------------------

///|
/// 参数校验：拒绝以 `-` 开头的值，避免被 `moon` / `moon ide` 当作**选项**解析（参数注入）。
fn safe_arg(v : String, what : String) -> String raise {
  if v.has_prefix("-") {
    raise Failure("invalid \{what}: must not start with '-': \{v}")
  }
  v
}

///|
/// 调用 `moon ide <args>`（语义级导航，输出 JSON）。
pub async fn moon_ide(dir : String, args : Array[String]) -> CommandOutput {
  run_capture("moon", ["ide", ..args], dir)
}

///|
/// `moon ide outline` —— 列出文件里的符号。
pub async fn ide_outline(dir : String, file : String) -> CommandOutput {
  moon_ide(dir, ["outline", safe_arg(file, "file")])
}

///|
/// `moon ide peek-def` —— 查符号定义。
pub async fn ide_peek_def(
  dir : String,
  file : String,
  symbol : String,
) -> CommandOutput {
  // 用 `--` 终止选项解析，并对值做前缀校验（双保险）
  moon_ide(dir, [
    "peek-def",
    "--",
    "-f",
    safe_arg(file, "file"),
    "-symbol",
    safe_arg(symbol, "symbol"),
  ])
}
