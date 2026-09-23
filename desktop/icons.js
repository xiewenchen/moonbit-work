// 统一图标库 —— 全部是内联 SVG（stroke=currentColor），**不使用 emoji**
//
// 为什么不用 emoji（参照 Microsoft 的图标规范：SVG 在任何尺寸/分辨率都清晰）：
//   · emoji 由系统字体渲染，换机器就变样子，甚至有的系统缺字形
//   · emoji 是彩色的，跟 UI 的配色体系（日间/夜间两套 token）冲突
//   · emoji 的字号与基线不可控，跟文字混排时对不齐
//   · 同一个 emoji 在不同平台语义还会有细微差别
// 统一用 stroke=currentColor 的 SVG 后，图标自动跟随主题色，尺寸也完全可控。
(function () {
  const S = (body, sw) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 1.7}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

  window.MBIcons = {
    // ── 导航 ──────────────────────────────────────────────────────────
    clock: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>'),
    desktop: S('<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M9 20h6M12 16.5V20"/>'),
    download: S('<path d="M12 3.5v10.5m0 0l-4-4m4 4l4-4M4.5 19h15"/>'),
    folder: S('<path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>'),
    archive: S('<path d="M4.5 4.5h15a1 1 0 0 1 1 1v3.5h-17V5.5a1 1 0 0 1 1-1z"/><path d="M6 9v9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9"/><path d="M10.5 13h3"/>'),
    pin: S('<path d="M9.5 3.5h5l-.8 5.2 2.8 2.6v1.7H7.5v-1.7l2.8-2.6z"/><path d="M12 13v7.5"/>'),

    // ── 文件（基础轮廓；具体类型由 CSS 按扩展名着色）──────────────────
    file: S('<path d="M14 3H7.5A2 2 0 0 0 5.5 5v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7.5z"/><path d="M14 3v4.5h4.5"/>'),

    // ── 操作 ──────────────────────────────────────────────────────────
    save: S('<path d="M12 3.5v10m0 0l-3.5-3.5M12 13.5l3.5-3.5"/><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>'),
    history: S('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5V9H8"/><path d="M12 8v4.2l2.8 1.7"/>'),
    open: S('<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L11 13"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18.5V7A1.5 1.5 0 0 1 5 5.5h5"/>'),
    reveal: S('<path d="M4 7a2 2 0 0 1 2-2h3.6l2 2H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M9.5 14.5l3-3 3 3"/><path d="M12.5 11.5V17"/>'),
    close: S('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    check: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),

    // ── 视图 / 方向 ───────────────────────────────────────────────────
    grid: S('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
    list: S('<path d="M4 6.5h16M4 12h16M4 17.5h16"/>'),
    search: S('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', 1.8),
    chevronLeft: S('<path d="M14.5 6l-6 6 6 6"/>', 1.9),
    chevronRight: S('<path d="M9.5 6l6 6-6 6"/>', 1.9),
    arrowDown: S('<path d="M12 5v14m0 0l-5-5m5 5l5-5"/>', 1.8),
    arrowUp: S('<path d="M12 19V5m0 0l-5 5m5-5l5 5"/>', 1.8),
    refresh: S('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.5 4v4.5H16"/>'),

    // ── 状态 ──────────────────────────────────────────────────────────
    sun: S('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6"/>'),
    moon: S('<path d="M20 13.6A8.5 8.5 0 0 1 10.4 4 8.5 8.5 0 1 0 20 13.6z"/>'),
    warn: S('<path d="M12 4.5L21 20H3z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
    empty: S('<path d="M5 8.5h14v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M4 4.5h16v4H4z"/><path d="M10 12.5h4"/>'),
  }

  // 便捷方法：往元素里塞图标（替换其内容）
  window.MBIcons.into = function (el, name, size) {
    if (!el) return el
    el.innerHTML = window.MBIcons[name] || ''
    const svg = el.querySelector('svg')
    if (svg) {
      svg.style.width = (size || 16) + 'px'
      svg.style.height = (size || 16) + 'px'
      svg.style.display = 'block'
    }
    return el
  }
})()
