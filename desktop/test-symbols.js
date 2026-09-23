// 符号索引单测： node test-symbols.js
const path = require('path')
const {
  extractHover,
  parseSymbolsJsonl,
  searchSymbols,
  findDefinition,
  symbolFsPath,
  loadSymbols,
} = require('./symbols')

let failed = 0
function check(name, cond, extra) {
  if (!cond) failed++
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name, cond ? '' : JSON.stringify(extra))
}

// 用真实样本（与 gen-symbols 输出同构）
const sample = [
  '{"kind":["Sym","main"],"path":"\\\\cmd\\\\main\\\\main.mbt","pkg":"mbp/platform/cmd/main","tag":"0x1000","range":[5,1,7,2],"name_range":[5,4,5,8],"doc_range":[1,1,4,56]}',
  '{"kind":["Sym","find_header"],"path":"\\\\http\\\\http.mbt","pkg":"mbp/platform/http","tag":"0x1000","range":[119,1,128,2],"name_range":[119,4,119,15],"doc_range":[117,1,118,19]}',
  '{"kind":["Sym","run_capture"],"path":"\\\\kernel\\\\kernel.mbt","pkg":"mbp/platform/kernel","tag":"0x1000","range":[17,1,29,2],"name_range":[17,16,17,27]}',
  'not json',
  '',
  '{"bad":"no name_range"}',
].join('\n')

const syms = parseSymbolsJsonl(sample)
check('解析出 3 个符号（跳过坏行）', syms.length === 3, syms.length)
check('名字正确', syms.map((s) => s.name).join(',') === 'main,find_header,run_capture', syms.map((s) => s.name))
check('行号来自 name_range', syms[2].line === 17 && syms[2].col === 16, syms[2])
check('包含包名', syms[1].package === 'mbp/platform/http', syms[1].package)
check('kind 提取', syms[0].kind === 'Sym', syms[0].kind)

// 搜索
check('搜索 run → 命中', searchSymbols(syms, 'run').length === 1, searchSymbols(syms, 'run'))
check('搜索 header → 命中', searchSymbols(syms, 'header')[0].name === 'find_header')
check('搜索大小写不敏感', searchSymbols(syms, 'RUN').length === 1)
check('空查询 → 空', searchSymbols(syms, '').length === 0)
check('无匹配 → 空', searchSymbols(syms, 'zzz_nope').length === 0)
check('limit 生效', searchSymbols(syms, 'a', 1).length === 1)

// 定义
check('精确定义', findDefinition(syms, 'find_header').line === 119)
check('带限定名取尾段', findDefinition(syms, 'mbp/platform/http.find_header').line === 119)
check('不存在 → null', findDefinition(syms, 'nope_xyz') === null)

// 路径还原
const p = symbolFsPath('/root', syms[2])
check('路径还原为 workspace 下真实路径', p.endsWith(path.join('kernel', 'kernel.mbt')), p)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
