import { q } from '../db.js';

// "What changed": a report → page → visual → value summary of one run, built
// from its check results. Used by the run page, the PDF and the Excel export.

const WEIGHT = { fail: 3, missing: 3, error: 3, diff: 1, warn: 0.5 };
const PROBLEM = new Set(Object.keys(WEIGHT));
const INTERACTIONS = new Set(['button', 'slicer', 'drill', 'drill_through', 'matrix_expand', 'cross_filter', 'tooltip']);
const LAYOUT_LABEL = {
  missing_in_b: 'removed', extra_in_b: 'added', moved: 'moved', resized: 'resized', title_changed: 'retitled', error_state: 'error state changed',
};

export const levelOf = (score) => (score <= 0 ? 'none' : score <= 2 ? 'low' : score <= 6 ? 'medium' : 'high');

// Text Power BI adds to cells for screen readers; never part of the value.
const CELL_NOISE = /Additional Conditional Formatting/g;
const NOISE_CELL = /^(select row|row selection)$/i;
const NUM = /[-+]?\d[\d,]*(?:\.\d+)?%?/g;
const cleanLine = (s) => (s == null ? null : String(s).replace(CELL_NOISE, '').replace(/^•\s*/, '').replace(/[ \t]+/g, ' ').trim());
const cellsOf = (s) => s.split('|').map((c) => c.trim());
const shapeOf = (s) => s.replace(NUM, '#');
const isNum = (c) => c !== '' && c.replace(NUM, '') === '';

/** What a changed row is about (its text cells) and which cells changed. */
export function describeChange(a, b) {
  const ca = cellsOf(a), cb = cellsOf(b);
  if (ca.length !== cb.length || ca.length < 2) return { key: '', cells: [{ a, b }] };
  const key = [], cells = [];
  ca.forEach((x, i) => {
    if (x === cb[i]) { if (x && !isNum(x) && !NOISE_CELL.test(x)) key.push(x); }
    else cells.push({ a: x || '(blank)', b: cb[i] || '(blank)' });
  });
  return { key: key.join(' · '), cells };
}

/**
 * Value-level changes from a visual's data diff (A → B). Unchanged context
 * lines are left out, and a removed + added line for the same row (same text,
 * different numbers) is one change, even when the diff listed them apart.
 */
export function valueChanges(data) {
  if (!data || data.equal) return [];
  const out = [];
  let block = [];
  const flush = () => {
    if (!block.length) return;
    const dels = [], adds = [];
    for (const o of block) {
      if (o.a != null) dels.push({ t: o.a, used: false });
      if (o.b != null) adds.push({ t: o.b, used: false });
    }
    const pair = new Map();
    const tryPair = (ok) => {
      for (const d of dels) {
        if (pair.has(d)) continue;
        let best = null, bestScore = -1;
        for (const x of adds) {
          if (x.used) continue;
          const s = ok(d.t, x.t);
          if (s > bestScore) { best = x; bestScore = s; }
        }
        if (best && bestScore >= 0) { best.used = true; pair.set(d, best); }
      }
    };
    const same = (a, b) => { const ca = cellsOf(a), cb = cellsOf(b); return ca.reduce((n, c, i) => n + (c === cb[i] ? 1 : 0), 0); };
    // Same row (same text, numbers aside), the one sharing most cells first.
    tryPair((a, b) => (shapeOf(a) === shapeOf(b) ? same(a, b) : -1));
    // Then rows with the same columns that still share at least half the cells.
    tryPair((a, b) => { const n = cellsOf(a).length; return n > 1 && n === cellsOf(b).length && same(a, b) * 2 >= n ? same(a, b) : -1; });
    for (const d of dels) {
      const x = pair.get(d);
      out.push(x ? { op: 'chg', a: d.t, b: x.t, ...describeChange(d.t, x.t) } : { op: 'del', a: d.t, b: null });
    }
    for (const x of adds) if (!x.used) out.push({ op: 'add', a: null, b: x.t });
    block = [];
  };
  for (const o of data.ops || []) {
    if (o.op === 'eq' || o.op === 'skip') { flush(); continue; }
    block.push({ a: cleanLine(o.a), b: cleanLine(o.b) });
  }
  flush();
  // Lines that only differed by screen-reader text are not changes.
  return out.filter((c) => c.op !== 'chg' || c.a !== c.b);
}

