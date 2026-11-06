const normName = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Matches pages by name, then leftover pages by position ("renamed"). */
export function matchPages(pagesA, pagesB) {
  if (!pagesB) return { pairs: pagesA.map((a) => ({ a, b: null, how: 'single' })), onlyA: [], onlyB: [] };
  const pairs = [];
  const usedB = new Set();
  const leftA = [];
  for (const a of pagesA) {
    const b = pagesB.find((p) => !usedB.has(p.index) && normName(p.name) === normName(a.name));
    if (b) { usedB.add(b.index); pairs.push({ a, b, how: 'name' }); } else leftA.push(a);
  }
  const leftB = pagesB.filter((p) => !usedB.has(p.index));
  const onlyA = [];
  for (const a of leftA) {
    const b = leftB.find((p) => p.index === a.index);
    if (b) { leftB.splice(leftB.indexOf(b), 1); pairs.push({ a, b, how: 'position' }); } else onlyA.push(a);
  }
  pairs.sort((x, y) => x.a.index - y.a.index);
  return { pairs, onlyA, onlyB: leftB };
}

const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
function iou(p, q) {
  const x1 = Math.max(p.x, q.x), y1 = Math.max(p.y, q.y);
  const x2 = Math.min(p.x + p.w, q.x + q.w), y2 = Math.min(p.y + p.h, q.y + q.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = p.w * p.h + q.w * q.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/** Stable human-readable identity of a visual on a page. */
export function visualLabel(v) {
  const t = v.title || (v.lines?.[0] ? `"${v.lines[0].slice(0, 40)}"` : '');
  return `${v.roleDesc || v.type}${t ? ` · ${t}` : ''}`;
}

/**
 * Matches visuals between two extractions:
 *  1. same type + same non-empty title (ordinal for duplicates, by position)
 *  2. same type with best geometric overlap / nearest centre
 *  3. leftovers are reported as only-in-A / only-in-B
 */
export function matchVisuals(visA, visB) {
  const sortPos = (arr) => [...arr].sort((p, q) => p.box.y - q.box.y || p.box.x - q.box.x);
  const A = sortPos(visA), B = sortPos(visB || []);
  const usedB = new Set();
  const pairs = [];
  const leftA = [];

  for (const a of A) {
    if (!a.title) { leftA.push(a); continue; }
    const b = B.find((x) => !usedB.has(x) && x.type === a.type && normName(x.title) === normName(a.title));
    if (b) { usedB.add(b); pairs.push({ a, b, how: 'title' }); } else leftA.push(a);
  }
  const onlyA = [];
  for (const a of leftA) {
    let best = null, bestScore = -Infinity;
    for (const b of B) {
      if (usedB.has(b) || b.type !== a.type) continue;
      if (a.title && b.title && normName(a.title) !== normName(b.title)) continue;
      const o = iou(a.box, b.box);
      const ca = centre(a.box), cb = centre(b.box);
      const dist = Math.hypot(ca.x - cb.x, ca.y - cb.y);
      const sameText = a.lines?.[0] && a.lines[0] === b.lines?.[0] ? 0.5 : 0;
      const score = o * 2 + sameText - dist / 1000;
      if ((o > 0.3 || dist < 60 || sameText) && score > bestScore) { best = b; bestScore = score; }
    }
    if (best) { usedB.add(best); pairs.push({ a, b: best, how: 'position' }); } else onlyA.push(a);
  }
  const onlyB = B.filter((b) => !usedB.has(b));

  // Disambiguate keys so each pair gets a stable id within the page.
  const counts = new Map();
  for (const p of pairs.sort((x, y) => x.a.box.y - y.a.box.y || x.a.box.x - y.a.box.x)) {
    const base = `${p.a.type}|${normName(p.a.title) || '-'}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    p.key = n > 1 ? `${base}#${n}` : base;
  }
  return { pairs, onlyA, onlyB };
}

/** Structural comparison of a matched page. */
export function structuralDiff(match, { positionTolerancePx = 4 } = {}) {
  const issues = [];
  for (const v of match.onlyA) issues.push({ kind: 'missing_in_b', visual: visualLabel(v), box: v.box });
  for (const v of match.onlyB) issues.push({ kind: 'extra_in_b', visual: visualLabel(v), box: v.box });
  for (const { a, b } of match.pairs) {
    if (normName(a.title) !== normName(b.title)) issues.push({ kind: 'title_changed', visual: visualLabel(a), a: a.title, b: b.title });
    const dx = Math.abs(a.box.x - b.box.x), dy = Math.abs(a.box.y - b.box.y);
    const dw = Math.abs(a.box.w - b.box.w), dh = Math.abs(a.box.h - b.box.h);
    if (Math.max(dx, dy) > positionTolerancePx) issues.push({ kind: 'moved', visual: visualLabel(a), a: a.box, b: b.box });
    if (Math.max(dw, dh) > positionTolerancePx) issues.push({ kind: 'resized', visual: visualLabel(a), a: a.box, b: b.box });
    if (!!a.error !== !!b.error) issues.push({ kind: 'error_state', visual: visualLabel(a), a: a.error, b: b.error });
  }
  return issues;
}
