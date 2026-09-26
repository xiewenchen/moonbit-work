// PH3-IPC-10：IPC 的**统一返回结构**。
//
// 清单要求 `{ ok, code, error, data }`。为什么要四件套而不是"有个 ok 就行"：
//   · `ok`    —— 机器判成功失败（唯一判据，别用"有没有 error 字段"来推）
//   · `code`  —— **机器可判**的原因（`NO_CLIENT` / `NOT_FOUND` / `BAD_INPUT`…），界面据此分支
//   · `error` —— **人可读**的说明，直接给用户看
//   · `data`  —— 成功时的载荷（可选）
//
// ⚠️ 只有 `error` 没有 `code` 时，界面只能按**文案**分支 —— 文案一改逻辑就坏。
//    这就是这一层存在的理由。
//
// 纯逻辑，可进 CI。**不改**任何既有 handler（渐进）：新代码用这里，
// 旧代码由 audit-ipc 的"形状合规率"基线兜住（只增不减）。
(function () {
'use strict'

/** 常用 code —— 不强制枚举（模块可以有自己的），但这些跨模块应当一致。 */
const IPC_CODE = Object.freeze({
  OK: 'OK',
  BAD_INPUT: 'BAD_INPUT',           // 参数不对
  NOT_FOUND: 'NOT_FOUND',           // 找不到目标（文件/会话/项目）
  NO_PROJECT: 'NO_PROJECT',         // 没打开项目
  OUTSIDE_WORKSPACE: 'OUTSIDE_WORKSPACE',
  FORBIDDEN: 'FORBIDDEN',           // 权限/确认不足
  NO_CLIENT: 'NO_CLIENT',           // 本机没装客户端（**不是错误**）
  NOT_RUN: 'NOT_RUN',               // 还没跑过（**不是失败**）
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',             // 真的出错了
  TIMEOUT: 'TIMEOUT',
})

function isOk(r) { return !!(r && r.ok === true) }

/**
 * 成功。
 * ⚠️ `data` 允许是 undefined，但**不要**用它代替 ok 判断（`if (r.data)` 在 data 合法为 falsy 时会误判）。
 */
function ok(data, extra) {
  const out = { ok: true, code: IPC_CODE.OK, error: null, data: data === undefined ? null : data }
  return extra && typeof extra === 'object' ? Object.assign({}, out, extra, { ok: true }) : out
}

/**
 * 失败。
 * ⚠️ 两个参数都**尽量给**：只给 error 时界面只能按文案分支；只给 code 时用户看不懂。
 */
function fail(code, error, extra) {
  const c = code == null || code === '' ? IPC_CODE.INTERNAL : String(code)
  const e = error == null ? null : String(error)
  const out = { ok: false, code: c, error: e, data: null }
  return extra && typeof extra === 'object' ? Object.assign({}, out, extra, { ok: false }) : out
}

/** 从异常造失败结果（统一在这里做，免得每处各写一遍 `String(e && e.message || e)`）。 */
function fromError(e, code) {
  const msg = String((e && e.message) || e || '未知错误')
  return fail(code || IPC_CODE.INTERNAL, msg)
}

/** 形状是否合规（审计用）。`requireData` 为真时要求有 data 字段（哪怕是 null）。 */
function conforms(r, opts = {}) {
  const problems = []
  if (!r || typeof r !== 'object') return { ok: false, problems: ['不是对象'] }
  if (r.ok !== true && r.ok !== false) problems.push('缺少布尔 ok')
  if (r.ok === false) {
    if (!r.code) problems.push('失败时缺 code（界面只能按文案分支）')
    if (!r.error && !opts.allowSilent) problems.push('失败时缺 error（用户看不到原因）')
  }
  if (opts.requireData === true && !Object.prototype.hasOwnProperty.call(r, 'data')) problems.push('缺 data 字段')
  return { ok: problems.length === 0, problems }
}

/**
 * 把**旧形状**归一成统一结构（给审计与渐进迁移用，不自动替换旧代码）。
 * 能识别：`{ok,error}` / `{ok,code,error}` / 裸值。
 */
function normalize(r, opts = {}) {
  if (r && typeof r === 'object' && typeof r.ok === 'boolean') {
    return { ok: r.ok, code: r.code || (r.ok ? IPC_CODE.OK : IPC_CODE.INTERNAL), error: r.error || null, data: r.data === undefined ? null : r.data, extra: Object.keys(r).filter((k) => !['ok', 'code', 'error', 'data'].includes(k)) }
  }
  // 裸值：按调用方给的期望解释（默认当成功载荷）
  if (opts.expectBare === 'data') return { ok: true, code: IPC_CODE.OK, error: null, data: r === undefined ? null : r, extra: [] }
  return { ok: false, code: IPC_CODE.INTERNAL, error: '返回值不是统一结构', data: null, extra: [] }
}

const API = { IPC_CODE, isOk, ok, fail, fromError, conforms, normalize }

if (typeof module !== 'undefined' && module.exports) module.exports = API
if (typeof window !== 'undefined') window.moonbitIpcResult = API
})()
