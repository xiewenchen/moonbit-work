'use strict'

/**
 * Agent Patch 单测（Phase 2 / MBW-P8-01 ～ P8-11）
 *
 * 这是**风险最高**的一批，所以断言也集中在"防呆"上：
 * 没确认就不改、old 不匹配就不改、危险目标先拦、备份先于写入、写入失败必回滚。
 * 全部用注入的假文件系统 —— 于是"失败恢复"这种只能在真实文件系统上验的行为，可以在这里彻底测。
 */

const os = require('node:os')
const path = require('node:path')
const {
  PATCH_LIMITS,
  createPatch,
  analyzePatch,
  isDangerousPatch,
  renderPatchPreview,
  applyPatch,
} = require('./agent-patch')

let pass = 0
let fail = 0
const failures = []
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)) }
}

const ROOT = path.join(os.tmpdir(), 'ws-patch-test')

/** 内存文件系统 + 调用顺序记录 */
function fakeFs(files = {}, over = {}) {
  const store = Object.assign({}, files)
  const calls = []
  return Object.assign({
    calls,
    store,
    deps: {
      root: ROOT,
      readFile: async (abs) => {
        calls.push('read:' + path.basename(abs))
        if (!(abs in store)) throw new Error('ENOENT')
        return store[abs]
      },
      writeFile: async (abs, content) => {
        calls.push('write:' + path.basename(abs))
        store[abs] = content
      },
      backup: async (abs) => {
        calls.push('backup:' + path.basename(abs))
        return abs + '.bak'
      },
      restore: async (bak) => {
        calls.push('restore:' + path.basename(bak))
        const target = bak.replace(/\.bak$/, '')
        store[target] = 'RESTORED-ORIGINAL'
      },
      confirm: async () => true,
      now: () => 1000,
    },
  }, over)
}

