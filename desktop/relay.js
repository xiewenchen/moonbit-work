// 文件中转站（第三个标签）—— 工具型的文件管理界面
//
// 设计参照成熟文件管理器的通行做法（Windows 资源管理器 / Google Drive）：
//   · 左侧分类（带计数）+ 右侧文件区；图标全部是内联 SVG，**不用 emoji**
//   · 宫格 / 列表两种视图；列表带列头，点列头排序并显示方向箭头
//   · 双击用系统默认程序打开；单击选中；Ctrl/Shift 多选
//   · 右键菜单（打开 / 在资源管理器中显示 / 备份 / 历史版本）
//   · 状态栏显示「选中 N 项」与备份目录
// 业务规则（用户定的）：固定监控 下载+桌面；是否备份由用户按按钮决定；备份在 ~/.moonbit-backups/
(function () {
  const $ = (id) => document.getElementById(id)
  const api = window.moonAPI
  const I = window.MBIcons
  if (!api || !api.relayStatus || !I) return

  const fmtTime = (iso) => {
    if (!iso) return '—'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return String(iso)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const fmtSize = (n) => {
    n = n || 0
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
    if (n >= 1024) return Math.round(n / 1024) + ' KB'
    return n + ' B'
  }
  const say = (m, k) => { try { if (typeof toast === 'function') toast(m, k) } catch (_) {} }
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e }
  const icon = (name, size) => { const s = el('span', 'ftype'); I.into(s, name, size || 16); return s }
  const extOf = (n) => String(n).split('.').pop().toLowerCase()
  const isFixed = (d) => /[\\/](Downloads|Desktop)$/i.test(d)
  const CAT = { recent: '最近', desktop: '桌面', downloads: '下载', other: '其他位置', backed: '已备份' }

  const state = { cat: 'recent', view: 'grid', sort: 'time', dir: 'desc', q: '', sel: new Set(), anchor: null, verFor: null }
  let data = { files: [], backed: [], watched: [], root: '' }

  // ── 数据 ──────────────────────────────────────────────────────────
  async function load() {
    try {
      const st = await api.relayStatus()
      const backed = await api.relayList()
      const map = new Map()
      for (const r of st.recent || []) map.set(r.path, { ...r, from: '监控' })
      for (const t of st.touched || []) if (!map.has(t.path)) map.set(t.path, { ...t, from: 'IDE' })
      data = { files: [...map.values()], backed, watched: st.watched || [], root: st.root || '' }
    } catch (e) {
      say('读取中转站失败：' + e.message, 'err')
      data = { files: [], backed: [], watched: [], root: '' }
    }
  }
  const catOf = (p) => (/[\\/]Desktop([\\/]|$)/i.test(p) ? 'desktop' : /[\\/]Downloads([\\/]|$)/i.test(p) ? 'downloads' : 'other')

  function visible() {
    const backedSet = new Set(data.backed.map((b) => b.src))
    let list
    if (state.cat === 'backed') {
      list = data.backed.map((b) => ({
        path: b.src, name: b.name, size: b.lastSize, mtime: b.lastSavedAt,
        backed: true, count: b.count, exists: b.exists,
      }))
    } else {
      list = data.files
        .filter((f) => state.cat === 'recent' || catOf(f.path) === state.cat)
        .map((f) => {
          const b = data.backed.find((x) => x.src === f.path)
          return { ...f, backed: backedSet.has(f.path), count: b ? b.count : 0, exists: true }
        })
    }
    if (state.q) {
      const q = state.q.toLowerCase()
      list = list.filter((f) => String(f.name).toLowerCase().includes(q))
    }
    const s = state.sort
    const mul = state.dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      if (s === 'name') return String(a.name).localeCompare(String(b.name)) * mul
      if (s === 'size') return ((a.size || 0) - (b.size || 0)) * mul
      return String(a.mtime || '').localeCompare(String(b.mtime || '')) * mul
    })
    return list
  }

  // ── 左栏 ──────────────────────────────────────────────────────────
  function renderSide() {
    const n = { recent: data.files.length, desktop: 0, downloads: 0, other: 0, backed: data.backed.length }
    for (const f of data.files) n[catOf(f.path)]++
    for (const nav of document.querySelectorAll('.fm-nav')) {
      const c = nav.dataset.cat
      nav.classList.toggle('active', c === state.cat)
      const cnt = nav.querySelector('.n')
      if (cnt) cnt.textContent = n[c] != null ? String(n[c]) : ''
    }
    const box = $('relayWatched')
    if (box) {
      box.textContent = ''
      for (const d of data.watched) {
        const fixed = isFixed(d)
        const row = el('div', 'fm-watch')
        row.appendChild(icon(fixed ? 'pin' : 'folder', 15)).className = 'ic'
        row.appendChild(el('span', 'lb', d.replace(/^.*[\\/]/, '') || d))
        row.title = d + (fixed ? '（固定监控）' : '')
        if (!fixed) {
          const x = el('span', 'x')
          I.into(x, 'close', 13)
          x.title = '停止监控'
          x.onclick = async (ev) => {
            ev.stopPropagation()
            const r = await api.relayWatchRemove(d)
            if (r && r.ok === false) say(r.error || '无法移除', 'err')
            refresh()
          }
          row.appendChild(x)
        }
        box.appendChild(row)
      }
    }
    const root = $('relayRoot')
    if (root) root.textContent = data.root ? '备份目录 ' + data.root : ''
  }

  // ── 右主区 ────────────────────────────────────────────────────────
  function renderCols() {
    const cols = $('fmCols')
    if (!cols) return
    cols.hidden = state.view !== 'list'
    for (const b of cols.querySelectorAll('button')) {
      const on = b.dataset.sort === state.sort
      b.classList.toggle('on', on)
      const ar = b.querySelector('.ar')
      ar.textContent = ''
      if (on) I.into(ar, state.dir === 'asc' ? 'arrowUp' : 'arrowDown', 12)
    }
  }

  function renderFoot(count) {
    const f = $('fmFoot')
    if (!f) return
    f.textContent = ''
    f.appendChild(el('span', null, state.sel.size ? `已选中 ${state.sel.size} 项 / 共 ${count} 项` : `共 ${count} 项`))
    f.appendChild(el('span', 'sp'))
    f.appendChild(el('span', null, data.root ? '备份位置 ' + data.root : ''))
  }

  function renderList() {
    const box = $('fmList')
    if (!box) return
    box.className = 'fm-list ' + state.view
    box.textContent = ''
    const crumb = $('fmCrumb')
    if (crumb) crumb.textContent = CAT[state.cat] + (state.q ? ` · 搜索「${state.q}」` : '')
    renderCols()

    if (state.verFor) renderVersionPanel(box)

    const list = visible()
    renderFoot(list.length)
    if (!list.length) {
      const e = el('div', 'fm-empty')
      const ic = el('div', 'ic')
      I.into(ic, 'empty', 40)
      e.appendChild(ic)
      e.appendChild(el('div', null, state.q ? '没有匹配的文件' : (state.cat === 'backed' ? '还没有备份 —— 在文件上点备份，或右键选「备份当前内容」' : '这里还没有文件经过')))
      box.appendChild(e)
      return
    }
    for (const f of list) box.appendChild(state.view === 'grid' ? card(f) : row(f))
  }

  function bindItem(node, f) {
    if (state.sel.has(f.path)) node.classList.add('sel')
    node.onclick = (ev) => {
      if (ev.ctrlKey || ev.metaKey) {
        state.sel.has(f.path) ? state.sel.delete(f.path) : state.sel.add(f.path)
        state.anchor = f.path
      } else if (ev.shiftKey && state.anchor) {
        const list = visible().map((x) => x.path)
        const a = list.indexOf(state.anchor), b = list.indexOf(f.path)
        if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.sel.add(list[i])
      } else {
        state.sel.clear(); state.sel.add(f.path); state.anchor = f.path
      }
      renderList()
    }
    node.ondblclick = () => openFile(f)
    node.oncontextmenu = (ev) => {
      ev.preventDefault()
      if (!state.sel.has(f.path)) { state.sel.clear(); state.sel.add(f.path); state.anchor = f.path; renderList() }
      ctxMenu(ev.clientX, ev.clientY, f)
    }
  }

  function card(f) {
    const c = el('div', 'fm-card')
    const ico = el('span', 'ico')
    ico.className = 'ico ftype'
    ico.dataset.ext = extOf(f.name)
    I.into(ico, 'file', 34)
    c.appendChild(ico)
    c.appendChild(el('div', 'nm', f.name))
    const bits = [fmtTime(f.mtime), fmtSize(f.size)]
    if (f.backed) bits.push(f.count + ' 版')
    c.appendChild(el('div', 'ms', bits.join(' · ')))
    const ops = el('div', 'ops')
    ops.appendChild(backupBtn(f))
    if (f.backed) ops.appendChild(verBtn(f))
    c.appendChild(ops)
    if (f.exists === false) {
      const g = el('span', 'gone')
      I.into(g, 'warn', 14)
      g.title = '原文件已不在'
      c.appendChild(g)
    }
    bindItem(c, f)
    return c
  }

  function row(f) {
    const r = el('div', 'fm-row')
    const nm = el('div', 'nm')
    const ico = el('span', 'ico ftype')
    ico.dataset.ext = extOf(f.name)
    I.into(ico, 'file', 17)
    nm.appendChild(ico)
    nm.appendChild(el('span', 'tx', f.name))
    r.appendChild(nm)
    r.appendChild(el('div', 'ms', fmtTime(f.mtime)))
    r.appendChild(el('div', 'sz', fmtSize(f.size)))
    const ops = el('div', 'ops')
    ops.appendChild(backupBtn(f))
    if (f.backed) ops.appendChild(verBtn(f))
    r.appendChild(ops)
    bindItem(r, f)
    return r
  }

  function backupBtn(f) {
    const b = el('button')
    I.into(b, 'save', 13)
    b.title = f.backed ? '再备份一版' : '备份这个文件'
    b.onclick = async (ev) => {
      ev.stopPropagation(); b.disabled = true
      const r = await api.relayBackup(f.path, '')
      b.disabled = false
      if (!r.ok) say('备份失败：' + (r.error || '未知原因'), 'err')
      else if (r.skipped) say('内容与已有版本相同，未重复备份')
      else say('已备份（共 ' + r.index.versions.length + ' 个版本）', 'ok')
      refresh()
    }
    return b
  }
  function verBtn(f) {
    const b = el('button')
    I.into(b, 'history', 13)
    b.title = '历史版本'
    b.onclick = (ev) => { ev.stopPropagation(); state.verFor = state.verFor === f.path ? null : f.path; renderList() }
    return b
  }

  async function openFile(f) {
    const r = await api.relayOpen(f.path)
    if (!r.ok) say('打不开：' + (r.error || '文件可能已被移动或删除'), 'err')
  }

  function renderVersionPanel(box) {
    const f = [...data.files, ...data.backed.map((b) => ({ path: b.src, name: b.name }))].find((x) => x.path === state.verFor)
    if (!f) { state.verFor = null; return }
    const p = el('div', 'fm-ver-panel')
    const ttl = el('div', 'ttl')
    const hi = el('span'); I.into(hi, 'history', 15)
    ttl.appendChild(hi)
    ttl.appendChild(el('span', 'tx', '历史版本 · ' + f.name))
    // 收起按钮：这个面板是**可折叠**的 —— 右键菜单再点一次、按 Esc 也能收起
    const cls = el('button', 'fm-ver-close')
    I.into(cls, 'close', 13)
    cls.title = '收起历史版本（Esc）'
    cls.onclick = () => { state.verFor = null; renderList() }
    ttl.appendChild(cls)
    p.appendChild(ttl)

    api.relayVersions(f.path).then((v) => {
      if (!v.count) p.appendChild(el('div', 'fm-empty', '还没有版本记录'))
      for (const ver of [...v.versions].reverse()) {
        const line = el('div', 'fm-ver')
        line.appendChild(el('span', 't', fmtTime(ver.savedAt) + (ver.note ? '（' + ver.note + '）' : '')))
        line.appendChild(el('span', 'sz', fmtSize(ver.size)))
        if (ver.exists) {
          const rs = el('button', null, '还原到此版本')
          rs.title = '恢复成这个版本（还原前会自动备份当前内容，所以还能退回来）'
          rs.onclick = async () => {
            if (!confirm(`把\n${f.name}\n还原到 ${fmtTime(ver.savedAt)} 这个版本？\n\n（当前内容会先自动备份一次）`)) return
            const res = await api.relayRestore(f.path, ver.stamp)
            if (!res.ok) say('还原失败：' + res.error, 'err')
            else say(res.preBackup ? '已还原，并把还原前的内容也存了一份' : '已还原', 'ok')
            refresh()
          }
          line.appendChild(rs)
          const d = el('button', null, '删除')
          d.className = 'ghost'
          d.title = '只删这个历史版本，不动原文件'
          d.onclick = async () => {
            if (!confirm('删掉这个历史版本？原文件不受影响。')) return
            await api.relayDelete(f.path, ver.stamp)
            refresh()
          }
          line.appendChild(d)
        } else {
          line.appendChild(el('span', 'sz', '备份文件已丢失'))
        }
        p.appendChild(line)
      }
    }).catch(() => p.appendChild(el('div', 'fm-empty', '读取版本失败')))
    box.appendChild(p)
  }

  // ── 右键菜单 ──────────────────────────────────────────────────────
  function ctxMenu(x, y, f) {
    const old = $('fmCtx')
    if (old) old.remove()
    const m = el('div', 'fm-ctx')
    m.id = 'fmCtx'
    const multi = state.sel.size > 1
    m.appendChild(el('div', 'hdr', multi ? `已选中 ${state.sel.size} 个文件` : f.name))
    const add = (iconName, label, fn, disabled) => {
      const b = el('button')
      const ic = el('span'); I.into(ic, iconName, 14)
      b.appendChild(ic)
      b.appendChild(el('span', null, label))
      if (disabled) { b.disabled = true; b.style.opacity = '0.45' } else b.onclick = () => { m.remove(); fn() }
      m.appendChild(b)
    }
    add('open', '打开', () => openFile(f))
    add('reveal', '在资源管理器中显示', async () => {
      const r = await api.relayReveal(f.path)
      if (!r.ok) say('无法定位：' + (r.error || ''), 'err')
    })
    m.appendChild(el('hr'))
    add('save', multi ? `备份选中的 ${state.sel.size} 个文件` : '备份当前内容', async () => {
      const targets = multi ? [...state.sel] : [f.path]
      let ok = 0, skip = 0, bad = 0
      for (const p of targets) {
        const r = await api.relayBackup(p, '')
        if (!r.ok) bad++
        else if (r.skipped) skip++
        else ok++
      }
      say(`备份完成：新增 ${ok}，跳过（内容未变）${skip}${bad ? '，失败 ' + bad : ''}`, bad ? 'err' : 'ok')
      refresh()
    })
    // 与文件卡上的「历史版本」按钮一致：再点一次就收起（可折叠）
    const verOpen = state.verFor === f.path
    add('history', verOpen ? '收起历史版本' : '查看历史版本', () => { state.verFor = verOpen ? null : f.path; renderList() })
    m.appendChild(el('hr'))
    add('refresh', '刷新列表', () => refresh())

    document.body.appendChild(m)
    const r = m.getBoundingClientRect()
    m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'
    m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px'
    setTimeout(() => {
      const off = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', off) } }
      document.addEventListener('mousedown', off)
    }, 0)
  }

  // ── 刷新 / 接线 ───────────────────────────────────────────────────
  async function refresh() {
    await load()
    renderSide()
    renderList()
  }

  function wire() {
    for (const nav of document.querySelectorAll('.fm-nav')) {
      if (nav.dataset.wired) continue
      nav.dataset.wired = '1'
      nav.onclick = () => {
        state.cat = nav.dataset.cat; state.verFor = null; state.q = ''; state.sel.clear()
        const s = $('fmSearch'); if (s) s.value = ''
        renderSide(); renderList()
      }
    }
    const s = $('fmSearch')
    if (s && !s.dataset.wired) {
      s.dataset.wired = '1'
      let t = null
      s.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.q = s.value.trim(); renderList() }, 200) }
    }
    const setView = (v) => {
      state.view = v
      $('fmViewGrid').classList.toggle('on', v === 'grid')
      $('fmViewList').classList.toggle('on', v === 'list')
      renderList()
    }
    if ($('fmViewGrid') && !$('fmViewGrid').dataset.wired) {
      $('fmViewGrid').dataset.wired = $('fmViewList').dataset.wired = '1'
      $('fmViewGrid').onclick = () => setView('grid')
      $('fmViewList').onclick = () => setView('list')
    }
    const cols = $('fmCols')
    if (cols && !cols.dataset.wired) {
      cols.dataset.wired = '1'
      for (const b of cols.querySelectorAll('button[data-sort]')) {
        b.onclick = () => {
          const k = b.dataset.sort
          if (state.sort === k) state.dir = state.dir === 'asc' ? 'desc' : 'asc'
          else { state.sort = k; state.dir = k === 'name' ? 'asc' : 'desc' }
          renderList()
        }
      }
    }
    const add = $('relayWatchAdd')
    if (add && !add.dataset.wired) {
      add.dataset.wired = '1'
      add.onclick = async () => {
        const dir = await api.pickDir()
        if (!dir) return
        const r = await api.relayWatchAdd(dir)
        if (!r.ok) say('无法监控：' + r.error, 'err')
        else if (r.already) say('这个文件夹已经在监控里了')
        else say('开始监控：' + dir, 'ok')
        refresh()
      }
    }
    if (!document.__fmKeyWired) {
      document.__fmKeyWired = 1
      document.addEventListener('keydown', (ev) => {
        const panel = document.getElementById('mainview-agent')
        if (!panel || getComputedStyle(panel).display === 'none') return
        if (ev.key === 'Escape') {
          const m = $('fmCtx'); if (m) m.remove()
          if (state.verFor) { state.verFor = null; renderList() }
        }
        if (ev.key === 'Enter' && state.sel.size === 1) {
          const p = [...state.sel][0]
          const f = visible().find((x) => x.path === p)
          if (f) openFile(f)
        }
      })
    }
  }

  window.moonbitRelay = { refresh }
  const boot = () => { wire(); refresh() }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
  try {
    api.onRelayChanged(() => {
      const p = document.getElementById('mainview-agent')
      if (p && getComputedStyle(p).display !== 'none') refresh()
    })
  } catch (_) {}
})()
