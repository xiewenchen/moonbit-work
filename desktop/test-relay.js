// 文件中转站核心逻辑测试：Office 元信息解析 / 备份去重 / 版本 / 还原
// 运行：node test-relay.js
const R = require('./relay-main.js')
const fs = require('fs')
const path = require('path')

const D = '.relay-test'
const DOC = path.join(D, '季度报告.docx')
const XLS = path.join(D, '预算表.xlsx')
const TXT = path.join(D, '备注.txt')

let pass = 0, fail = 0
const chk = (n, ok, d) => { if (ok) { pass++; console.log(`  [PASS] ${n}`) } else { fail++; console.log(`  [FAIL] ${n}  ${d || ''}`) } }
const cleanupBackups = (p) => {
  try {
    const dir = path.join(R.BACKUP_ROOT, require('crypto').createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 16))
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_) {}
}

console.log('备份根目录:', R.BACKUP_ROOT)
for (const p of [DOC, XLS]) cleanupBackups(p)   // 从干净状态开始

console.log('\n=== ① Office 元信息（docx/xlsx 本质是 zip，读 docProps/core.xml）===')
const m1 = R.readOfficeMeta(DOC)
console.log('  docx:', JSON.stringify(m1))
chk('解析出标题', m1 && m1.title === '季度经营报告', m1 && m1.title)
chk('解析出作者', m1 && m1.creator === '张三', m1 && m1.creator)
chk('解析出最后修改人', m1 && m1.modifiedBy === '李四', m1 && m1.modifiedBy)
chk('解析出页数/字数（来自 app.xml）', m1 && m1.pages === '8' && m1.words === '1234', JSON.stringify(m1))

const m2 = R.readOfficeMeta(XLS)
console.log('  xlsx:', JSON.stringify(m2))
chk('xlsx 也能解析', m2 && m2.title === '2026 预算表', m2 && m2.title)
chk('非 Office 文件返回 null', R.readOfficeMeta(TXT) === null)
chk('不存在的文件不抛错', R.readOfficeMeta('nope.docx') === null)

console.log('\n=== ② 备份 + 内容去重 ===')
const b1 = R.backupFile(DOC)
console.log('  第一次:', JSON.stringify({ ok: b1.ok, skipped: b1.skipped, size: b1.version && b1.version.size }))
chk('第一次备份成功', b1.ok === true && b1.skipped !== true)
chk('记录了内容哈希', !!(b1.version && b1.version.contentHash))
const b1b = R.backupFile(DOC)
chk('内容没变 → 不重复存，但明确告知', b1b.ok === true && b1b.skipped === true, JSON.stringify(b1b.reason))

console.log('\n=== ③ 内容变化 → 新版本 ===')
fs.appendFileSync(DOC, Buffer.from('X'))   // 模拟编辑
const b2 = R.backupFile(DOC, '改了内容')
chk('内容变了会新建版本', b2.ok === true && b2.skipped !== true)

console.log('\n=== ④ 版本历史 ===')
const v = R.listVersions(DOC)
console.log('  版本数:', v.count, '名称:', v.name)
chk('列出 2 个版本', v.count === 2, String(v.count))
chk('版本按时间升序', v.versions[0].savedAt < v.versions[1].savedAt, JSON.stringify(v.versions.map((x) => x.savedAt)))
chk('每个版本都能定位到备份文件', v.versions.every((x) => x.exists === true))

console.log('\n=== ⑤ 还原（像代码回滚一样）===')
const oldVersion = v.versions[0]
// 关键：先改内容但**不主动备份** —— 这样才能验证「还原前会把当前状态自动备份」
// （如果当前内容已在历史里，则正确地跳过去重，不产生冗余版本）
fs.appendFileSync(DOC, Buffer.from('这是一次还没备份的改动'))
const before = fs.readFileSync(DOC)
const r = R.restoreVersion(DOC, oldVersion.stamp)
console.log('  还原结果:', JSON.stringify({ ok: r.ok, error: r.error, preBackup: !!r.preBackup }))
chk('还原成功', r.ok === true, r.error)
const after = fs.readFileSync(DOC)
chk('文件内容真的回到了旧版本', !before.equals(after))
chk('尺寸也对上了（等于旧版本）', after.length === oldVersion.size, `${after.length} vs ${oldVersion.size}`)
chk('还原前把「未备份的当前改动」自动存了一份', !!r.preBackup, JSON.stringify(r.preBackup && r.preBackup.version))
const v2 = R.listVersions(DOC)
chk('版本数变成 3（v1 旧版 / v2 改动 / 还原前的改动）', v2.count === 3, String(v2.count))
// 反过来：当前内容已在历史里时，不该再存冗余
const r2 = R.restoreVersion(DOC, oldVersion.stamp)
chk('当前内容已在历史里 → 不重复存（返 skipped）', r2.ok === true && !r2.preBackup, JSON.stringify({ preBackup: r2.preBackup }))

console.log('\n=== ⑥ 汇总列表 / 删除版本 / 边界 ===')
const all = R.listAll()
chk('汇总能看到已备份文件', all.some((x) => x.name === '季度报告.docx'), JSON.stringify(all.map((x) => x.name)))
chk('汇总带版本数与最近保存时间', all.every((x) => typeof x.count === 'number' && x.lastSavedAt))
const del = R.deleteVersion(DOC, v2.versions[2].stamp)
chk('删除单个版本', del.ok === true && del.count === 2, JSON.stringify(del))
chk('备份不存在的文件 → 友好报错', R.backupFile(path.join(D, '不存在.docx')).ok === false)
chk('还原不存在的版本 → 友好报错', R.restoreVersion(DOC, 'nope').ok === false)

console.log(`\n结果：${pass} 通过, ${fail} 失败 / 共 ${pass + fail} 项`)
for (const p of [DOC, XLS]) cleanupBackups(p)
console.log('（已清理测试产生的备份目录）')