async function main() {
  console.log('\n=== P8-01 Patch Model ===')
  {
    const p = createPatch({ file: ' a.mbt ', old: 'x', new: 'y', summary: ' 修一下 ' })
    chk('字段归一（file trim）', [p.file, p.summary], ['a.mbt', ' 修一下 '])
    chk('缺省不编造', [createPatch().file, createPatch().old], ['', ''])
  }

  console.log('\n=== P8-08 Diff 检查（含"拒绝盲改"）===')
  {
    const content = 'line1\nfn main { }\nline3\n'
    chk('old==new → 拒', /没有实际改动/.test(String(analyzePatch(createPatch({ file: 'a', old: 'x', new: 'x' })).error)), true)
    chk('全空 → 拒', /没有内容/.test(String(analyzePatch(createPatch({ file: 'a' })).error)), true)
    chk('**old 在文件里找不到 → 拒**', /找不到/.test(String(analyzePatch(createPatch({ file: 'a', old: '不存在的内容', new: 'y' }), { fileContent: content }).error)), true)
    chk('**old 出现多次 → 拒（歧义）**', /出现 2 次/.test(String(analyzePatch(createPatch({ file: 'a', old: 'line', new: 'Y' }), { fileContent: 'line\nline\n' }).error)), true)
    chk('正常 patch → 通过并给出行数', (() => { const r = analyzePatch(createPatch({ file: 'a', old: 'fn main { }', new: 'fn main {\n  x\n}' }), { fileContent: content }); return [r.ok, r.addedLines > 0] })(), [true, true])
    chk('过大 patch → 拒', /过大/.test(String(analyzePatch(createPatch({ file: 'a', old: 'x', new: 'X'.repeat(PATCH_LIMITS.maxNewChars + 10) })).error)), true)
  }

  console.log('\n=== P8-09 危险 Patch（安全测试）===')
  {
    const base = { old: 'a', new: 'b' }
    chk('目标 = workspace 根 → 危险', isDangerousPatch(createPatch(Object.assign({ file: '.' }, base)), { root: ROOT }).danger, true)
    chk('.git/config → 危险', isDangerousPatch(createPatch(Object.assign({ file: '.git/config' }, base)), { root: ROOT }).reason, '目标是受保护路径（.git / 密钥 / 凭据）')
    chk('.env → 危险', isDangerousPatch(createPatch(Object.assign({ file: 'config/.env' }, base)), { root: ROOT }).danger, true)
    chk('id_rsa → 危险', isDangerousPatch(createPatch(Object.assign({ file: 'keys/id_rsa' }, base)), { root: ROOT }).danger, true)
    chk('server.pem → 危险', isDangerousPatch(createPatch(Object.assign({ file: 'certs/server.pem' }, base)), { root: ROOT }).danger, true)
    chk('把文件清空 → 危险', isDangerousPatch(createPatch({ file: 'a.mbt', old: 'fn main { }', new: '' }), { root: ROOT }).reason, '会把文件内容清空')
    chk('正常源文件 → 不危险', isDangerousPatch(createPatch({ file: 'src/a.mbt', old: 'x', new: 'y' }), { root: ROOT }).danger, false)
  }

  console.log('\n=== P8-05 默认拒绝：没确认就不改 ===')
  {
    const f = fakeFs({ [path.join(ROOT, 'a.mbt')]: 'fn main { }\n' })
    const d = Object.assign({}, f.deps)
    delete d.confirm                                    // ← 不提供确认
    const r = await applyPatch(createPatch({ file: 'a.mbt', old: 'fn main { }', new: 'fn main { 1 }' }), d)
    chk('没 confirm → 拒', [r.ok, r.reason], [false, 'not-confirmed'])
    chk('**且没有写入、没有备份**', f.calls, ['read:a.mbt'])
    chk('拒绝也带 preview（让人能看到会改什么）', typeof r.preview, 'string')
  }
  {
    const f = fakeFs({ [path.join(ROOT, 'a.mbt')]: 'fn main { }\n' }, {})
    const r = await applyPatch(createPatch({ file: 'a.mbt', old: 'fn main { }', new: 'X' }), Object.assign({}, f.deps, { confirm: async () => false }))
    chk('confirm 返回 false → 拒且不写', [r.ok, f.calls.includes('write:a.mbt')], [false, false])
  }

  console.log('\n=== P8-04 备份必须**先于**写入 ===')
  {
    const f = fakeFs({ [path.join(ROOT, 'a.mbt')]: 'fn main { }\n' })
    const r = await applyPatch(createPatch({ file: 'a.mbt', old: 'fn main { }', new: 'fn main { 2 }' }), f.deps)
    chk('应用成功', [r.ok, r.backupPath], [true, path.join(ROOT, 'a.mbt') + '.bak'])
    chk('**调用顺序：read → backup → write**', f.calls, ['read:a.mbt', 'backup:a.mbt', 'write:a.mbt'])
    chk('文件内容真的改了', f.store[path.join(ROOT, 'a.mbt')], 'fn main { 2 }\n')
    chk('结果带 diff 分析', r.analysis.ok, true)
  }

  console.log('\n=== P8-11 失败自动恢复 ===')
  {
    const f = fakeFs({ [path.join(ROOT, 'a.mbt')]: 'fn main { }\n' }, {})
    const d = Object.assign({}, f.deps, { writeFile: async () => { throw new Error('磁盘满') } })
    const r = await applyPatch(createPatch({ file: 'a.mbt', old: 'fn main { }', new: 'Y' }), d)
    chk('写入失败 → ok:false', [r.ok, /磁盘满/.test(String(r.error))], [false, true])
    chk('**自动从备份恢复**', r.restored, true)
    chk('确实走了 restore', f.calls.includes('restore:a.mbt.bak'), true)
  }
  {
    const f = fakeFs({ [path.join(ROOT, 'a.mbt')]: 'fn main { }\n' }, {})
    const d = Object.assign({}, f.deps, {
      writeFile: async () => { throw new Error('写入炸') },
      restore: async () => { throw new Error('恢复也炸') },
    })
    const r = await applyPatch(createPatch({ file: 'a.mbt', old: 'fn main { }', new: 'Y' }), d)
    chk('恢复也失败 → 明确说明两者都失败', /恢复失败/.test(String(r.error)), true)
  }
  {
    const f = fakeFs({ [path.join(ROOT, 'a.mbt')]: 'fn main { }\n' }, {})
    const d = Object.assign({}, f.deps, { backup: async () => { throw new Error('备份失败') } })
    const r = await applyPatch(createPatch({ file: 'a.mbt', old: 'fn main { }', new: 'Y' }), d)
    chk('**备份失败 → 放弃修改（不写）**', [r.ok, f.calls.includes('write:a.mbt')], [false, false])
  }

  console.log('\n=== P8-06/07 沙箱与存在性 ===')
  {
    const f = fakeFs({ [path.join(ROOT, 'a.mbt')]: 'x' })
    const r1 = await applyPatch(createPatch({ file: '../outside.mbt', old: 'a', new: 'b' }), f.deps)
    chk('越出 workspace → 拒', [r1.ok, r1.reason], [false, 'outside-workspace'])

    const r2 = await applyPatch(createPatch({ file: 'no-such.mbt', old: 'a', new: 'b' }), f.deps)
    chk('文件不存在 → 拒', [r2.ok, r2.reason], [false, 'no-file'])

    const r3 = await applyPatch(createPatch({ file: '.git/config', old: 'a', new: 'b' }), f.deps)
    chk('危险目标 → 拒（在读写之前就拦下）', [r3.ok, r3.reason], [false, 'dangerous'])

    const r4 = await applyPatch(createPatch({ file: 'a.mbt', old: 'zzz', new: 'b' }), f.deps)
    chk('old 匹配不上 → 拒', [r4.ok, r4.reason], [false, 'bad-patch'])
  }

  console.log('\n=== P8-03 Preview / P8-10 审计 ===')
  {
    const pv = renderPatchPreview(createPatch({ file: 'a.mbt', old: 'OLD', new: 'NEW', summary: '改一行' }))
    chk('preview 含新旧内容与摘要', [/a\.mbt/.test(pv), /OLD/.test(pv), /NEW/.test(pv), /改一行/.test(pv)], [true, true, true, true])

    const audits = []
    const f = fakeFs({ [path.join(ROOT, 'a.mbt')]: 'fn main { }\n' })
    await applyPatch(createPatch({ file: 'a.mbt', old: 'fn main { }', new: 'fn main { 3 }' }), Object.assign({}, f.deps, { onAudit: (e) => audits.push(e) }))
    await applyPatch(createPatch({ file: 'a.mbt', old: '不存在', new: 'x' }), Object.assign({}, f.deps, { onAudit: (e) => audits.push(e) }))
    chk('每次尝试留一条审计（含被拒的）', [audits.length, audits[0].accepted, audits[1].accepted], [2, true, false])
    chk('审计含 file/summary/duration/result', [audits[0].file, typeof audits[0].duration, audits[0].result], ['a.mbt', 'number', 'applied'])
  }

  console.log('\n=== P8-02：唯一入口是 applyPatch（没有"直接写"的能力）===')
  {
    const mod = require('./agent-patch')
    chk('模块只导出 patch 相关能力（无 writeFile/直接写）', Object.keys(mod).sort(),
      ['DANGEROUS_PATH_RE', 'PATCH_LIMITS', 'analyzePatch', 'applyPatch', 'createPatch', 'isDangerousPatch', 'renderPatchPreview'])
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项')
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('单测异常退出：' + ((e && e.stack) || e))
  process.exit(1)
})
