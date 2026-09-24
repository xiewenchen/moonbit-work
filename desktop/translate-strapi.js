// 把 Strapi admin 的源码「转译」成 MoonBit IDE 的界面。
//
// 思路（这就是「直接转译」）：
//   外壳（导航栏 / 顶栏 / 布局容器 / 全部 CSS）  ← 原样取自 Strapi 的那份源码
//   工作区（编辑器 / 文件树 / 终端 / 面板）        ← 取自现有 index.html，功能已经验证过
//   文案（Strapi → MoonBit）                     ← 只改名字
//
// 为什么不能用「引入 CSS + 套同名 class」：styled-components 的类名是每次渲染现生成的
// hash，跨刷新会变。所以这里用的是「同一次抓取的 HTML + CSS」，两边天然自洽。
//
// 断言：每一步找不到目标就抛错，绝不静默产出半成品。
const fs = require('fs')
const path = require('path')

const CUR = path.join(__dirname, 'ide-source.html')
// 注意：CUR 必须指向**源码**，不能指向产物。
// 以前这里写的是 index.html（既读又写同一个文件）—— 第一次能跑，第二次就断：
// 产物已经不具备脚本期望的输入结构（如 #app），会报「找不到现有 IDE 的 #app 内容」。
// 现在源（ide-source.html，手改 UI 改这里）与产物（index.html）彻底分开。
const STRAPI_SRC = path.join(__dirname, 'strapi-ui', 'page-source.html')
const BACKUP = path.join(__dirname, 'index.before-translate.html')
const OUT = path.join(__dirname, 'index.html')

const cur = fs.readFileSync(CUR, 'utf8')
const sp = fs.readFileSync(STRAPI_SRC, 'utf8')

function must(cond, msg) {
  if (!cond) { console.error('❌ 断言失败: ' + msg); process.exit(1) }
  console.log('  ✓ ' + msg)
}

// ── ① 从现有 index.html 里切出「我的东西」─────────────────────────────
console.log('=== ① 从现有 IDE 提取工作区 ===')
const myCssM = cur.match(/<style>([\s\S]*?)<\/style>/)
must(myCssM, '找到现有 IDE 的 <style> 块')
const myCss = myCssM[1]

// #app 里的内容（工作区主体）
const appM = cur.match(/<div id="app">([\s\S]*?)\n\s*<div id="palette">/)
must(appM, '找到现有 IDE 的 #app 内容')
let myApp = appM[1]

// 把我的活动栏整段去掉 —— 外壳已经有 Strapi 的左侧导航栏了，留着会重复
const before = myApp.length
myApp = myApp.replace(/<div id="activitybar">[\s\S]*?<\/div>\s*(?=<div id="sidebar">)/, '')
must(myApp.length < before, '移除重复的活动栏（改用 Strapi 的左侧导航）')