/** One readable line for a value change: "FG INVENTORY · CN: 17.36 → 17.41". */
export function changeText(c, n = 30) {
  if (c.op === 'add') return `+ ${clip(c.b, n + 20)} (only in B)`;
  if (c.op === 'del') return `− ${clip(c.a, n + 20)} (only in A)`;
  const cells = (c.cells || [{ a: c.a, b: c.b }]).map((x) => `${clip(x.a, n)} → ${clip(x.b, n)}`).join(', ');
  return c.key ? `${clip(c.key, 50)}: ${cells}` : cells;
}

function interactionSummary(r) {
  const d = r.details || {};
  if (r.status === 'accepted') return 'Accepted as expected';
  if (d.note) return d.note;
  if (d.dataDiffs?.length) return `${d.dataDiffs.length} visual(s) show different data afterwards`;
  if (d.data && !d.data.equal) return `Data differs (+${d.data.added ?? 0} / −${d.data.removed ?? 0} lines)`;
  if (r.diff_ratio) return `${(r.diff_ratio * 100).toFixed(2)}% of pixels differ`;
  return r.status;
}

/**
 * Older runs did not store the filters a page was compared on: read them from
 * the slicer visuals' text (same text on both sides when the check passed).
 */
function filtersFromVisuals(visualRows) {
  const out = [];
  for (const r of visualRows) {
    const m = /^Slicer · (.+)$/.exec(r.title || '');
    if (!m || out.some((f) => f.slicer === m[1])) continue;
    const d = r.details || {};
    const shown = (l) => (l?.length ? l.map(cleanLine).join(' ') : '(nothing shown)');
    if (d.missingIn) { out.push({ slicer: m[1], a: d.missingIn === 'A' ? null : '?', b: d.missingIn === 'B' ? null : '?', same: false, how: '', fromText: true }); continue; }
    const ch = valueChanges(d.data);
    if (!ch.length) { out.push({ slicer: m[1], a: shown(d.sample), b: shown(d.sample), same: true, how: '', fromText: true }); continue; }
    const a = ch.map((c) => c.a).filter(Boolean).join(' '), b = ch.map((c) => c.b).filter(Boolean).join(' ');
    out.push({ slicer: m[1], a: a || '(nothing shown)', b: b || '(nothing shown)', same: false, how: '', fromText: true });
  }
  return out;
}

