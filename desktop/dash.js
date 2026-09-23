// 主菜单（工作台）—— 均匀大小、可拖拽排序、可增删的办公组件
//
// 方案（用户要求「随意增删和拖拽的均匀大小组件」）：
//   · 均匀大小 → CSS Grid `repeat(auto-fill, minmax(320px, 1fr))`
//   · 拖拽     → SortableJS（31k star / MIT / 零依赖），只给手柄 .drag 开拖拽
//   · 增删     → 每卡 ✕；顶部「+ 添加组件」
//   · 持久化   → 顺序/显示列表/日程/便签/待办 全存 localStorage
//
// 本轮新增（用户三条要求）：
//   1. 日历：月份可翻页、今日高亮、下方用小字列出本月节假日并标红
//   2. 交互：日历可点选日期、右键出「新建日程」、笔记/日程都可编辑
//   3. 顶部横幅：「去主菜单看看」不再新开窗口而是切到主菜单标签；「关闭」能真关掉并记住
(function () {
  const $ = (id) => document.getElementById(id)
  const KEY = {
    layout: 'moonbit-dash-layout',
    todos: 'moonbit-dash-todos',
    notes: 'moonbit-dash-notes',
    events: 'moonbit-dash-events',
    banner: 'moonbit-banner-hidden',
  }
  const DEFAULT_LAYOUT = ['clock', 'todos', 'calendar', 'notes', 'agenda']
  const HM = window.MOONBIT_HOLIDAYS || {}

  function load(k, dflt) {
    try {
      const v = JSON.parse(localStorage.getItem(k))
      return v === null || v === undefined ? dflt : v
    } catch (_) { return dflt }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch (_) {} }
  const pad = (n) => String(n).padStart(2, '0')
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  let layout = load(KEY.layout, DEFAULT_LAYOUT)
  if (!Array.isArray(layout)) layout = DEFAULT_LAYOUT.slice()
  let sorter = null
  let timer = null
  let calView = null                 // {y, m}：日历当前查看的月份
  let selectedDate = ymd(new Date()) // 选中的日期（日程按它过滤）

  // ── 顶部横幅 ────────────────────────────────────────────────────────
  // 找横幅主体：从「关闭」按钮往上，找到第一个同时含「去主菜单看看」的祖先
  function bannerNode(fromEl) {
    let el = fromEl
    for (let i = 0; i < 8 && el; i++) {
      if (el.textContent && el.textContent.includes('去主菜单看看')) return el
      el = el.parentElement
    }
    return null
  }

  function wireBanner() {
    const go = Array.from(document.querySelectorAll('a')).find((a) => a.textContent.includes('去主菜单看看'))
    if (go && !go.dataset.wired) {
      go.dataset.wired = '1'
      go.removeAttribute('target')      // ← 就是它导致点了新开窗口
      go.setAttribute('href', '#')
      go.onclick = (e) => {
        e.preventDefault()
        const tab = document.querySelector('a[data-view="home"]')
        if (tab) tab.click()
      }
    }
    const close = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.replace(/\s+/g, '') === '关闭')
    if (close && !close.dataset.wired) {
      close.dataset.wired = '1'
      close.onclick = () => {
        const b = bannerNode(close) || close.parentElement
        if (b) b.style.display = 'none'
        try { localStorage.setItem(KEY.banner, '1') } catch (_) {}
      }
    }
    // 之前关过就保持关闭
    if (localStorage.getItem(KEY.banner) === '1') {
      const closeBtn = Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent.replace(/\s+/g, '') === '关闭')
      const b = closeBtn ? bannerNode(closeBtn) : null
      if (b) b.style.display = 'none'
    }
  }

  // ── 组件内容 ────────────────────────────────────────────────────────
  function renderClock(box) {
    const big = document.createElement('div')
    big.className = 'dash-clock'
    big.style.fontSize = '2.8rem'
    const sub = document.createElement('div')
    sub.className = 'empty'
    function upd() {
      const n = new Date()
      big.textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`
      sub.textContent = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())} · 星期${'日一二三四五六'[n.getDay()]}`
    }
    upd()
    box.appendChild(big); box.appendChild(sub)
  }

  // ── 日历（可翻月 / 今日高亮 / 节假日标红 / 点选 / 右键新建日程）──────
  function renderCalendar(box) {
    const now = new Date()
    if (!calView) calView = { y: now.getFullYear(), m: now.getMonth() }
    const { y, m } = calView
    const todayStr = ymd(now)

    // 头部：‹  2026 年 9 月  ›   [回到今天]
    const bar = document.createElement('div')
    bar.className = 'cal-bar'
    const prev = document.createElement('button')
    prev.className = 'wbtn'
    if (window.MBIcons) window.MBIcons.into(prev, 'chevronLeft', 15)
    else prev.textContent = '<'
    prev.title = '上个月'
    prev.onclick = () => { calView.m--; if (calView.m < 0) { calView.m = 11; calView.y-- } redraw() }
    const title = document.createElement('span')
    title.className = 'cal-title'
    title.textContent = `${y} 年 ${m + 1} 月`
    const next = document.createElement('button')
    next.className = 'wbtn'
    if (window.MBIcons) window.MBIcons.into(next, 'chevronRight', 15)
    else next.textContent = '>'
    next.title = '下个月'
    next.onclick = () => { calView.m++; if (calView.m > 11) { calView.m = 0; calView.y++ } redraw() }
    const backToday = document.createElement('button')
    backToday.className = 'ghost cal-today-btn'
    backToday.textContent = '今天'
    backToday.onclick = () => { calView = { y: now.getFullYear(), m: now.getMonth() }; selectedDate = todayStr; redraw() }
    bar.appendChild(prev); bar.appendChild(title); bar.appendChild(next); bar.appendChild(backToday)
    box.appendChild(bar)

    // 网格
    const first = new Date(y, m, 1).getDay()
    const days = new Date(y, m + 1, 0).getDate()
    const grid = document.createElement('div')
    grid.className = 'dash-cal'
    let html = ''
    for (const w of ['日', '一', '二', '三', '四', '五', '六']) html += `<div class="h">${w}</div>`
    for (let i = 0; i < first; i++) html += '<div></div>'
    const monthHolidays = []
    for (let d = 1; d <= days; d++) {
      const ds = `${y}-${pad(m + 1)}-${pad(d)}`
      const cls = ['d']
      if (ds === todayStr) cls.push('today')
      if (HM[ds]) { cls.push('holiday'); monthHolidays.push([d, HM[ds]]) }
      if (ds === selectedDate) cls.push('selected')
      html += `<div class="${cls.join(' ')}" data-date="${ds}">${d}</div>`
    }
    grid.innerHTML = html
    // 事件绑定（用 DOM 事件而不是内联 onclick，避免注入面）
    for (const cell of grid.querySelectorAll('.d[data-date]')) {
      const ds = cell.dataset.date
      cell.onclick = () => { selectedDate = ds; redraw() }
      cell.oncontextmenu = (ev) => {
        ev.preventDefault()
        selectedDate = ds
        showDayMenu(ev.clientX, ev.clientY, ds)
      }
      const evs = (load(KEY.events, {})[ds] || []).length
      if (evs) {
        const dot = document.createElement('span')
        dot.className = 'has-event'
        dot.title = `${evs} 条日程`
        cell.appendChild(dot)
      }
    }
    box.appendChild(grid)

    // 节假日：小字、标红
    const hl = document.createElement('div')
    hl.className = 'cal-holidays'
    if (monthHolidays.length) {
      // 同名连续的合并成区间，读起来更像"放假安排"
      const groups = []
      for (const [d, name] of monthHolidays) {
        const last = groups[groups.length - 1]
        if (last && last.name === name && d === last.end + 1) last.end = d
        else groups.push({ name, start: d, end: d })
      }
      hl.textContent = groups
        .map((g) => `${m + 1}月${g.start}${g.end > g.start ? '–' + g.end : ''}日 ${g.name}`)
        .join(' · ')
      hl.title = hl.textContent      // 一行放不下时用省略号，悬停看全文
    } else {
      hl.textContent = '本月无法定节假日'
      hl.classList.add('none')
    }
    box.appendChild(hl)
  }

  // 右键菜单：新建日程 / 查看这天
  function showDayMenu(x, y, date) {
    const old = $('dayMenu')
    if (old) old.remove()
    const menu = document.createElement('div')
    menu.id = 'dayMenu'
    menu.className = 'day-menu'

    const head = document.createElement('div')
    head.className = 'day-menu-head'
    head.textContent = date
    menu.appendChild(head)

    const inp = document.createElement('input')
    inp.className = 'day-menu-input'
    inp.placeholder = '日程内容，回车新建'
    const doAdd = () => {
      const t = inp.value.trim()
      if (!t) return
      const all = load(KEY.events, {})
      if (!all[date]) all[date] = []
      all[date].push({ text: t, done: false })
      save(KEY.events, all)
      menu.remove()
      selectedDate = date
      redraw()
    }
    inp.onkeydown = (e) => { if (e.key === 'Enter') doAdd() }
    menu.appendChild(inp)

    const addBtn = document.createElement('button')
    addBtn.className = 'wbtn-add'
    addBtn.textContent = '＋ 新建日程'
    addBtn.onclick = doAdd
    menu.appendChild(addBtn)

    const viewBtn = document.createElement('button')
    viewBtn.className = 'wbtn-add'
    viewBtn.textContent = '查看这天的日程'
    viewBtn.onclick = () => { menu.remove(); selectedDate = date; redraw() }
    menu.appendChild(viewBtn)

    document.body.appendChild(menu)
    // 贴边修正，别跑出视口
    const r = menu.getBoundingClientRect()
    menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'
    menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px'
    inp.focus()

    // 点别处就收起
    setTimeout(() => {
      const off = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', off) }
      }
      document.addEventListener('mousedown', off)
    }, 0)
  }

  // ── 待办 ────────────────────────────────────────────────────────────
  function renderTodos(box) {
    const items = load(KEY.todos, [])
    if (!items.length) {
      const e = document.createElement('div')
      e.className = 'empty'
      e.textContent = '还没有待办，下面加一条试试'
      box.appendChild(e)
    } else {
      items.forEach((t, i) => {
        const row = document.createElement('div')
        row.className = 'row'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = !!t.done
        cb.onchange = () => { items[i].done = cb.checked; save(KEY.todos, items); redraw() }
        const span = document.createElement('span')
        span.textContent = t.text
        if (t.done) span.style.textDecoration = 'line-through'
        const del = document.createElement('span')
        del.className = 'mine'
        del.textContent = '删除'
        del.onclick = () => { items.splice(i, 1); save(KEY.todos, items); redraw() }
        row.appendChild(cb); row.appendChild(span); row.appendChild(del)
        box.appendChild(row)
      })
    }
    const add = document.createElement('div')
    add.className = 'add'
    const inp = document.createElement('input')
    inp.placeholder = '添加待办，回车确认'
    inp.onkeydown = (e) => {
      if (e.key !== 'Enter') return
      const t = inp.value.trim()
      if (!t) return
      items.push({ text: t, done: false })
      save(KEY.todos, items)
      redraw()
    }
    add.appendChild(inp)
    box.appendChild(add)
  }

  // ── 便签（可编辑）──────────────────────────────────────────────────
  function renderNotes(box) {
    const ta = document.createElement('textarea')
    ta.className = 'dash-note'
    ta.placeholder = '随手记点什么…（自动保存在本机）'
    ta.value = load(KEY.notes, '')
    let t = null
    ta.oninput = () => { clearTimeout(t); t = setTimeout(() => save(KEY.notes, ta.value), 400) }
    box.appendChild(ta)
  }

  // ── 日程（编辑选中的那一天）─────────────────────────────────────────
  function renderAgenda(box) {
    const all = load(KEY.events, {})
    const list = all[selectedDate] || []
    const tag = document.createElement('div')
    tag.className = 'agenda-date'
    tag.textContent = selectedDate + (selectedDate === ymd(new Date()) ? '（今天）' : '')
    box.appendChild(tag)

    if (!list.length) {
      const e = document.createElement('div')
      e.className = 'empty'
      e.textContent = '这天还没有日程 —— 在日历上右键选「新建日程」'
      box.appendChild(e)
    } else {
      list.forEach((it, i) => {
        const row = document.createElement('div')
        row.className = 'row'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = !!it.done
        cb.onchange = () => { list[i].done = cb.checked; save(KEY.events, all); redraw() }
        const span = document.createElement('span')
        span.textContent = it.text
        if (it.done) span.style.textDecoration = 'line-through'
        const del = document.createElement('span')
        del.className = 'mine'
        del.textContent = '删除'
        del.onclick = () => { list.splice(i, 1); save(KEY.events, all); redraw() }
        row.appendChild(cb); row.appendChild(span); row.appendChild(del)
        box.appendChild(row)
      })
    }
    const add = document.createElement('div')
    add.className = 'add'
    const inp = document.createElement('input')
    inp.placeholder = '给这天加一条日程，回车确认'
    inp.onkeydown = (e) => {
      if (e.key !== 'Enter') return
      const t = inp.value.trim()
      if (!t) return
      if (!all[selectedDate]) all[selectedDate] = []
      all[selectedDate].push({ text: t, done: false })
      save(KEY.events, all)
      redraw()
    }
    add.appendChild(inp)
    box.appendChild(add)
  }

  function renderCountdown(box) {
    const e = document.createElement('div')
    e.className = 'empty'
    e.textContent = '倒数日：写下目标日期，这里显示还剩多少天'
    const add = document.createElement('div')
    add.className = 'add'
    const inp = document.createElement('input')
    inp.type = 'date'
    inp.style.flex = '1'
    const out = document.createElement('div')
    out.className = 'row'
    inp.onchange = () => {
      if (!inp.value) { out.textContent = ''; return }
      const days = Math.ceil((new Date(inp.value + 'T00:00:00') - new Date(ymd(new Date()) + 'T00:00:00')) / 86400000)
      out.textContent = days >= 0 ? `距 ${inp.value} 还有 ${days} 天` : `已过去 ${-days} 天`
    }
    add.appendChild(inp)
    box.appendChild(e); box.appendChild(add); box.appendChild(out)
  }

  const WIDGETS = {
    clock: { title: '时钟', render: renderClock },
    todos: { title: '待办事项', render: renderTodos },
    calendar: { title: '日历', render: renderCalendar },
    notes: { title: '快速便签', render: renderNotes },
    agenda: { title: '日程', render: renderAgenda },
    countdown: { title: '倒数日', render: renderCountdown },
  }

  // ── 工作台渲染 ──────────────────────────────────────────────────────
  function redraw() {
    const grid = $('dashGrid')
    if (!grid) return
    grid.textContent = ''
    for (const type of layout) {
      const def = WIDGETS[type]
      if (!def) continue
      const card = document.createElement('section')
      card.className = 'widget'
      card.dataset.type = type

      const head = document.createElement('header')
      head.className = 'widget-head'
      const label = document.createElement('span')
      label.className = 's-label'
      label.textContent = def.title
      const acts = document.createElement('span')
      acts.className = 'widget-actions'
      const del = document.createElement('button')
      del.className = 'wbtn del'
      // 图标统一走 icons.js 的 SVG（不再用 ✕ 这种字符图标）
      if (window.MBIcons) window.MBIcons.into(del, 'close', 13)
      else del.textContent = 'x'
      del.title = '移除这个组件'
      del.onclick = () => { layout = layout.filter((t) => t !== type); save(KEY.layout, layout); redraw() }
      const drag = document.createElement('button')
      drag.className = 'wbtn drag'
      drag.textContent = '⠿'
      drag.title = '按住拖动排序'
      acts.appendChild(del); acts.appendChild(drag)
      head.appendChild(label); head.appendChild(acts)

      const body = document.createElement('div')
      body.className = 'dash-slot'
      def.render(body)
      card.appendChild(head); card.appendChild(body)
      grid.appendChild(card)
    }
    if (!layout.length) {
      const e = document.createElement('div')
      e.className = 'empty'
      e.textContent = '工作台是空的 —— 点右上角「+ 添加组件」放几个回来'
      grid.appendChild(e)
    }
    bindSortable()
  }

  function bindSortable() {
    const grid = $('dashGrid')
    if (!grid) return
    if (sorter) { try { sorter.destroy() } catch (_) {} sorter = null }
    if (typeof Sortable === 'undefined') return    // 降级：不能拖，其余照常
    sorter = Sortable.create(grid, {
      animation: 150,
      handle: '.drag',
      draggable: '.widget',
      ghostClass: 'widget-ghost',
      onEnd: () => {
        const order = Array.from(grid.querySelectorAll('.widget')).map((el) => el.dataset.type)
        if (order.length) { layout = order; save(KEY.layout, layout) }
      },
    })
  }

  // ── 「+ 添加组件」浮层 ───────────────────────────────────────────────
  function showPicker(anchor) {
    const old = $('dashPicker')
    if (old) { old.remove(); return }
    const missing = Object.keys(WIDGETS).filter((t) => !layout.includes(t))
    if (!missing.length) return
    const box = document.createElement('div')
    box.id = 'dashPicker'
    box.className = 's-card'
    box.style.position = 'absolute'
    box.style.padding = '8px'
    box.style.minWidth = '160px'
    box.style.zIndex = '900'
    for (const t of missing) {
      const b = document.createElement('button')
      b.className = 'ghost'
      b.style.display = 'block'
      b.style.width = '100%'
      b.style.textAlign = 'left'
      b.style.marginBottom = '4px'
      b.textContent = '+ ' + WIDGETS[t].title
      b.onclick = () => { layout.push(t); save(KEY.layout, layout); box.remove(); redraw() }
      box.appendChild(b)
    }
    document.body.appendChild(box)
    const r = anchor.getBoundingClientRect()
    box.style.left = Math.round(r.left - 80) + 'px'
    box.style.top = Math.round(r.bottom + 6) + 'px'
  }

  function tickBanner() {
    const n = new Date()
    const c = $('dashClock')
    if (c) c.textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`
    const d = $('dashDate')
    if (d) d.textContent = `${n.getFullYear()} 年 ${n.getMonth() + 1} 月 ${n.getDate()} 日 · 星期${'日一二三四五六'[n.getDay()]}`
  }

  function start() {
    tickBanner()
    if (!timer) timer = setInterval(tickBanner, 1000)
    wireBanner()
    redraw()
    const add = $('dashAdd')
    if (add && !add.dataset.wired) {
      add.dataset.wired = '1'
      add.onclick = () => showPicker(add)
    }
  }

  window.moonbitDash = {
    start,
    redraw,
    _layout: () => layout,
    _widgets: () => Object.keys(WIDGETS),
    _selected: () => selectedDate,
    _select: (d) => { selectedDate = d; redraw() },
  }
})()
