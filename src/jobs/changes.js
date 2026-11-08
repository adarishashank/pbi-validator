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

/** Value-level changes from a visual's data diff (A → B), skipping unchanged runs. */
function valueChanges(data) {
  if (!data || data.equal) return [];
  const out = [];
  for (const o of data.ops || []) {
    if (o.op === 'skip') continue;
    out.push({ op: o.op, a: o.a ?? null, b: o.b ?? null });
  }
  return out;
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
    };
  });
  for (const name of inv.onlyInB || []) {
    pages.push({ name, renamedTo: null, state: 'added', level: 'medium', score: 0, checks: 0, byStatus: {}, problems: 0, accepted: 0, pixel: null, renderResultId: null, layout: [], values: [], valuesChanged: 0, visualsChanged: [], interactions: [], health: [] });
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
  return { run: { id: run.id, suite: run.suite_name, status: run.status, reports: run.snapshot?.reports || {} }, report, pages };
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
  if (t.modelChanges) parts.push(`data model: ${plural(t.modelChanges, 'change')}`);
  if (t.interactionsChanged) parts.push(`${plural(t.interactionsChanged, 'interaction')} ${t.interactionsChanged === 1 ? 'behaves' : 'behave'} differently`);
  if (!parts.length) return t.accepted ? `No new changes (${t.accepted} accepted as expected)` : 'No changes found';
  return parts.join(' · ');
}