export function runChanges(runId) {
  const run = q.get('SELECT id, suite_id, suite_name, status, snapshot, summary, started_at, finished_at FROM runs WHERE id = ?', runId);
  if (!run) return null;
  const results = q.all('SELECT id, seq, page, scenario, target, title, status, diff_ratio, details FROM results WHERE run_id = ? ORDER BY seq', runId);
  const inv = results.find((r) => r.scenario === 'report_pages')?.details || {};
  const renamedTo = new Map((inv.renamed || []).map((x) => [x.a, x.b]));
  const pageNames = [...new Set([...(inv.pagesA || []), ...results.map((r) => r.page).filter(Boolean)])];

  const pages = pageNames.map((name) => {
    const rows = results.filter((r) => r.page === name);
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const score = rows.reduce((s, r) => s + (WEIGHT[r.status] || 0), 0);
    const removed = (inv.onlyInA || []).includes(name) || rows.some((r) => r.scenario === 'page_render' && r.details?.missingIn === 'B');
    const structure = rows.find((r) => r.scenario === 'structure');
    const layout = (structure?.details?.issues || []).map((i) => ({ change: LAYOUT_LABEL[i.kind] || i.kind.replace(/_/g, ' '), visual: i.visual, a: i.a ?? null, b: i.b ?? null }));
    const visualRows = rows.filter((r) => r.scenario === 'visual');
    const values = visualRows
      .map((r) => ({ resultId: r.id, visual: r.title, status: r.status, changes: valueChanges(r.details?.data) }))
      .filter((v) => v.changes.length);
    const visualsChanged = visualRows.filter((r) => PROBLEM.has(r.status) || r.status === 'accepted')
      .map((r) => ({ resultId: r.id, title: r.title, status: r.status, pixel: r.diff_ratio, missingIn: r.details?.missingIn || null, accepted: r.details?.accepted || null }));
    const interactions = rows.filter((r) => INTERACTIONS.has(r.scenario) && (PROBLEM.has(r.status) || r.status === 'accepted'))
      .map((r) => ({ resultId: r.id, scenario: r.scenario, title: r.title, status: r.status, summary: interactionSummary(r) }));
    const health = rows.filter((r) => r.scenario === 'health').flatMap((r) => Object.entries(r.details?.errors || {}).flatMap(([side, list]) => (list || []).map((e) => ({ side, visual: e.visual, error: e.error }))));
    const render = rows.find((r) => r.scenario === 'page_render');
    // Slicers that open on different values (B was aligned to A before comparing).
    const selections = rows.filter((r) => r.scenario === 'selections').map((r) => ({
      resultId: r.id, status: r.status, title: r.title, slicer: r.details?.slicer || '',
      a: r.details?.defaultA ?? null, b: r.details?.defaultB ?? null, applied: r.details?.applied ?? null, note: r.details?.note || '',
    }));
    return {
      name,
      renamedTo: renamedTo.get(name) || null,
      state: removed ? 'removed' : score > 0 ? 'changed' : 'unchanged',
      level: removed ? 'high' : levelOf(score),
      score,
      checks: rows.length,
      byStatus,
      problems: rows.filter((r) => PROBLEM.has(r.status)).length,
      accepted: byStatus.accepted || 0,
      pixel: render?.diff_ratio ?? null,
      renderResultId: render?.id ?? null,
      layout,
      values,
      valuesChanged: values.reduce((n, v) => n + v.changes.length, 0),
      visualsChanged,
      interactions,
      health,
      selections,
      comparedOn: render?.details?.selections || [],
      filters: render?.details?.filters || filtersFromVisuals(visualRows),
    };
  });
  for (const name of inv.onlyInB || []) {
    pages.push({ name, renamedTo: null, state: 'added', level: 'medium', score: 0, checks: 0, byStatus: {}, problems: 0, accepted: 0, pixel: null, renderResultId: null, layout: [], values: [], valuesChanged: 0, visualsChanged: [], interactions: [], health: [], selections: [], comparedOn: [], filters: [] });
  }

  // Data model (report level).
  const modelRows = results.filter((r) => r.scenario === 'model');
  const modelSummary = modelRows.find((r) => r.target === 'model');
  const model = modelSummary ? {
    resultId: modelSummary.id,
    status: modelSummary.status,
    compared: modelSummary.status === 'pass' || modelSummary.status === 'diff' || modelRows.length > 1,
    note: modelSummary.details?.note || '',
    info: modelSummary.details?.model || {},
    changes: modelRows.filter((r) => r.target !== 'model').map((r) => ({
      resultId: r.id, status: r.status, title: r.title, ...(r.details?.model || {}),
      accepted: r.status === 'accepted',
    })),
  } : null;

  const sum = (f) => pages.reduce((n, p) => n + f(p), 0);
  const totals = {
    pagesA: (inv.pagesA || []).length || null,
    pagesB: (inv.pagesB || []).length || null,
    pagesChanged: pages.filter((p) => p.state !== 'unchanged').length,
    visualsAdded: sum((p) => p.layout.filter((l) => l.change === 'added').length),
    visualsRemoved: sum((p) => p.layout.filter((l) => l.change === 'removed').length),
    visualsMoved: sum((p) => p.layout.filter((l) => ['moved', 'resized'].includes(l.change)).length),
    visualsWithDataChanges: sum((p) => p.values.length),
    valuesChanged: sum((p) => p.valuesChanged),
    interactionsChanged: sum((p) => p.interactions.filter((i) => i.status !== 'accepted').length),
    modelChanges: model ? model.changes.filter((c) => !c.accepted).length : 0,
    selectionsDiffer: sum((p) => p.selections.filter((x) => x.status !== 'accepted' && x.status !== 'pass').length),
    pagesFilteredDifferently: pages.filter((p) => p.filters.some((f) => f.same === false && f.how !== 'aligned')).length,
    problems: sum((p) => p.problems),
    accepted: sum((p) => p.accepted),
  };
  const report = {
    pagesA: inv.pagesA || [], pagesB: inv.pagesB || [],
    removed: inv.onlyInA || [], added: inv.onlyInB || [], renamed: inv.renamed || [], orderChanged: !!inv.orderChanged,
    totals,
    headline: headline(totals, inv),
    model,
  };
  report.top = topDifferences({ report, pages }, results);
  return { run: { id: run.id, suite: run.suite_name, status: run.status, reports: run.snapshot?.reports || {} }, report, pages };
}

