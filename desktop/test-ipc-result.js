// PH3-IPC-10/11 的验证：统一返回结构 + 异常处理。
//
// 纯逻辑，可进 CI。
const { createHarness } = require('./verify-harness')
const { IPC_CODE, isOk, ok, fail, fromError, conforms, normalize } = require('./ipc-result')

const H = createHarness()
const { chk, eq } = H

console.log('=== ① 边界：null / 空（按记忆，第一组就测它）===')
{
  chk('isOk(null) 不炸且为 false', isOk(null) === false)
  chk('ok(undefined) 不炸', ok().ok === true)
  eq('  data 默认是 null（不是 undefined）', ok().data, null)
  chk('fail(null, null) 不炸且给 INTERNAL', fail(null, null).code === IPC_CODE.INTERNAL, fail(null, null).code)
  chk('fromError(null) 不炸', fromError(null).ok === false)
  chk('conforms(null) → 不合规', conforms(null).ok === false)
  const n = normalize(null)
  chk('normalize(null) 不炸且当失败', n.ok === false)
  chk('IPC_CODE 有常用项', !!IPC_CODE.NO_CLIENT && !!IPC_CODE.NO_PROJECT && !!IPC_CODE.FORBIDDEN)
}

console.log('\n=== ② 四件套：ok / code / error / data ===')
{
  const s = ok({ n: 1 })
  eq('成功 ok=true', s.ok, true)
  eq('  带 code=OK', s.code, IPC_CODE.OK)
  eq('  error 为 null（成功没有错误）', s.error, null)
  eq('  data 是载荷', s.data.n, 1)
  chk('  四件套齐', ['ok', 'code', 'error', 'data'].every((k) => Object.prototype.hasOwnProperty.call(s, k)), JSON.stringify(Object.keys(s)))

  const f = fail(IPC_CODE.NOT_FOUND, '找不到那个文件')
  eq('失败 ok=false', f.ok, false)
  eq('★ code 是**机器可判**的', f.code, 'NOT_FOUND')
  eq('★ error 是**人可读**的', f.error, '找不到那个文件')
  eq('  data 为 null', f.data, null)

  // ★ 这是这一层存在的理由：只有 error 没有 code，界面只能按文案分支
  eq('★★ 有 code 时界面不用猜文案', f.code !== f.error, true)
}

console.log('\n=== ③ 四种语义要能分开（不是"非成功即失败"）===')
{
  // NO_CLIENT（没装客户端）与 NOT_RUN（还没跑）都**不是错误**，但也不是 ok
  const nc = fail(IPC_CODE.NO_CLIENT, '未找到 psql 客户端')
  const nr = fail(IPC_CODE.NOT_RUN, '还没有跑过验证')
  chk('★ NO_CLIENT 与 INTERNAL 是不同的 code', nc.code !== fail(IPC_CODE.INTERNAL, 'x').code)
  chk('★ NOT_RUN 也有自己的 code（不是笼统失败）', nr.code === 'NOT_RUN', nr.code)
  chk('  三者的 code 互不相同', new Set([nc.code, nr.code, IPC_CODE.INTERNAL]).size === 3)
  // 与 Quality 的语义一致：这三件事在界面上要长得不一样
  chk('  且都不是 ok', nc.ok === false && nr.ok === false)
}

console.log('\n=== ④ fromError：异常统一转失败（不各写一遍）===')
{
  const r = fromError(new Error('连接断了'))
  eq('ok=false', r.ok, false)
  eq('  error 取的是 message', r.error, '连接断了')
  eq('  默认 code=INTERNAL', r.code, IPC_CODE.INTERNAL)
  eq('  可指定 code', fromError(new Error('x'), IPC_CODE.TIMEOUT).code, 'TIMEOUT')
  eq('  传字符串也行', fromError('就是字符串').error, '就是字符串')
  chk('  空异常也有可读信息', String(fromError({}).error).length > 0, fromError({}).error)
}

console.log('\n=== ⑤ conforms：审计用（能挑出"缺 code""缺 error"）===')
{
  chk('完整成功 → 合规', conforms(ok(1)).ok === true)
  chk('完整失败 → 合规', conforms(fail('X', 'y')).ok === true)

  const noCode = conforms({ ok: false, error: '出错了' })
  eq('★ 失败但缺 code → 不合规', noCode.ok, false)
  chk('  并点明缺什么', noCode.problems.some((p) => /code/.test(p)), JSON.stringify(noCode.problems))

  const noError = conforms({ ok: false, code: 'X' })
  eq('★ 失败但缺 error → 不合规', noError.ok, false)
  chk('  并说明"用户看不到原因"', noError.problems.some((p) => /error/.test(p)), JSON.stringify(noError.problems))

  chk('★ 光秃秃的 {ok:true} → 缺 data 字段（requireData 时）', conforms({ ok: true }, { requireData: true }).ok === false)
  chk('  不要求 data 时它算合规', conforms({ ok: true }).ok === true)
  chk('缺布尔 ok → 不合规', conforms({ error: 'x' }).ok === false)
  chk('允许静默失败（探测类）', conforms({ ok: false, code: 'X' }, { allowSilent: true }).ok === true)
}

console.log('\n=== ⑥ normalize：把旧形状读成统一结构（给渐进迁移用）===')
{
  const a = normalize({ ok: true, text: 'hi' })
  eq('旧的成功 → ok', a.ok, true)
  eq('  补上 code=OK', a.code, 'OK')
  chk('  额外字段被标出来（不丢）', a.extra.includes('text'), JSON.stringify(a.extra))

  const b = normalize({ ok: false, error: '旧式失败' })
  eq('旧的失败 → ok:false', b.ok, false)
  eq('  ★ 补上 INTERNAL（旧形状没有原因码）', b.code, IPC_CODE.INTERNAL)
  eq('  error 保留', b.error, '旧式失败')

  const c = normalize({ ok: false, code: 'NO_CLIENT', error: 'x' })
  eq('已有 code 的不动它', c.code, 'NO_CLIENT')

  const d = normalize(42, { expectBare: 'data' })
  eq('裸值按"成功载荷"解释', d.ok, true)
  eq('  值保留', d.data, 42)
  const e = normalize(42)
  eq('★ 裸值默认当"不是统一结构"（宁可报出来）', e.ok, false)
  chk('  且说明原因', /不是统一结构/.test(String(e.error)), e.error)
}

console.log('\n=== ⑦ 不改任何既有 handler（渐进）===')
{
  // 这一层是"加"，不是"改"：确认它没有副作用
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, 'ipc-result.js'), 'utf8')
  chk('本模块只导出工具函数，不注册 IPC', src.indexOf('ipcMain.handle') < 0)
  chk('也不 require electron', src.indexOf("require('electron')") < 0)
  chk('★ 包在 IIFE 里（全局脚本不污染）', /\(function \(\) \{/.test(src) && /\}\)\(\)/.test(src))
}

console.log('\n' + H.summary())
process.exit(H.exitCode())
