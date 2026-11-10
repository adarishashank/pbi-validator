/* eslint-disable no-undef */
/**
 * Functions in this module are serialised and executed inside the Power BI
 * page via Playwright's `evaluate`. They must be completely self-contained
 * (no closures over module scope).
 */

/** Extracts every rendered visual: identity, geometry, text, data, health. */
export function extractVisualsInPage({ sel, maxVisuals, onlyIndex }) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const list = (s) => (Array.isArray(s) ? s : [s]);
  const first = (root, sels) => {
    for (const s of list(sels)) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const visibleBox = (root, sels) => {
    for (const s of list(sels)) {
      for (const el of root.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) return { el, r };
      }
    }
    return null;
  };
  const canvasEl = first(document, sel.canvas);
  const all = [...document.querySelectorAll(sel.visualContainer)];
  const allSet = new Set(all);
  const isTop = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (allSet.has(p)) return false;
    return true;
  };

  const visCache = new Map();
  const isVisible = (el) => {
    if (!el) return false;
    if (visCache.has(el)) return visCache.get(el);
    let v = el.getClientRects().length > 0;
    if (v) {
      const cs = getComputedStyle(el);
      v = cs.visibility !== 'hidden' && cs.opacity !== '0';
    }
    visCache.set(el, v);
    return v;
  };
  const SKIP = new Set(['TITLE', 'STYLE', 'SCRIPT', 'DEFS', 'NOSCRIPT']);
  const textLines = (root, cap = 2000) => {
    const out = [];
    if (!root) return out;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n, lastParent = null;
    while ((n = w.nextNode()) && out.length < cap) {
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName.toUpperCase()) || p.closest('title,style,script,defs')) continue;
      const t = norm(n.nodeValue);
      if (!t || !isVisible(p)) continue;
      if (/^(scroll (up|down|left|right)|more options|focus mode|filters on visual)$/i.test(t)) continue; // UI chrome, not data
      // The same text twice in one element is one value split into text nodes;
      // in different elements it is two values (two labels that both read "5").
      if (out[out.length - 1] !== t || p !== lastParent) out.push(t);
      lastParent = p;
    }
    return out;
  };
  const errRe = new RegExp(sel.visualErrorText, 'i');
  const actionRe = /click here to follow|ctrl \+ click|ctrl\+click/i;

  const rects = [];
  const visuals = [];
  all.forEach((vc, domIndex) => {
    if (onlyIndex !== undefined && onlyIndex !== null && domIndex !== onlyIndex) return;
    if (!isTop(vc)) return;
    const vb = visibleBox(vc, sel.visualBox);
    if (!vb) return; // hidden (e.g. toggled off by a bookmark)
    const r = vb.r;
    const content = first(vc, list(sel.visualContent));
    const group = vc.querySelector(sel.visualGroup);
    const classes = content ? [...content.classList] : [];
    const typeTok = classes.find((c) => c.startsWith('visual-') && c !== 'visual-container');
    const type = typeTok ? typeTok.slice(7) : (group?.getAttribute('aria-roledescription') || 'unknown').replace(/\s+/g, '');
    const roleDesc = group?.getAttribute('aria-roledescription') || '';
    const ariaLabel = norm(group?.getAttribute('aria-label'));
    const titleEl = vc.querySelector(sel.visualTitle);
    const slicerHeader = vc.querySelector(sel.slicerHeader);
    let title = norm(titleEl?.textContent) || norm(slicerHeader?.getAttribute('title') || slicerHeader?.textContent);
    if (!title && ariaLabel && !/^(image|shape|button|text box)$/i.test(ariaLabel)) {
      title = norm(ariaLabel.replace(/\s*\.?\s*(click here to follow( link)?|ctrl \+ click.*|ctrl\+click.*)\s*$/i, ''));
    }

    const lines = textLines(content || vc);
    // Grids (table / matrix) – capture as rows of cells.
    let grid = null, gridCapped = false;
    const gridEl = (content || vc).querySelector('[role="grid"], [role="treegrid"], table');
    if (gridEl) {
      const allRows = gridEl.querySelectorAll('[role="row"], tr');
      gridCapped = allRows.length > 1000;
      const rows = [...allRows].slice(0, 1000);
      grid = rows.map((row) => [...row.querySelectorAll('[role="gridcell"], [role="columnheader"], [role="rowheader"], td, th')].map((c) => norm(c.textContent)))
        .filter((cells) => cells.some(Boolean));
    }
    const pointEls = [...(content || vc).querySelectorAll(sel.dataPoint)].filter(isVisible);
    const points = pointEls.slice(0, 2000).map((e) => norm(e.getAttribute('aria-label')));
    const slicerItems = [...vc.querySelectorAll(sel.slicerItem)].slice(0, 500).map((e) => ({
      label: norm(e.getAttribute('title') || e.textContent),
      checked: e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true',
    }));
    const hasDropdown = !!vc.querySelector(sel.slicerDropdown);
    const rangeInputs = [...vc.querySelectorAll(sel.slicerRangeInputs)];
    const hasRange = rangeInputs.length > 0;
    // Power BI names each visual; the same ID is in the data requests it sends.
    const idEl = vc.querySelector('[id^="visualsEnterHint-"], [id^="visualsLabel-"]');
    const visualId = idEl ? idEl.id.replace(/^visuals(EnterHint|Label)-/, '') : null;
    const expanders = vc.querySelectorAll(sel.matrixExpander).length;
    const fullText = norm((vc.innerText || '').slice(0, 4000));
    const errorMatch = fullText.match(errRe);
    const groupTitleAttr = group?.getAttribute('title') || '';

    const canvasR = canvasEl ? canvasEl.getBoundingClientRect() : { x: 0, y: 0 };
    rects.push(r);
    visuals.push({
      domIndex,
      visualId,
      type,
      roleDesc,
      title,
      ariaLabel,
      box: { x: Math.round(r.x - canvasR.x), y: Math.round(r.y - canvasR.y), w: Math.round(r.width), h: Math.round(r.height) },
      pageBox: { x: r.x, y: r.y, w: r.width, h: r.height },
      lines: lines.slice(0, 2000),
      grid,
      // More on the page than was read: the comparison of this visual's text is partial.
      capped: lines.length >= 2000 || gridCapped || pointEls.length > 2000,
      points,
      slicer: (slicerItems.length || hasDropdown || hasRange) ? { items: slicerItems, hasDropdown, hasRange, range: rangeInputs.map((i) => norm(i.value)) } : null,
      expanders,
      actionable: actionRe.test(ariaLabel) || actionRe.test(groupTitleAttr),
      error: errorMatch ? errorMatch[0] : null,
    });
  });

  let canvas = null;
  if (canvasEl) {
    const c = canvasEl.getBoundingClientRect();
    canvas = { x: c.x, y: c.y, w: c.width, h: c.height };
  } else if (rects.length) {
    const x1 = Math.min(...rects.map((r) => r.x)), y1 = Math.min(...rects.map((r) => r.y));
    const x2 = Math.max(...rects.map((r) => r.right)), y2 = Math.max(...rects.map((r) => r.bottom));
    canvas = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  return { canvas, visuals: visuals.slice(0, maxVisuals || 1000), total: visuals.length };
}

