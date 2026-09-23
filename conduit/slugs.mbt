///|
/// slug 的最大字符数（按 Unicode 码点计）。
/// 过长会让 URL 变得笨重，且中文 slug 编码后字节数会膨胀 3 倍。
const SLUG_MAX_CHARS : Int = 60

///|
/// 判断一个非 ASCII 码点是否属于「标点/符号」而非「文字」。
///
/// MoonBit 的 core 只提供 `is_numeric`，没有 Unicode 字母分类，
/// 因此用区间近似。中文场景下最常见的两类是 CJK 标点与全角标点。
///
/// 若不排除，`"重构：把协议层从业务里剥出来"` 的 slug 里会留下全角冒号 `：`，
/// 虽然编码后仍能用，但语义上不属于「词」。
fn is_punct_codepoint(n : Int) -> Bool {
  // 通用标点（—、…、" " 等）
  (n >= 0x2000 && n <= 0x206F) ||
  // CJK 符号与标点（、。〈〉《》「」『』【】etc.）
  (n >= 0x3000 && n <= 0x303F) ||
  // 全角 ASCII 变体中的标点（：！？，．；等）——
  // 注意保留全角字母数字（0xFF10-0xFF19 / 0xFF21-0xFF3A / 0xFF41-0xFF5A）
  (n >= 0xFF01 && n <= 0xFF0F) ||
  (n >= 0xFF1A && n <= 0xFF20) ||
  (n >= 0xFF3B && n <= 0xFF40) ||
  (n >= 0xFF5B && n <= 0xFF65)
}

///|
/// slug 生成：标题 → URL 友好标识。
///
/// 规则：小写化；ASCII 字母数字保留；**非 ASCII 字符（中文/日文等）原样保留**；
/// 其余字符折叠为单个 `-`；去掉首尾 `-`。
///
/// ## 为什么要保留非 ASCII
///
/// 早先的实现只保留 ASCII，导致中文标题几乎必然退化：
/// `"纯中文标题没有任何英文"` → `article`（硬编码兜底），
/// `"MoonBit 写后端是一种什么体验"` → `moonbit`（信息基本丢失）。
/// 结果是所有中文文章的 slug 高度重复、只靠哈希后缀区分，可读性与 SEO 价值全失。
///
/// slug 中的中文在 URL 里会被 percent-encode，这是合法的；
/// 长度上限见 `SLUG_MAX_CHARS`。
pub fn slugify(title : String) -> String {
  let buf = Buffer()
  let mut pending_dash = false
  let mut count = 0
  for c in title.to_lower() {
    let is_ascii_word = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
    // 非 ASCII：保留文字（中文/日文等），但排除标点区间
    let n = c.to_int()
    let is_unicode = n > 127 && !is_punct_codepoint(n)
    if is_ascii_word || is_unicode {
      if count >= SLUG_MAX_CHARS {
        break
      }
      if pending_dash && buf.length() > 0 {
        buf.write_string_utf8("-")
      }
      pending_dash = false
      buf.write_string_utf8(c.to_string())
      count = count + 1
    } else {
      pending_dash = true
    }
  }
  let s = @utf8.decode_lossy(buf.to_bytes())
  // 全部字符都被过滤掉时（理论上不会，因为非 ASCII 已保留）退化为固定词
  if s == "" {
    "article"
  } else {
    s
  }
}

///|
/// 生成带短后缀的 slug（用于去重）：`hello-world-x7f2a1`。
pub fn slug_with_suffix(base : String, salt : String) -> String {
  base + "-" + salt
}

///|
/// 从字符串取一段稳定的短后缀（避免引入随机数依赖）。
pub fn short_salt(seed : String) -> String {
  // FNV-1a 32 位哈希，转 36 进制，取 6 位
  let mut h : UInt = 2166136261U
  for c in seed {
    h = (h ^ c.to_int().reinterpret_as_uint()) * 16777619U
  }
  let s = h.to_string(radix=36)
  if s.length() > 6 {
    s[:6].to_owned()
  } else {
    s
  }
}
