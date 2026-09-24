'use strict'

/**
 * 验证脚本的公共断言工具（Phase 2 / P19「测试体系」）
 *
 * 为什么要抽出来：原来每个 `verify-*.js` 都自己写一份 `chk`，一共 **16 份定义、三种写法**。
 * 其中一批是"裸布尔"—— 只要传进去的是数组，**恒为真、永远打印 [PASS]**。
 * 历史上真有 25 处这么白白通过了（还有 29 处把"值 + 期望值"传给布尔断言）。
 *
 * 所以这里只提供两种断言，并且**用错会被当场抓住**：
 *
 *   chk(name, ok, detail)   布尔断言。`ok` 不是布尔 → 立刻判失败并提示改写 `eq`。
 *   eq(name, got, want)     JSON 深比较（数组/对象必须用这个）。键序无关。
 *
 * 还有一个 `.eq` 之外的差别：**比较用深比较而不是 `JSON.stringify`** ——
 * 后者对 `{a:1,b:2}` 与 `{b:2,a:1}` 会判不等（键序敏感），是隐藏的假失败来源。
 */

/** 键序无关的稳定序列化（深比较用）。函数/undefined 走 String，避免 stringify 返回 undefined。 */
function stable(v) {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'number') return Number.isNaN(v) ? 'NaN' : String(v)
  if (t === 'string') return JSON.stringify(v)
  if (t === 'boolean' || t === 'bigint') return String(v)
  if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']'
  if (t === 'symbol') return String(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (v instanceof Date) return 'Date(' + v.getTime() + ')'
  if (v instanceof RegExp) return String(v)
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}

function deepEqual(a, b) {
  return stable(a) === stable(b)
}

function safe(v) {
  try {
    return JSON.stringify(v) === undefined ? String(v) : JSON.stringify(v)
  } catch (e) {
    return String(v)
  }
}

/**
 * @param {{log?: (s: string) => void}} [opts]
 * @returns {{chk, eq, pass, fail, failures, summary, exitCode, log}}
 */
function createHarness(opts = {}) {
  const out = typeof opts.log === 'function' ? opts.log : (s) => console.log(s)
  let pass = 0
  let fail = 0
  const failures = []

  /** 布尔断言：**只接受布尔** */
  const chk = (name, ok, detail) => {
    if (ok === true) {
      pass++
      out('  [PASS] ' + name)
      return true
    }
    fail++
    failures.push(name)
    if (typeof ok !== 'boolean') {
      // ★ 这就是防复发的那道闸：以前传数组进来会**静默通过**，现在当场失败
      out('  [FAIL] ' + name + '   ⚠️ chk 只接受布尔（数组/对象比较请用 eq）：' + safe(ok))
    } else {
      out('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
    }
    return false
  }

  /** 相等断言：深比较，键序无关 */
  const eq = (name, got, want) => {
    if (deepEqual(got, want)) {
      pass++
      out('  [PASS] ' + name)
      return true
    }
    fail++
    failures.push(name)
    out('  [FAIL] ' + name + '   got=' + safe(got) + '  want=' + safe(want))
    return false
  }

  return {
    chk,
    eq,
    get pass() { return pass },
    get fail() { return fail },
    get failures() { return failures.slice() },
    summary: () => '结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项',
    exitCode: () => (fail === 0 ? 0 : 1),
    log: out,
  }
}

module.exports = { createHarness, deepEqual, stable, safe }