// palette / toast / 状态栏等在外面的部分
// palette 及之后，但**不能把资源引入那段也包进来**（否则会和 myAssets 重复），
// 所以用前瞻断在 xterm 的 link 之前。顺便把 #toast 也保住（它在 #app 前面）。
const tailM = cur.match(/(<div id="palette">[\s\S]*?)(?=<link rel="stylesheet" href="\.\/node_modules\/@xterm)/)
must(tailM, '找到 palette（到资源引入之前为止）')
const myTail = tailM[1]
const toastM = cur.match(/<div id="toast"><\/div>/)
must(toastM, '找到 #toast 容器')
const myToast = toastM[0]

// 我引入的资源（xterm css + 5 个 script）
const linksM = cur.match(/(<link rel="stylesheet" href="\.\/node_modules\/@xterm[\s\S]*?<script src="\.\/aiagent\.js"><\/script>)/)
must(linksM, '找到 IDE 的资源引入（xterm + monaco + renderer）')
// 主菜单的办公组件（dash.js）；SortableJS 是 UMD，**必须在 loader.js 之前**，
// 否则会和 xterm 一样被 Monaco 的 define.amd 截胡、window.Sortable 永远不存在
const myAssets = '<script src="./vendor/sortable.min.js"></script>\n    ' + linksM[1] + '\n    <script src="./project-context.js"></script>\n    <script src="./icons.js"></script>\n    <script src="./holidays.js"></script>\n    <script src="./theme.js"></script>\n    <script src="./dash.js"></script>\n    <script src="./relay.js"></script>'

// ── ② 从 Strapi 源码切出「外壳」───────────────────────────────────────
console.log('\n=== ② 从 Strapi 源码提取外壳 ===')
let bodyM = sp.match(/<body[^>]*>([\s\S]*?)<\/body>/)
must(bodyM, '找到 Strapi 源码的 <body>')
let shell = bodyM[1]

// 去掉 Strapi 的模块脚本（file:// 下必然失败）
const scriptCount = (shell.match(/<script/g) || []).length
shell = shell.replace(/<script type="module">[\s\S]*?<\/script>/g, '')
shell = shell.replace(/<script[^>]*src="\/admin\/[^"]*"[^>]*><\/script>/g, '')
shell = shell.replace(/<script[^>]*type="module"[^>]*><\/script>/g, '')
console.log(`  ✓ 移除 Strapi 的 <script>（原本 ${scriptCount} 个，都是 /admin/ 下的模块脚本）`)

// noscript 段也没用，去掉
shell = shell.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')

// ── ③ 改名字：Strapi → MoonBit ────────────────────────────────────────
console.log('\n=== ③ 改名 Strapi → MoonBit ===')
const brandHits = (shell.match(/Strapi/g) || []).length
shell = shell.replace(/Strapi/g, 'MoonBit')
console.log(`  ✓ 替换了 ${brandHits} 处 "Strapi"`)

// 顶部横幅：把 Strapi 的推广文案换成我们自己的（否则一开就写着 "Introducing the new Media Library"）
shell = shell.replace(/Introducing the new Media Library[^<]*/, 'MoonBit 工作台')
shell = shell.replace(/You're now using the revamped version\.?[^<]*/, '时钟 · 日历 · 日程 · 待办 · 便签，都在左边「主菜单」里')
shell = shell.replace(/Read blog post[^<]*/, '去主菜单看看')
shell = shell.replace(/Close the banner\.[^<]*/, '关闭')
// 外链没了就不必 target=_blank 跳出去
shell = shell.replace(/href="https:\/\/strapi\.io[^"]*"/, 'href="#"')
shell = shell.replace(/target="_blank"\s*rel="noreferrer noopener"\s*/g, '')
console.log('  ✓ 顶部横幅文案已换成本项目的')

// ── ④ 导航列表换成我们的 5 个主标签 ──────────────────────────────────
console.log('\n=== ④ 重写左侧导航为 4 个主标签 ===')
// 导航列表 <ul>…</ul>（取第一个含 li+a 的 ul）
const ulStart = shell.search(/<ul[^>]*>/)
must(ulStart >= 0, '找到导航列表 <ul>')
const ulOpenEnd = shell.indexOf('>', ulStart) + 1
const ulClose = shell.indexOf('</ul>', ulStart)
must(ulClose > ulStart, '找到 </ul>')

// 从原列表里抠一个 <li> 当模板（保留它真实的结构与类名）
const ulInner = shell.slice(ulOpenEnd, ulClose)
const liM = ulInner.match(/<li[\s\S]*?<\/li>/)
must(liM, '从原列表里取到一个 <li> 作模板')
let liTpl = liM[0]
// 抠出导航项文字与 svg，用于生成新项
const svgM = liTpl.match(/<svg[\s\S]*?<\/svg>/)
must(svgM, '从模板里取到 <svg> 图标')
const svgTpl = svgM[0]
const textM = liTpl.match(/<span[^>]*>([^<]*)<\/span>/)
const activeCls = (liTpl.match(/class="([^"]*)"/) || [])[1] || ''

// 5 个标签（图标沿用 Strapi 自带的 svg，只换文字与 data-view）
// 5 个标签各自的图标 —— **必须不一样**，否则用户根本分不清哪个是哪个
const ICONS = {
  // 主菜单：四格仪表盘
  home: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="20" height="20" fill="#c0c0cf" aria-hidden="true"><rect x="4" y="4" width="10" height="10" rx="2"/><rect x="18" y="4" width="10" height="10" rx="2"/><rect x="4" y="18" width="10" height="10" rx="2"/><rect x="18" y="18" width="10" height="10" rx="2"/></svg>',
  // 项目：文件夹
  project: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="20" height="20" fill="#c0c0cf" aria-hidden="true"><path d="M4 8a2 2 0 0 1 2-2h6l2 2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>',
  // 文件中转站：档案盒（带抽屉把手）
  agent: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="20" height="20" fill="#c0c0cf" aria-hidden="true"><path d="M7 3h18a2 2 0 0 1 2 2v3H5V5a2 2 0 0 1 2-2z"/><path d="M5 10h22v17a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><rect x="12" y="14" width="8" height="3" rx="1" fill="#181820"/></svg>',
  // AI Agent：对话气泡 + 星火
  ai: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="20" height="20" fill="#c0c0cf" aria-hidden="true"><path d="M16 6C9.9 6 5 9.8 5 14.5c0 2.6 1.5 4.9 3.9 6.4-.2 1.2-.7 2.6-1.8 3.9 2-.3 3.6-1.1 4.7-1.9 1.3.3 2.7.5 4.2.5 6.1 0 11-3.8 11-8.5S22.1 6 16 6z"/><path d="M25 2.4l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>',
  // 工具：扳手
  tools: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="20" height="20" fill="#c0c0cf" aria-hidden="true"><path d="M21.5 6.5a6 6 0 0 0 7.9 7.9l-9.7 9.6a3.5 3.5 0 0 1-5-5z"/><path d="M21.5 6.5l3.5-3.5a4 4 0 0 1 0 5.6"/><circle cx="8.5" cy="23.5" r="2"/></svg>',
}
const TABS = [
  ['home', '主菜单'],
  ['project', '项目'],
  ['agent', '文件中转站'],
  ['ai', 'AI Agent'],
  ['tools', '工具'],
]
function mkLi(view, label, idx) {
  let one = liTpl
  // 换图标：把模板里的 <svg>…</svg> 整段替成该标签自己的（解决“4 个标签长一样”）
  one = one.replace(/<svg[\s\S]*?<\/svg>/, ICONS[view])
  // 打上 data-view，去掉会真跳转的 href，并把无障碍标签改对
  one = one.replace(/<a /, `<a data-view="${view}" `)
  one = one.replace(/href="\/admin[^"]*"/, 'href="#"')
  one = one.replace(/aria-label="[^"]*"/, `aria-label="${label}"`)
  one = one.replace(/aria-current="page"\s*/, '')
  // 换文字
  one = one.replace(/(<span[^>]*>)([^<]*)(<\/span>\s*<\/a>)/, `$1${label}$3`)
  // 第二个之后去掉 active 类
  if (idx > 0) one = one.replace(/class="([^"]*)\bactive\b([^"]*)"/, 'class="$1$2"')
  return one
}
const newLis = TABS.map(([v, l], i) => mkLi(v, l, i)).join('')
shell = shell.slice(0, ulOpenEnd) + newLis + shell.slice(ulClose)
console.log(`  ✓ 导航项从 ${(ulInner.match(/<li/g) || []).length} 个改写为 ${TABS.length} 个`)

// ── ⑤ 主内容区换成 IDE 工作区 ─────────────────────────────────────────
console.log('\n=== ⑤ 主内容区替换为 IDE 工作区 ===')
const mainOpen = shell.search(/<main[^>]*id="main-content"[^>]*>/)
must(mainOpen >= 0, '找到 <main id="main-content">')
const mainTagEnd = shell.indexOf('>', mainOpen) + 1
// 用配平法找 </main>（main 内部还有嵌套 div，不能用第一个 </main>）
let depth = 1, i = mainTagEnd
while (i < shell.length && depth > 0) {
  const nextOpen = shell.indexOf('<main', i)
  const nextClose = shell.indexOf('</main>', i)
  if (nextClose < 0) break
  if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + 5 }
  else { depth--; if (depth === 0) break; i = nextClose + 7 }
}
must(depth === 0, '用配平法定位到 </main>')
const mainInner = shell.slice(mainTagEnd, i)
must(mainInner.length > 1000, `main 内部确实是内容区（${mainInner.length} 字符）`)

// 主内容区按标签切换 —— 主页不是编辑器，编辑器只在「项目」里
const MAINVIEWS = `
                  <div id="mainview-home" class="mainview active">
                    <div class="dash">
                      <div class="s-banner dash-banner">
                        <div>
                          <div class="s-h1">你好，MoonBit</div>
                          <div id="dashDate" class="s-sub"></div>
                        </div>
                        <div id="dashClock" class="dash-clock">--:--:--</div>
                      </div>
                      <div class="dash-bar">
                        <span class="s-label">我的工作台</span>
                        <span class="dash-hint">拖动手柄排序 · 点右侧按钮移除</span>
                        <button id="dashAdd" class="ghost">+ 添加组件</button>
                      </div>
                      <div id="dashGrid" class="dash-grid"></div>
                    </div>
                  </div>
                  <div id="mainview-project" class="mainview">
                    <div id="workbench">
${myApp.trimEnd()}
                    </div>
                    <!-- 未打开项目时的欢迎页：只留「打开 / 新建」两个动作。
                         放在这里（mainview-project 内 + absolute）是关键 —— 它只覆盖
                         「项目」的内容区，不会盖住顶部宣传条与左侧标签栏。 -->
                    <div id="welcomeScreen">
                      <div class="ws-card">
                        <div class="ws-title">MoonBit IDE</div>
                        <div class="ws-sub">还没有打开项目</div>
                        <div class="ws-actions">
                          <button id="wsOpen" class="ws-primary">打开项目</button>
                          <button id="wsNew" class="ws-secondary">新建项目</button>
                        </div>
                        <div class="ws-hint">也可以把项目文件夹直接拖进窗口</div>
                      </div>
                    </div>
                  </div>
                  <div id="mainview-agent" class="mainview">
                    <div class="fm">
                      <!-- 左侧分类。图标一律用内联 SVG（stroke=currentColor），
                           不用 emoji —— emoji 依赖系统字体、彩色、大小基线不可控、语义也模糊。 -->
                      <aside class="fm-side">
                        <div class="fm-sec">我的文件</div>
                        <div class="fm-nav active" data-cat="recent">
                          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/></svg>
                          <span class="lb">最近</span><span class="n"></span>
                        </div>
                        <div class="fm-nav" data-cat="desktop">
                          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>
                          <span class="lb">桌面</span><span class="n"></span>
                        </div>
                        <div class="fm-nav" data-cat="downloads">
                          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v10.5m0 0l-4-4m4 4l4-4M4.5 19h15"/></svg>
                          <span class="lb">下载</span><span class="n"></span>
                        </div>
                        <div class="fm-nav" data-cat="other">
                          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/></svg>
                          <span class="lb">其他位置</span><span class="n"></span>
                        </div>
                        <div class="fm-sec">备份</div>
                        <div class="fm-nav" data-cat="backed">
                          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5h15a1 1 0 0 1 1 1v3.5h-17V5.5a1 1 0 0 1 1-1z"/><path d="M6 9v9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9"/><path d="M10.5 13h3"/></svg>
                          <span class="lb">已备份</span><span class="n"></span>
                        </div>
                        <!-- 「正在监控」不展示给用户：固定就是下载+桌面，用户无需关心；
                             只保留下方一行说明备份目录。 -->
                        <div class="fm-root" id="relayRoot"></div>
                      </aside>

                      <section class="fm-main">
                        <div class="fm-bar">
                          <label class="fm-search">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
                            <input id="fmSearch" placeholder="搜索文件" />
                          </label>
                          <span id="fmCrumb" class="fm-crumb">最近</span>
                          <span class="sp"></span>
                          <div class="fm-seg">
                            <button id="fmViewGrid" class="seg on" title="宫格视图">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>
                            </button>
                            <button id="fmViewList" class="seg" title="列表视图">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>
                            </button>
                          </div>
                          <button id="relayWatchAdd" class="ghost">+ 监控文件夹</button>
                        </div>
                        <div class="fm-cols" id="fmCols" hidden>
                          <button class="c-name" data-sort="name">名称<span class="ar"></span></button>
                          <button class="c-time" data-sort="time">修改时间<span class="ar"></span></button>
                          <button class="c-size" data-sort="size">大小<span class="ar"></span></button>
                          <span class="c-ops"></span>
                        </div>
                        <div id="fmList" class="fm-list grid"></div>
                        <div class="fm-foot" id="fmFoot"></div>
                      </section>
                    </div>
                  </div>
                  <div id="mainview-ai" class="mainview">
                    <div class="ag">
                      <header class="ag-head">
                        <span class="ag-title">AI Agent</span>
                        <span id="agStatus" class="ag-status">检查中…</span>
                        <span class="sp"></span>
                        <button id="agNew" class="ghost">新对话</button>
                        <button id="agConfig" class="ghost">配置模型</button>
                        <button id="agStop" class="ghost" disabled>停止</button>
                      </header>
                      <div id="agLog" class="ag-log">
                        <div class="ag-empty">用自然语言描述你要做的事，例如「解释这个项目的目录结构」。<br />Ctrl+Enter 发送；同一个对话会记住上文（多轮），点「新对话」重新开始。</div>
                      </div>
                      <footer class="ag-foot">
                        <textarea id="agInput" placeholder="输入指令…（Ctrl+Enter 发送）"></textarea>
                        <button id="agSend">发送</button>
                      </footer>
                    </div>
                  </div>
                  <div id="mainview-tools" class="mainview"></div>`
// 目标：把 5 个 mainview 直接挂到 Strapi 的内容网格下。
// 注意不能只替换 <main>：<main> 外面还包着 [data-strapi-main-content]，
// mainview 若留在那个包装里，隐藏这个占位空壳时会把 4 个标签一起隐藏
//（首页区、代码区之前就是这么消失的）。所以要连包装容器一起替换。
const wrapOpen = shell.indexOf('<div data-strapi-main-content')
must(wrapOpen >= 0, '找到 [data-strapi-main-content] 包装容器')
const wrapTagEnd = shell.indexOf('>', wrapOpen) + 1
let wd = 1, wi = wrapTagEnd
while (wi < shell.length && wd > 0) {
  const no = shell.indexOf('<div', wi)
  const nc = shell.indexOf('</div>', wi)
  if (nc < 0) break
  if (no >= 0 && no < nc) { wd++; wi = no + 4 }
  else { wd--; if (wd === 0) break; wi = nc + 6 }
}
must(wd === 0, '用配平法定位到包装容器的 </div>')
shell = shell.slice(0, wrapOpen) + MAINVIEWS + shell.slice(wi + 6)
console.log(`  ✓ 已用 5 个可切换的主视图替换整块主内容包装（原内容 ${mainInner.length} 字符）`)

// ── ⑥ 组装最终 HTML ──────────────────────────────────────────────────
console.log('\n=== ⑥ 组装 ===')
// 转译后必需的补充样式（之前直接改 index.html 加过一次，重跑会丢，所以放进生成器）
const EXTRA_CSS = `
      /* ===========================================================================
         主题：日间（浅色、护眼）/ 夜间（深色）
         ---------------------------------------------------------------------------
         依据（均为实测，不是报的）：
           · W3C WCAG 2.1 SC 1.4.3：正文对比度 ≥ 4.5:1（AA）· 大字/UI ≥ 3:1 · AAA 为 7:1
           · Solarized 的设计原则：「屏幕上纯黑字纯白底 ≈ 在直射阳光下看书，最累眼」
             ——要降的是【亮度对比】，但色相对比要保留，否则可读性崩
           · 实测：夜间 #c0c0cf on #181826 = 9.76:1（舒适）；
             #ffffff on #181826 = 17.54:1（偏刺眼）；日间 #32324d on #f6f6f9 = 11.46:1
         =========================================================================== */

      /* 夜间微调：强文字从 #ffffff(17.5:1) 降到 ~13:1，治“刺眼” */
      :root { --s-text-bright: #dcdce8; }

      /* 日间：完整采用 Strapi light theme 的原装 token（逐值照抄其源码）*/
      :root[data-theme="light"] {
        --s-neutral0: #ffffff;
        --s-neutral100: #f6f6f9;
        --s-neutral150: #eaeaef;
        --s-neutral200: #dcdce4;
        --s-neutral300: #c0c0cf;
        --s-neutral400: #a5a5ba;
        --s-neutral500: #8e8ea9;
        --s-neutral600: #666687;
        --s-neutral700: #4a4a6a;
        --s-neutral800: #32324d;
        --s-neutral900: #212134;
        --s-neutral1000: #212134;
        --s-primary100: #f0f0ff;
        --s-primary200: #d9d8ff;
        --s-primary500: #7b79ff;
        --s-primary600: #4945ff;
        --s-primary700: #271fe0;
        --s-button-primary500: #7b79ff;
        --s-button-primary600: #4945ff;
        --s-button-neutral0: #ffffff;
        --s-danger100: #fcecea; --s-danger200: #f5c0b8; --s-danger500: #ee5e52; --s-danger600: #d02b20; --s-danger700: #b72b1a;
        --s-success100: #eafbe7; --s-success200: #c6f0c2; --s-success500: #5cb176; --s-success600: #328048; --s-success700: #2f6846;
        --s-warning100: #fdf4dc; --s-warning200: #fae7b9; --s-warning500: #f29d41; --s-warning600: #d9822f; --s-warning700: #be5d01;
        --s-secondary100: #eaf5ff; --s-secondary200: #b8e1ff; --s-secondary500: #66b7f1; --s-secondary600: #0c75af; --s-secondary700: #006096;
        --s-alternative100: #f6ecfc; --s-alternative200: #e0c1f4; --s-alternative500: #ac73e6; --s-alternative600: #9736e8; --s-alternative700: #8312d1;

        /* 语义映射：与 Strapi light theme 的角色一一对应 */
        --s-bg-deepest: #f6f6f9;
        --s-bg-panel: #ffffff;
        --s-bg-raised: #eaeaef;
        --s-bg-hover: #eaeaef;
        --s-bg-active: #dcdce4;
        --s-border: #eaeaef;
        --s-border-strong: #dcdce4;
        --s-text: #32324d;
        --s-text-dim: #666687;
        --s-text-faint: #8e8ea9;
        --s-text-bright: #212134;
        --s-primary: #4945ff;
        --s-primary-dark: #271fe0;
        --s-primary-dim: #b2b1ff;
        --s-success: #328048;
        --s-danger: #d02b20;
        --s-warning: #d9822f;
        --s-info: #0c75af;
        --s-alternative: #9736e8;
        --s-shadow-popup: 0px 2px 15px rgba(33, 33, 52, 0.1);
        --s-shadow-table: 0px 1px 4px rgba(33, 33, 52, 0.1);
        --s-shadow-filter: 0px 1px 4px rgba(33, 33, 52, 0.1);
      }

      /* 日间下，Strapi 外壳里写死的深色值（如 body 背景）也要让位 */
      :root[data-theme="light"] body { background: #f6f6f9; color: #32324d; }

      /* 主题切换按钮：固定右下角 —— 它必须「哪个标签下都看得到」，
         而状态栏只在「项目」标签里，所以不能挂状态栏。 */
      #themeToggle { position: fixed; right: 14px; bottom: 14px; z-index: 950; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; font-size: 1.2rem; padding: 6px 12px; border-radius: 4px; background: var(--s-bg-panel); color: var(--s-text-dim); border: 1px solid var(--s-border-strong); box-shadow: var(--s-shadow-popup); }
      #themeToggle:hover { color: var(--s-text-bright); border-color: var(--s-primary); }
      #themeToggle .theme-ico { display: inline-flex; }
      #themeToggle .theme-ico svg { width: 14px; height: 14px; }

      /* ===== 未打开项目：**只影响「项目」标签**，其余标签照常可用 =====
         两处都修过，都不是这样做的：
         ① 写成全局 body.no-project → 会把主菜单/中转站/工具一起锁死（错）；
         ② 用 position:fixed; inset:0 铺满整个窗口 → 把顶部宣传条与左侧标签栏都盖住了（错）。
         现在：welcomeScreen 用 absolute **只覆盖内容区**。注意——它虽然写在
         mainview-project 里，浏览器解析时会被工作台里的未闭合标签挤到外层，
         实际成为「内容区容器」的直接子元素（实测 mpChildren 只有 workbench）。
         所以用 :has() 把这个真正的父容器设为定位上下文，而不是靠 mainview-project。 */
      div:has(> #welcomeScreen) { position: relative; }
      #welcomeScreen { display: none; }
      body.no-project[data-view="project"] #welcomeScreen {
        display: flex; position: absolute; inset: 0; z-index: 90;
        align-items: center; justify-content: center; background: var(--s-bg-deepest);
      }
      /* 无项目且在项目标签时，收起会误点的东西：编译/运行按钮、命令面板、地址栏、编辑器、底部面板 */
      body.no-project[data-view="project"] #titlebar button[data-cmd],
      body.no-project[data-view="project"] #cmdBtn,
      body.no-project[data-view="project"] #cwd,
      body.no-project[data-view="project"] #body,
      body.no-project[data-view="project"] #panel { display: none !important; }
      /* 无项目时品牌与「打开文件夹」保留（给已经在用的用户一条退路） */
      .ws-card { background: var(--s-bg-panel); border: 1px solid var(--s-border); border-radius: 8px; box-shadow: var(--s-shadow-popup); padding: 36px 44px; text-align: center; max-width: 92vw; }
      .ws-title { font-size: 2.2rem; font-weight: var(--s-fw-semi); color: var(--s-text-bright); letter-spacing: .01em; }
      .ws-sub { margin-top: 8px; font-size: 1.2rem; color: var(--s-text-dim); }
      .ws-actions { margin-top: 26px; display: flex; gap: 12px; justify-content: center; }
      .ws-actions button { height: 3.6rem; padding: 0 2rem; font-size: 1.3rem; }
      .ws-secondary { background: transparent !important; color: var(--s-text) !important; border: 1px solid var(--s-border-strong) !important; }
      .ws-secondary:hover { background: var(--s-bg-hover) !important; border-color: var(--s-text-dim) !important; }
      .ws-hint { margin-top: 20px; font-size: 1.1rem; color: var(--s-text-faint); }
      :root[data-theme="light"] .ws-card { background: #ffffff; border-color: #eaeaef; }

      /* 工具标签：工具入口卡（点击切到项目标签并激活对应底部面板）*/
      .tv-head { padding: 18px 20px 6px; font-size: 1.4rem; font-weight: var(--s-fw-semi); color: var(--s-text-bright); }
      .tv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; padding: 12px 20px 20px; }
      .tv-card { background: var(--s-bg-panel); border: 1px solid var(--s-border); border-radius: var(--s-radius); padding: 16px; cursor: pointer; transition: border-color 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94), background-color 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94); }
      .tv-card:hover { border-color: var(--s-primary); background: var(--s-bg-hover); }
      .tv-t { font-size: 1.3rem; font-weight: var(--s-fw-semi); color: var(--s-text-bright); margin-bottom: 6px; }
      .tv-d { font-size: 1.1rem; line-height: 1.5; color: var(--s-text-dim); }
      :root[data-theme="light"] .tv-card { background: #ffffff; border-color: #eaeaef; }
      :root[data-theme="light"] .tv-card:hover { background: #f6f6f9; border-color: #4945ff; }
      :root[data-theme="light"] .tv-t { color: #212134; }
      :root[data-theme="light"] .tv-d { color: #666687; }

      /* 通用确认框（替代原生 confirm）——颜色全走 token，日间/夜间自动跟随 */
      .ask-mask { position: fixed; inset: 0; background: rgba(3, 3, 5, 0.55); z-index: var(--s-z-overlay); display: flex; align-items: center; justify-content: center; cursor: default; }
      .ask-mask[hidden] { display: none; }
      .ask-box { background: var(--s-bg-panel); border: 1px solid var(--s-border); border-radius: var(--s-radius); box-shadow: var(--s-shadow-popup); width: 440px; max-width: 92vw; padding: 20px; }
      .ask-title { font-size: 1.4rem; font-weight: var(--s-fw-semi); color: var(--s-text-bright); margin-bottom: 10px; }
      .ask-body { font-size: 1.2rem; line-height: 1.6; color: var(--s-text-dim); white-space: pre-wrap; margin-bottom: 18px; }
      .ask-actions { display: flex; justify-content: flex-end; gap: 8px; }
      :root[data-theme="light"] .ask-mask { background: rgba(33, 33, 52, 0.35); }
      :root[data-theme="light"] .ask-box { background: #ffffff; border-color: #eaeaef; }

      /* 主视图：同一时刻只显示一个（主页不该也是编辑器）*/
      /* position: relative 是给「欢迎页」用的：welcomeScreen 现在放在 mainview-project 内
         做 absolute 定位，只覆盖内容区，不再铺满窗口。 */
      .mainview { display: none; height: 100%; min-height: 0; position: relative; }
      .mainview.active { display: flex; flex-direction: column; }
      main#main-content { height: 100%; }
      #workbench { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

      /* 主菜单（工作台）：**均匀大小**的 widget 网格，可拖拽排序 + 增删
         网格用 auto-fill 保证每个卡片等宽（这就是「均匀大小」），
         拖拽用 SortableJS（31k star / MIT / 零依赖），只给手柄 .drag 开拖拽。 */
      .dash { padding: 24px; height: 100%; overflow: auto; }
      .dash-banner { border-radius: 4px; padding: 24px; display: flex; align-items: center; justify-content: space-between; color: #ffffff; margin-bottom: 20px; }
      .dash-banner .s-sub { color: rgba(255, 255, 255, 0.85); }
      .dash-clock { font-size: 3.2rem; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
      .dash-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
      .dash-bar .s-label { flex: none; }
      .dash-hint { color: rgb(102, 102, 103); font-size: 1.1rem; }
      .dash-bar #dashAdd { margin-left: auto; }
      /* 行高固定为 310px —— 日历（内容最高的组件）在「6 行月份 + 节假日文字换行」
         这种最坏情况下量到约 302px，留 8px 余量。所有卡片尺寸一致；
         内容超出的在自己卡内滚动，不会把整行撑高。 */
      .dash-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); grid-auto-rows: 310px; gap: 20px; }

      /* widget 卡片（外壳用 Strapi 的 .s-card 同款值）*/
      .widget { background: rgb(33, 33, 52); border: 1px solid rgb(50, 50, 77); border-radius: 4px; box-shadow: rgba(3, 3, 5, 0.2) 1px 1px 10px; padding: 20px; position: relative; }
      .widget-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex: none; }
      .widget-head .s-label { flex: 1; }
      .widget-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s ease; }
      .widget:hover .widget-actions { opacity: 1; }
      .wbtn { height: 2rem; width: 2rem; padding: 0; border: none; background: transparent; color: rgb(165, 165, 186); cursor: pointer; border-radius: 2px; font-size: 1.3rem; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
      .wbtn:hover { background: rgb(50, 50, 77); color: rgb(255, 255, 255); }
      .wbtn.drag { cursor: grab; }
      .wbtn.drag:active { cursor: grabbing; }
      .widget-ghost { opacity: 0.35; }
      .dash-slot { flex: 1; min-height: 0; overflow: auto; }
      .dash-slot .row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 1.3rem; color: rgb(192, 192, 207); }
      .dash-slot .row input { accent-color: rgb(123, 121, 255); }
      .dash-slot .mine { margin-left: auto; color: rgb(165, 165, 186); cursor: pointer; font-size: 1.2rem; }
      .dash-slot .mine:hover { color: rgb(238, 94, 82); }
      .dash-slot .add { display: flex; gap: 8px; margin-top: 10px; }
      .dash-slot .add input { flex: 1; padding: 6px 10px; font-size: 1.2rem; }
      .dash-slot .empty { color: rgb(165, 165, 186); font-size: 1.2rem; padding: 8px 0; }
      /* 日历网格：**高度固定 + 行高自适应均分**。
         为什么不能靠 auto 行高：有的月份 1 号是周五/周六，前面空位多，
         格子总数会超 42 从而多出一行（实测 2027-01 / 2027-05 就是 7 行），
         自然撑高日历 → 卡片被顶出固定行高。固定高度 + 1fr 分成以后，
         6 行与 7 行的总高完全一致。 */
      .dash-cal { display: grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: 1fr; gap: 3px; font-size: 1.1rem; height: 172px; }
      .dash-cal .h { color: rgb(165, 165, 186); text-align: center; }
      .dash-cal .d { text-align: center; padding: 5px 0; border-radius: 4px; color: rgb(192, 192, 207); cursor: pointer; position: relative; user-select: none; }
      .dash-cal .d:hover { background: rgb(50, 50, 77); }
      .dash-cal .d.today { background: rgb(123, 121, 255); color: rgb(24, 24, 38); font-weight: 600; }
      /* 节假日标红（用户要求「一律按照法定节假日来」）*/
      .dash-cal .d.holiday { color: rgb(238, 94, 82); font-weight: 600; }
      .dash-cal .d.today.holiday { color: rgb(24, 24, 38); }
      /* 选中的日期：内描边，和"今天"的实底区分开 */
      .dash-cal .d.selected { box-shadow: inset 0 0 0 2px rgb(123, 121, 255); }
      .dash-cal .d .has-event { position: absolute; left: 50%; bottom: 1px; transform: translateX(-50%); width: 4px; height: 4px; border-radius: 50%; background: rgb(92, 177, 118); }

      /* 日历：月份导航 */
      .cal-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .cal-title { flex: 1; text-align: center; font-weight: var(--s-fw-bold); font-size: 1.3rem; color: rgb(255, 255, 255); }
      .cal-today-btn { height: 2.2rem; padding: 0 8px; font-size: 1.1rem; }

      /* 日历下方：节假日小字、标红 */
     /* 节假日列表：小字标红，**固定为一行**（nowrap + 省略号）——
         否则节日名字一长就换行，把那两个月的卡片顶出固定行高（实测 2027-01/05 溢出 9px）。
         完整文本通过 title 提示。 */
      .cal-holidays { margin-top: 8px; font-size: 1.05rem; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: rgb(238, 94, 82); }
      .cal-holidays.none { color: rgb(102, 102, 103); }

      /* 日历右键菜单 */
      .day-menu { position: fixed; z-index: 999; background: rgb(33, 33, 52); border: 1px solid rgb(74, 74, 106); border-radius: 4px; box-shadow: rgba(3, 3, 5, 0.35) 1px 1px 10px; padding: 8px; min-width: 200px; }
      .day-menu-head { font-size: 1.1rem; color: rgb(165, 165, 186); margin-bottom: 6px; }
      .day-menu-input { width: 100%; padding: 6px 8px; font-size: 1.2rem; margin-bottom: 6px; }
      .wbtn-add { display: block; width: 100%; text-align: left; height: auto; padding: 6px 8px; font-size: 1.2rem; margin-bottom: 4px; border: none; background: transparent; color: rgb(192, 192, 207); border-radius: 4px; }
      .wbtn-add:hover { background: rgb(50, 50, 77); color: rgb(255, 255, 255); }

      /* 日程组件顶部：当前编辑的是哪一天 */
      .agenda-date { font-size: 1.2rem; color: rgb(123, 121, 255); margin-bottom: 6px; font-weight: var(--s-fw-bold); }
      .dash-note { width: 100%; min-height: 84px; resize: vertical; padding: 8px 10px; font-size: 1.2rem; font-family: inherit; }

      /* ===========================================================================
         组件样式统一走 token（这是上一轮漏掉的）
         ---------------------------------------------------------------------------
         上一轮只做了主题「机制」，但组件里的颜色是**写死的深色值** ——
         所以切到日间时卡片 / widget / 右键菜单仍旧是黑的。
         这里按 token 重写一遍，深浅两套自动跟随；
         因此也不再需要为浅色单独写一批 :root[data-theme="light"] .xxx 覆盖（已删）。
         =========================================================================== */
      .dash-banner { background: linear-gradient(90deg, var(--s-primary) 0%, var(--s-alternative) 121.48%); }
      .dash-hint { color: var(--s-text-faint); }
      .widget { background: var(--s-bg-panel); border-color: var(--s-border); box-shadow: var(--s-shadow-table); height: 100%; display: flex; flex-direction: column; }
      .s-card { background: var(--s-bg-panel); border-color: var(--s-border); box-shadow: var(--s-shadow-table); }
      .wbtn { color: var(--s-text-dim); }
      .wbtn:hover { background: var(--s-bg-hover); color: var(--s-text-bright); }
      .dash-slot .row { color: var(--s-text); }
      .dash-slot .row input { accent-color: var(--s-primary); }
      .dash-slot .mine, .dash-slot .empty, .dash-cal .h, .day-menu-head { color: var(--s-text-dim); }
      .dash-slot .mine:hover { color: var(--s-danger); }
      .dash-cal .d { color: var(--s-text); }
      .dash-cal .d:hover { background: var(--s-bg-hover); }
      .dash-cal .d.today { background: var(--s-primary); color: #ffffff; }
      .dash-cal .d.today.holiday { color: #ffffff; }
      .dash-cal .d.holiday { color: var(--s-danger); }
      .dash-cal .d.selected { box-shadow: inset 0 0 0 2px var(--s-primary); }
      .dash-cal .d .has-event { background: var(--s-success); }
      .cal-title { color: var(--s-text-bright); }
      .cal-holidays { color: var(--s-danger); }
      .cal-holidays.none { color: var(--s-text-faint); }
      .day-menu { background: var(--s-bg-panel); border-color: var(--s-border-strong); box-shadow: var(--s-shadow-popup); }
      .wbtn-add { color: var(--s-text); }
      .wbtn-add:hover { background: var(--s-bg-hover); color: var(--s-text-bright); }
      .agenda-date { color: var(--s-primary); }
      /* s-badge 的底色就是语义亮色（两套主题下都是亮的），所以字色固定用深色即可 */

      /* ===========================================================================
         文件中转站（第三个标签）
         参照成熟文件管理器的通用做法（Windows 资源管理器 / Google Drive 的文件列表）：
           · 左分类 + 计数；图标一律 SVG，不用 emoji
           · 顶栏：搜索 + 面包屑 + 宫格/列表分段切换
           · 列表视图带「列头」，点列头排序并显示方向箭头
           · 文件类型用「单色文档图标 + 类型色」区分（Word 蓝 / Excel 绿 / PPT 橙 / PDF 红）
           · 双击用系统默认程序打开、右键出菜单、Ctrl/Shift 多选、状态栏显示选中数
         =========================================================================== */
      /* 转译后 mainview 直接挂在 Strapi 的内容网格下，
         而 Strapi 原来的主内容包装（[data-strapi-main-content]）成了一个空壳，
         仍占着约 203px 高度 —— 就是用户看到的「上方一大块空白」。收掉它。 */
      [data-strapi-main-content] { display: none !important; }

      /* 欢迎页（未打开项目时）*/
      .welcome { padding: 18px 14px; }
      .welcome .w-t { color: var(--s-text-bright); font-size: 1.35rem; font-weight: var(--s-fw-semi); }
      .welcome .w-h { color: var(--s-text-dim); font-size: 1.15rem; line-height: 1.6; margin: 6px 0 14px; }
      .welcome button { width: 100%; }

      .fm { display: flex; height: 100%; overflow: hidden; }

      .fm-side { width: 216px; flex: none; overflow: auto; padding: 10px 8px 16px; background: var(--s-bg-panel); border-right: 1px solid var(--s-border); }
      .fm-sec { color: var(--s-text-faint); font-size: 1.05rem; font-weight: var(--s-fw-bold); text-transform: uppercase; letter-spacing: 0.06em; padding: 14px 10px 5px; }
      .fm-nav { display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 4px; cursor: pointer; color: var(--s-text); font-size: 1.25rem; user-select: none; }
      .fm-nav:hover { background: var(--s-bg-hover); }
      .fm-nav.active { background: var(--s-primary200); color: var(--s-primary); font-weight: var(--s-fw-semi); }
      .fm-nav .ic { width: 16px; height: 16px; flex: none; }
      .fm-nav .ic svg { width: 100%; height: 100%; }
      .fm-nav .lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fm-nav .n { color: var(--s-text-faint); font-size: 1.05rem; }
      .fm-nav.active .n { color: var(--s-primary); }
      .fm-watched { padding: 2px 2px 0; }
      .fm-watch { display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: 4px; color: var(--s-text-dim); font-size: 1.15rem; }
      .fm-watch:hover { background: var(--s-bg-hover); }
      .fm-watch .ic { width: 15px; height: 15px; flex: none; }
      .fm-watch .ic svg { width: 100%; height: 100%; }
      .fm-watch .lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fm-watch .x { flex: none; cursor: pointer; display: flex; opacity: 0.6; }
      .fm-watch .x:hover { opacity: 1; color: var(--s-danger); }
      .fm-watch .x svg { width: 13px; height: 13px; }
      .fm-root { color: var(--s-text-faint); font-size: 1rem; padding: 12px 10px 0; word-break: break-all; }

      .fm-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
      .fm-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--s-border); flex: none; }
      .fm-search { display: flex; align-items: center; gap: 7px; padding: 0 10px; height: 3rem; border: 1px solid var(--s-border); border-radius: 4px; background: var(--s-bg-deepest); width: 240px; }
      .fm-search:focus-within { border-color: var(--s-primary); box-shadow: var(--s-primary) 0 0 0 2px; }
      .fm-search svg { width: 15px; height: 15px; flex: none; color: var(--s-text-dim); }
      .fm-search input { flex: 1; min-width: 0; border: none !important; background: transparent !important; box-shadow: none !important; padding: 0; font-size: 1.2rem; }
      .fm-crumb { color: var(--s-text-dim); font-size: 1.2rem; }
      .fm-bar .sp { flex: 1; }

      .fm-seg { display: flex; border: 1px solid var(--s-border); border-radius: 4px; overflow: hidden; }
      .fm-seg .seg { height: 2.8rem; width: 3.2rem; padding: 0; border: none; border-radius: 0; background: transparent; color: var(--s-text-dim); display: inline-flex; align-items: center; justify-content: center; }
      .fm-seg .seg svg { width: 15px; height: 15px; }
      .fm-seg .seg:hover { background: var(--s-bg-hover); color: var(--s-text); }
      .fm-seg .seg.on { background: var(--s-primary200); color: var(--s-primary); }

      .fm-cols { display: grid; grid-template-columns: 1fr 148px 88px 152px; align-items: center; gap: 10px; padding: 0 16px; height: 3.1rem; border-bottom: 1px solid var(--s-border); flex: none; }
      .fm-cols button { display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent; color: var(--s-text-dim); font-size: 1.1rem; cursor: pointer; padding: 0; height: auto; }
      .fm-cols button:hover { color: var(--s-text-bright); }
      .fm-cols .c-size { justify-content: flex-end; }
      .fm-cols .ar { display: inline-flex; }
      .fm-cols .ar svg { width: 12px; height: 12px; }
      .fm-cols button.on { color: var(--s-primary); }

      .fm-list { flex: 1; overflow: auto; padding: 12px 16px; }
      .fm-list.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; align-content: start; }
      /* 历史版本面板**始终横向占满整行**：宫格布局下它曾被当成一个「格子」，
         宽度只有一列（minmax(150px)），版本内容根本显示不全。 */
      .fm-list.grid > .fm-ver-panel { grid-column: 1 / -1; }
      .fm-list.list { display: block; padding: 0; }

      /* 文件类型着色：单色 SVG 文档图标 + 类型色（不依赖彩色 emoji）*/
      .ftype { display: inline-flex; color: var(--s-text-dim); }
      .ftype svg { width: 100%; height: 100%; }
      .ftype[data-ext="docx"], .ftype[data-ext="doc"], .ftype[data-ext="wps"], .ftype[data-ext="odt"] { color: #2b579a; }
      .ftype[data-ext="xlsx"], .ftype[data-ext="xls"], .ftype[data-ext="et"], .ftype[data-ext="ods"] { color: #217346; }
      .ftype[data-ext="pptx"], .ftype[data-ext="ppt"], .ftype[data-ext="dps"], .ftype[data-ext="odp"] { color: #d24726; }
      .ftype[data-ext="pdf"] { color: #d93025; }

      .fm-card { border: 1px solid var(--s-border); border-radius: 4px; padding: 14px 10px 10px; text-align: center; cursor: pointer; background: var(--s-bg-panel); position: relative; }
      .fm-card:hover { border-color: var(--s-primary); }
      .fm-card.sel { border-color: var(--s-primary); background: var(--s-primary100); box-shadow: inset 0 0 0 1px var(--s-primary); }
      .fm-card .ico { width: 34px; height: 34px; margin: 0 auto 8px; }
      .fm-card .nm { color: var(--s-text-bright); font-size: 1.15rem; word-break: break-all; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 3.2rem; }
      .fm-card .ms { color: var(--s-text-faint); font-size: 1rem; margin-top: 5px; }
      .fm-card .ops { display: flex; gap: 4px; justify-content: center; margin-top: 7px; opacity: 0; transition: opacity 0.12s ease; }
      .fm-card:hover .ops, .fm-card.sel .ops { opacity: 1; }
      .fm-card .ops button { height: 2.2rem; width: 2.4rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
      .fm-card .ops button svg { width: 13px; height: 13px; }
      .fm-card .gone { position: absolute; top: 6px; right: 6px; color: var(--s-danger); display: flex; }
      .fm-card .gone svg { width: 14px; height: 14px; }

      .fm-row { display: grid; grid-template-columns: 1fr 148px 88px 152px; align-items: center; gap: 10px; padding: 0 16px; height: 3.6rem; border-bottom: 1px solid var(--s-border); cursor: pointer; }
      .fm-row:hover { background: var(--s-bg-hover); }
      .fm-row.sel { background: var(--s-primary100); }
      .fm-row .nm { display: flex; align-items: center; gap: 9px; min-width: 0; color: var(--s-text-bright); font-size: 1.25rem; }
      .fm-row .nm .ico { width: 17px; height: 17px; flex: none; }
      .fm-row .nm .tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fm-row .ms, .fm-row .sz { color: var(--s-text-dim); font-size: 1.1rem; }
      .fm-row .sz { text-align: right; }
      .fm-row .ops { display: flex; gap: 4px; justify-content: flex-end; }
      .fm-row .ops button { height: 2.3rem; width: 2.5rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
      .fm-row .ops button svg { width: 13px; height: 13px; }

      .fm-empty { color: var(--s-text-dim); font-size: 1.25rem; padding: 48px 0; text-align: center; }
      .fm-empty .ic { width: 40px; height: 40px; margin: 0 auto 10px; color: var(--s-text-faint); }
      .fm-empty .ic svg { width: 100%; height: 100%; }

      .fm-foot { flex: none; display: flex; align-items: center; gap: 10px; height: 3rem; padding: 0 16px; border-top: 1px solid var(--s-border); color: var(--s-text-dim); font-size: 1.1rem; }
      .fm-foot .sp { flex: 1; }

      .fm-ctx { position: fixed; z-index: 999; background: var(--s-bg-panel); border: 1px solid var(--s-border-strong); border-radius: 4px; box-shadow: var(--s-shadow-popup); padding: 5px; min-width: 190px; }
      .fm-ctx button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; height: auto; padding: 7px 10px; font-size: 1.2rem; border: none; background: transparent; color: var(--s-text); border-radius: 4px; }
      .fm-ctx button:hover { background: var(--s-bg-hover); color: var(--s-text-bright); }
      .fm-ctx button svg { width: 14px; height: 14px; flex: none; }
      .fm-ctx hr { border: none; border-top: 1px solid var(--s-border); margin: 5px 0; }
      .fm-ctx .hdr { color: var(--s-text-faint); font-size: 1.05rem; padding: 4px 10px 6px; word-break: break-all; }

      .fm-ver-panel { border: 1px solid var(--s-border); border-radius: 4px; margin: 12px; padding: 12px; background: var(--s-bg-panel); }
      .fm-ver-panel .ttl { color: var(--s-text-bright); font-size: 1.25rem; margin-bottom: 4px; display: flex; align-items: center; gap: 7px; }
      .fm-ver-panel .ttl svg { width: 15px; height: 15px; color: var(--s-primary); }
      .fm-ver-panel .ttl .tx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      /* 历史版本面板的「收起」按钮（可折叠）*/
      .fm-ver-panel .ttl .fm-ver-close { margin-left: auto; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 2.4rem; height: 2.4rem; padding: 0; background: transparent; border: 0; border-radius: 4px; color: var(--s-text-dim); cursor: pointer; }
      .fm-ver-panel .ttl .fm-ver-close:hover { background: var(--s-bg-hover); color: var(--s-text-bright); }
      .fm-ver-panel .ttl .fm-ver-close svg { width: 13px; height: 13px; color: currentColor; }

      /* ===== AI Agent 的「模型配置」弹窗（参照 Copilot / Hermes 的 key 配置习惯）===== */
      .ag-cfg-box { width: 520px; max-width: 94vw; }
      .ag-cfg-body { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
      .ag-cfg-row { display: flex; flex-direction: column; gap: 5px; }
      .ag-cfg-row > .k { font-size: 1.15rem; color: var(--s-text-dim); }
      .ag-cfg-row input, .ag-cfg-row select { height: 3.2rem; padding: 0 10px; font-size: 1.25rem; font-family: inherit; background: var(--s-bg-deepest); color: var(--s-text); border: 1px solid var(--s-border-strong); border-radius: 5px; }
      .ag-cfg-row input:focus, .ag-cfg-row select:focus { outline: none; border-color: var(--s-primary); }
      .ag-cfg-key { display: flex; gap: 8px; }
      .ag-cfg-key input { flex: 1; min-width: 0; }
      .ag-cfg-key button { flex: none; padding: 0 12px; height: 3.2rem; font-size: 1.15rem; }
      .ag-cfg-hint { font-size: 1.1rem; line-height: 1.6; color: var(--s-text-faint); }
      .ag-cfg-hint.ok { color: var(--s-success); }
      .ag-cfg-hint.err { color: var(--s-danger); }

      /* 运行入口选择器：主标题是人话，小字是实际命令（给懂的人核对） */
      #runPicker button { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; max-width: 460px; }
      #runPicker button .rl { font-size: 1.25rem; }
      #runPicker button .rh { font-size: 1.05rem; color: var(--s-text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 430px; }
      .fm-ver { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 4px; border: 1px solid var(--s-border); margin-top: 6px; font-size: 1.15rem; }
      .fm-ver .t { color: var(--s-text); }
      .fm-ver .sz { color: var(--s-text-dim); margin-left: auto; }
      .fm-ver.cur { border-color: var(--s-success); }
      .fm-ver.cur .t::after { content: '（当前内容）'; color: var(--s-success); font-size: 1rem; }
      .fm-ver button { height: 2.3rem; padding: 0 9px; font-size: 1.1rem; }

      /* ===== AI Agent 标签（第 5 个标签）：对话界面 ===== */
      .ag { display: flex; flex-direction: column; height: 100%; min-height: 0; }
      .ag-head { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--s-border); }
      .ag-head .sp { flex: 1 1 auto; }
      .ag-title { font-size: 1.5rem; font-weight: var(--s-fw-semi); color: var(--s-text-bright); }
      .ag-status { font-size: 1.15rem; color: var(--s-text-dim); }
      .ag-status.ok { color: var(--s-success); }
      .ag-status.bad { color: var(--s-danger); }
      .ag-log { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
      .ag-empty { margin: auto; max-width: 52rem; text-align: center; color: var(--s-text-faint); font-size: 1.25rem; line-height: 1.9; }
      .ag-msg { max-width: 82%; padding: 10px 14px; border-radius: 8px; font-size: 1.25rem; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
      .ag-msg.user { align-self: flex-end; background: var(--s-primary600); color: #fff; }
      .ag-msg.ai { align-self: flex-start; background: var(--s-bg-panel); border: 1px solid var(--s-border); color: var(--s-text); }
      .ag-msg.err { align-self: flex-start; background: transparent; border: 1px solid var(--s-danger); color: var(--s-danger); }
      .ag-tool { align-self: flex-start; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.1rem; color: var(--s-text-dim); }
      .ag-foot { display: flex; gap: 10px; align-items: flex-end; padding: 12px 18px; border-top: 1px solid var(--s-border); }
      .ag-foot textarea { flex: 1; min-height: 4.4rem; max-height: 16rem; resize: vertical; padding: 9px 11px; font-family: inherit; font-size: 1.25rem; line-height: 1.6; background: var(--s-bg-deepest); color: var(--s-text); border: 1px solid var(--s-border-strong); border-radius: 6px; }
      .ag-foot textarea:focus { outline: none; border-color: var(--s-primary); }
      .ag-foot textarea:disabled { opacity: .6; }
`

const final = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: http://127.0.0.1:* http://localhost:*" />
  <title>MoonBit IDE</title>
  <!-- Strapi 原装样式（dark 基础，从运行中的 admin 导出）。加载顺序有讲究：
       base 在前 → light 覆盖表居中（默认 disabled）→ 我们自己的规则放最后，
       这样主题变量与自定义组件的优先级最高。 -->
  <link rel="stylesheet" href="moonbit-ui.css" />
  <link rel="stylesheet" href="moonbit-ui-light.css" id="themeOverride" disabled />
  <style>${myCss}${EXTRA_CSS}</style>
</head>
<body>
${myToast}
${shell}
${myTail}
<!-- AI Agent 的「模型配置」弹窗：在 IDE 内填 key（比“用系统程序打开配置文件”友好得多）。 -->
<div id="agCfgMask" class="ask-mask" hidden>
  <div class="ask-box ag-cfg-box" role="dialog" aria-modal="true" aria-labelledby="agCfgTitle">
    <div class="ask-title" id="agCfgTitle">模型配置</div>
    <div class="ag-cfg-body">
      <label class="ag-cfg-row">
        <span class="k">服务商</span>
        <select id="agCfgPreset"></select>
      </label>
      <label class="ag-cfg-row">
        <span class="k">API Key</span>
        <span class="ag-cfg-key">
          <input id="agCfgKey" type="password" placeholder="粘贴你的 API Key" autocomplete="off" spellcheck="false" />
          <button id="agCfgEye" class="ghost" type="button">显示</button>
        </span>
      </label>
      <label class="ag-cfg-row">
        <span class="k">baseURL</span>
        <input id="agCfgBase" spellcheck="false" />
      </label>
      <label class="ag-cfg-row">
        <span class="k">模型</span>
        <input id="agCfgModel" spellcheck="false" />
      </label>
      <div class="ag-cfg-hint" id="agCfgHint"></div>
    </div>
    <div class="ask-actions">
      <button class="ghost" id="agCfgCancel">取消</button>
      <button id="agCfgSave">保存</button>
    </div>
  </div>
</div>
<!-- 通用确认框：替代原生 confirm()。原生 confirm 是同步阻塞的 —— 弹窗期间渲染
     进程不刷新，叠上 Monaco 的光标样式，用户会看到「鼠标消失」。 -->
<div id="askMask" class="ask-mask" hidden>
  <div class="ask-box" role="dialog" aria-modal="true" aria-labelledby="askTitle">
    <div class="ask-title" id="askTitle"></div>
    <div class="ask-body" id="askBody"></div>
    <div class="ask-actions">
      <button class="ghost" id="askCancel">取消</button>
      <button id="askOk">确认</button>
    </div>
  </div>
</div>
${myAssets}
</body>
</html>
`

fs.writeFileSync(OUT, final, 'utf8')
console.log(`  ✓ ${path.basename(CUR)}（源）→ ${path.basename(OUT)}（产物）`)
console.log(`  ✓ 写出 ${path.basename(OUT)}（${(Buffer.byteLength(final) / 1024).toFixed(1)} KB）`)
console.log('\n完成。')