/** Cheap DOM signature used to detect when rendering has settled. */
export function renderSignatureInPage({ sel }) {
  const list = (s) => (Array.isArray(s) ? s : [s]);
  let busy = false;
  for (const s of list(sel.spinner)) {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const cs = getComputedStyle(el);
        if (cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0') { busy = true; break; }
      }
    }
    if (busy) break;
  }
  const vcs = document.querySelectorAll(sel.visualContainer);
  let textLen = 0, nodes = 0, geom = 0;
  vcs.forEach((vc) => {
    textLen += (vc.textContent || '').length;
    nodes += vc.getElementsByTagName('*').length;
    const b = vc.firstElementChild?.getBoundingClientRect?.();
    if (b) geom += Math.round(b.width) * 7 + Math.round(b.height) * 13 + Math.round(b.x) + Math.round(b.y) * 3;
  });
  return { busy, count: vcs.length, sig: `${vcs.length}:${textLen}:${nodes}:${geom}`, url: location.href };
}

/** Returns visible header/hover buttons of a visual matched by accessible name. */
export function headerButtonsInPage({ domIndex, sel, labels }) {
  const vc = document.querySelectorAll(sel.visualContainer)[domIndex];
  if (!vc) return {};
  const out = {};
  const btns = [...vc.querySelectorAll('button, [role="button"]')];
  for (const [key, pattern] of Object.entries(labels)) {
    const re = new RegExp(pattern, 'i');
    const idx = btns.findIndex((b) => {
      const name = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim();
      const r = b.getBoundingClientRect();
      return re.test(name) && r.width > 0 && r.height > 0;
    });
    if (idx >= 0) {
      const b = btns[idx];
      const r = b.getBoundingClientRect();
      out[key] = {
        label: (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim(),
        disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
        pressed: b.getAttribute('aria-pressed') === 'true' || b.classList.contains('active'),
        x: r.x + r.width / 2, y: r.y + r.height / 2,
      };
    }
  }
  return out;
}

/** Clickable sub-items of page/bookmark navigator visuals. */
export function navigatorItemsInPage({ domIndex, sel }) {
  const vc = document.querySelectorAll(sel.visualContainer)[domIndex];
  if (!vc) return [];
  const items = [...vc.querySelectorAll('[role="tab"], [role="option"], button, [role="button"]')]
    .filter((e) => !e.closest('[class*="vcHeader"], visual-container-header, .visualHeader'))
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 4 && r.height > 4);
  const seen = new Set();
  return items.filter(({ r }) => {
    const k = `${Math.round(r.x)}:${Math.round(r.y)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(({ e, r }) => ({
    label: (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim(),
    x: r.x + r.width / 2, y: r.y + r.height / 2,
  }));
}

/**
 * Clickable points of data points inside a visual. Uses hit-testing so arcs
 * (donut/pie), lines and irregular shapes get a point that is actually on the
 * element rather than the bounding-box centre (e.g. a donut's empty hole).
 */
export function dataPointsInPage({ domIndex, sel, max }) {
  const vc = document.querySelectorAll(sel.visualContainer)[domIndex];
  if (!vc) return [];
  const hits = (e, x, y) => {
    const h = document.elementFromPoint(x, y);
    return h && (h === e || e.contains(h));
  };
  const out = [];
  for (const e of vc.querySelectorAll(sel.dataPoint)) {
    if (out.length >= (max || 50)) break;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    let pt = null;
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    if (hits(e, cx, cy)) pt = { x: cx, y: cy };
    if (!pt && typeof e.getTotalLength === 'function') {
      try {
        const len = e.getTotalLength();
        const m = e.getScreenCTM();
        for (const f of [0.25, 0.5, 0.75, 0.1, 0.9]) {
          const p = e.getPointAtLength(len * f);
          const sp = new DOMPoint(p.x, p.y).matrixTransform(m);
          // nudge towards bbox centre so we land inside the stroke/fill
          const nx = sp.x + (cx - sp.x) * 0.08, ny = sp.y + (cy - sp.y) * 0.08;
          if (hits(e, nx, ny)) { pt = { x: nx, y: ny }; break; }
        }
      } catch { /* not a geometry element */ }
    }
    if (!pt) {
      for (let gy = 1; gy <= 5 && !pt; gy++) {
        for (let gx = 1; gx <= 5; gx++) {
          const x = r.x + (r.width * gx) / 6, y = r.y + (r.height * gy) / 6;
          if (hits(e, x, y)) { pt = { x, y }; break; }
        }
      }
    }
    if (!pt) continue; // covered / not hittable
    out.push({ label: (e.getAttribute('aria-label') || '').trim(), x: pt.x, y: pt.y });
  }
  return out;
}

/** Text + bounding box of the currently visible tooltip (if any). */
export function tooltipInPage({ selectors }) {
  for (const s of selectors) {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') {
        const lines = (el.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
        return { lines, box: { x: r.x, y: r.y, w: r.width, h: r.height } };
      }
    }
  }
  return null;
}

/** Visible context-menu items. */
export function contextMenuInPage({ selector }) {
  return [...document.querySelectorAll(selector)]
    .filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map((m) => ({
      label: (m.textContent || '').replace(/\s+/g, ' ').trim(),
      disabled: m.getAttribute('aria-disabled') === 'true' || m.hasAttribute('disabled'),
    }));
}

/** Report canvas rectangle: canvas element, else union of visible visuals. */
export function canvasBoxInPage({ sel }) {
  const list = (s) => (Array.isArray(s) ? s : [s]);
  for (const s of list(sel.canvas)) {
    const el = document.querySelector(s);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
  }
  const rects = [];
  document.querySelectorAll(sel.visualContainer).forEach((vc) => {
    for (const s of list(sel.visualBox)) {
      const el = vc.querySelector(s);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) { rects.push(r); break; }
    }
  });
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.x)), y1 = Math.min(...rects.map((r) => r.y));
  return { x: x1, y: y1, w: Math.max(...rects.map((r) => r.right)) - x1, h: Math.max(...rects.map((r) => r.bottom)) - y1 };
}

/**
 * How far the report page extends beyond what the window shows (pages set to
 * "fit to width" or "actual size" scroll). Returns { extraW, extraH } in px.
 */
export function canvasOverflowInPage({ sel }) {
  const list = (s) => (Array.isArray(s) ? s : [s]);
  let el = null;
  for (const s of list(sel.canvas)) {
    const c = document.querySelector(s);
    if (c && c.getBoundingClientRect().width > 2) { el = c; break; }
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  let extraW = Math.max(0, r.right - window.innerWidth), extraH = Math.max(0, r.bottom - window.innerHeight);
  // The page area itself, or a container just around it, scrolls.
  let node = el;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (/auto|scroll/.test(cs.overflowY)) extraH = Math.max(extraH, node.scrollHeight - node.clientHeight);
    if (/auto|scroll/.test(cs.overflowX)) extraW = Math.max(extraW, node.scrollWidth - node.clientWidth);
  }
  return { extraW: Math.ceil(extraW), extraH: Math.ceil(extraH) };
}