const EXPR_FIELD = /^(DAX|Source query|Row filter|Expression)/;
const clip = (v, n = 60) => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The differences the Power BI team should look at first, ranked without AI:
 * P1 = wrong numbers, removed content, broken visuals, model/security changes;
 * P2 = behaviour and layout that users will notice; P3 = additions and cosmetics.
 * Accepted differences are left out.
 */
export function topDifferences(ch, results, max = 12) {
  const seqOf = new Map(results.map((r) => [r.id, r.seq]));
  const items = [];
  const add = (o) => items.push({ refs: (o.ids || []).map((id) => seqOf.get(id)).filter(Boolean), ...o });
  const rp = ch.report;
  for (const name of rp.removed) add({ priority: 'P1', area: 'Page', page: name, title: `Page "${name}" is missing in B`, evidence: 'Exists only in A', owner: 'Report developer', ids: ch.pages.find((p) => p.name === name)?.renderResultId ? [ch.pages.find((p) => p.name === name).renderResultId] : [] });
  for (const c of rp.model?.changes || []) {
    if (c.accepted) continue;
    const kind = c.kind;
    const fields = (c.fields || []).map((f) => f.label);
    const p1 = c.change === 'removed' || ['role', 'relationship'].includes(kind) || (kind === 'measure' && c.change === 'changed' && fields.some((f) => /DAX|table/i.test(f)))
      || (kind === 'column' && c.change === 'changed' && fields.some((f) => /Data type|DAX/i.test(f))) || (kind === 'table' && fields.some((f) => /Source/i.test(f)));
    const expr = (x) => clip(String(x || '').replace(/\s+/g, ' ').trim(), 45) || '(none)';
    const ev = (c.fields || []).map((f) => (EXPR_FIELD.test(f.label) ? `${f.label}: ${expr(c.exprA || f.a)} → ${expr(c.exprB || f.b)}` : `${f.label}: ${clip(f.a, 30) || '(none)'} → ${clip(f.b, 30) || '(none)'}`)).join('; ')
      || (c.change === 'added' ? `Only in B${c.exprB ? `: ${expr(c.exprB)}` : ''}` : c.change === 'removed' ? `Only in A${c.exprA ? `: ${expr(c.exprA)}` : ''}` : 'Differs');
    add({ priority: p1 ? 'P1' : c.change === 'added' ? 'P3' : 'P2', area: 'Data model', page: '', title: c.title, evidence: ev, owner: 'Semantic model owner', ids: [c.resultId] });
  }
  for (const p of ch.pages) {
    if (p.state === 'removed' || p.state === 'added') continue;
    for (const x of p.selections) {
      if (x.status === 'accepted' || x.status === 'pass') continue;
      const show = (l) => (Array.isArray(l) ? (l.length ? l.join(', ') : 'All') : '?');
      add({ priority: 'P1', area: 'Defaults', page: p.name, title: x.status === 'fail' ? x.title : `Slicer "${x.slicer}" opens on ${show(x.a)} in A but ${show(x.b)} in B`,
        evidence: x.note, owner: 'Report developer', ids: [x.resultId] });
    }
    for (const h of p.health) add({ priority: 'P1', area: 'Visual error', page: p.name, title: `${h.visual} shows an error in ${h.side}`, evidence: clip(h.error, 80), owner: 'Report developer', ids: [] });
    for (const v of p.values) {
      if (v.status === 'accepted') continue;
      const chg = v.changes.slice(0, 3).map((c) => changeText(c, 20)).join('; ');
      add({ priority: 'P1', area: 'Numbers', page: p.name, title: `${v.visual} shows different values`, evidence: `${chg}${v.changes.length > 3 ? ` (+${v.changes.length - 3} more)` : ''}`, owner: 'Data / model owner', ids: [v.resultId] });
    }
    for (const v of p.visualsChanged) {
      if (!v.missingIn || v.status === 'accepted') continue;
      add({ priority: v.missingIn === 'B' ? 'P2' : 'P3', area: 'Visual', page: p.name, title: v.title, evidence: v.missingIn === 'B' ? 'Missing in B' : 'New in B', owner: 'Report developer', ids: [v.resultId] });
    }
    for (const i of p.interactions) {
      if (i.status === 'accepted') continue;
      add({ priority: i.status === 'fail' || i.status === 'error' ? 'P2' : 'P3', area: 'Interaction', page: p.name, title: i.title, evidence: clip(i.summary, 90), owner: 'Report developer', ids: [i.resultId] });
    }
    for (const l of p.layout) {
      if (l.change === 'added' || l.change === 'removed') continue; // covered as visuals
      add({ priority: 'P3', area: 'Layout', page: p.name, title: `${l.visual} ${l.change}`, evidence: l.change === 'retitled' ? `"${l.a}" → "${l.b}"` : '', owner: 'Report developer', ids: [] });
    }
  }
  for (const name of rp.added) add({ priority: 'P3', area: 'Page', page: name, title: `New page "${name}" in B`, evidence: 'Not compared', owner: 'Report developer', ids: [] });
  const rank = { P1: 0, P2: 1, P3: 2 };
  const areaRank = { 'Data model': 0, Defaults: 1, Numbers: 1, Page: 2, 'Visual error': 3, Visual: 4, Interaction: 5, Layout: 6 };
  return items.sort((a, b) => rank[a.priority] - rank[b.priority] || (areaRank[a.area] ?? 9) - (areaRank[b.area] ?? 9)).slice(0, max)
    .map(({ ids, ...x }) => ({ ...x, resultIds: ids }));
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function headline(t, inv) {
  const parts = [];
  const pagesDelta = (inv.onlyInA || []).length + (inv.onlyInB || []).length + (inv.renamed || []).length;
  if (pagesDelta) {
    const bits = [];
    if (inv.onlyInA?.length) bits.push(`${inv.onlyInA.length} removed`);
    if (inv.onlyInB?.length) bits.push(`${inv.onlyInB.length} added`);
    if (inv.renamed?.length) bits.push(`${inv.renamed.length} renamed`);
    parts.push(`pages: ${bits.join(', ')}`);
  }
  if (t.visualsAdded || t.visualsRemoved) parts.push(`visuals: ${t.visualsAdded} added, ${t.visualsRemoved} removed`);
  if (t.valuesChanged) parts.push(`${plural(t.valuesChanged, 'value change')} in ${plural(t.visualsWithDataChanges, 'visual')}`);
  if (t.selectionsDiffer) parts.push(`${plural(t.selectionsDiffer, 'slicer')} ${t.selectionsDiffer === 1 ? 'opens' : 'open'} on different values`);
  if (t.modelChanges) parts.push(`data model: ${plural(t.modelChanges, 'change')}`);
  if (t.interactionsChanged) parts.push(`${plural(t.interactionsChanged, 'interaction')} ${t.interactionsChanged === 1 ? 'behaves' : 'behave'} differently`);
  if (!parts.length) return t.accepted ? `No new changes (${t.accepted} accepted as expected)` : 'No changes found';
  return parts.join(' · ');
}
