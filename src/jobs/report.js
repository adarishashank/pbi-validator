import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from '../engine/runner.js';
import { runDir } from './queue.js';
import { describe } from './export.js';
import { createLogger } from '../logger.js';
import { config } from '../config.js';
import { runChanges } from './changes.js';

const logger = createLogger('report');

export const LEVEL_LABEL = { none: 'None', low: 'Low', medium: 'Medium', high: 'High' };
const PAGE_STATE = { unchanged: 'Unchanged', changed: 'Changed', removed: 'Only in A (removed)', added: 'Only in B (added)' };
const OP_LABEL = { chg: 'Changed', add: 'Added', del: 'Removed' };
const MODEL_KIND = { table: 'Table', column: 'Column', measure: 'Measure', relationship: 'Relationship', role: 'Security role', parameter: 'Parameter' };
export const STATUS_ORDER = ['fail', 'error', 'missing', 'diff', 'warn', 'accepted', 'pass', 'skipped'];
export const STATUS_LABEL = { pass: 'Pass', diff: 'Diff', fail: 'Fail', missing: 'Missing', error: 'Error', warn: 'Warning', accepted: 'Accepted', skipped: 'Skipped' };
export const SCENARIO_LABEL = {
  report_pages: 'Pages', health: 'Health', page_render: 'Page render', structure: 'Layout', visual: 'Visual',
  button: 'Button', slicer: 'Slicer', drill: 'Hierarchy drill', drill_through: 'Drill-through', model: 'Data model', budget: 'Time budget', matrix_expand: 'Matrix expand', cross_filter: 'Cross-filter', tooltip: 'Tooltip',
};
const PROBLEM = new Set(['fail', 'error', 'missing', 'diff', 'warn']);
const RUN_STATUS_LABEL = { passed: 'Passed', failed: 'Failed', diffs: 'Differences found', error: 'Error', cancelled: 'Cancelled', running: 'Running', queued: 'Queued' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: config.timezone }) : '—');
const fmtDur = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const runDurationMs = (run) => run.summary?.durationMs ?? (run.started_at && run.finished_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : null);
const pct = (r) => (r == null ? '' : `${(r * 100).toFixed(r < 0.001 ? 4 : 2)}%`);
const done = (x) => (x && x.status === 'done' && x.content ? x.content : null);
const rank = (s) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? 99 : i; };

/** "Accepted as expected (was Diff) by x: note" for exports. */
export function acceptedText(r) {
  const a = r.details?.accepted || {};
  return `Accepted as expected (was ${STATUS_LABEL[a.originalStatus] || a.originalStatus || '?'})${a.by ? ` by ${a.by}` : ''}${a.note ? `: ${a.note}` : ''}`;
}

function counts(results) {
  const c = {};
  for (const r of results) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}

// ===================================================================== Excel

/** Sheets for a single run: summary, every check, AI analysis, AI Q&A. */
export function runSheets(bundle) {
  const { run, results, ai = {} } = bundle;
  const reps = run.snapshot?.reports || {};
  const c = counts(results);
  const S = done(ai.summary), AN = done(ai.anomalies);
  const vision = ai.vision || {};
  const summary = [
    ['Suite', run.suite_name], ['Run', `#${run.id}`], ['Result', RUN_STATUS_LABEL[run.status] || run.status],
    ['Started', fmtDate(run.started_at || run.queued_at)], ['Finished', fmtDate(run.finished_at)], ['Duration', fmtDur(runDurationMs(run))],
    ['Started by', run.triggered_by || run.trigger], ['Trigger', run.trigger],
    ['Report A', reps.A ? `${reps.A.name}${reps.A.environment ? ` (${reps.A.environment})` : ''}` : ''], ['Report A link', reps.A?.url],
    ['Report B', reps.B ? `${reps.B.name}${reps.B.environment ? ` (${reps.B.environment})` : ''}` : 'Single report (no comparison)'], ['Report B link', reps.B?.url],
    ['Checks', results.length],
    ...STATUS_ORDER.filter((s) => c[s]).map((s) => [STATUS_LABEL[s], c[s]]),
    ...(run.error ? [['Error', run.error]] : []),
    ...(S ? [['AI risk', S.risk], ['AI verdict', S.headline], ['AI summary', S.summary]] : [['AI analysis', 'Not available for this run']]),
  ].map(([field, value]) => ({ field, value }));

  const resultRows = [...results].sort((a, b) => a.seq - b.seq).map((r) => {
    const v = done(vision[r.id]);
    return {
      seq: r.seq, status: STATUS_LABEL[r.status] || r.status, scenario: SCENARIO_LABEL[r.scenario] || r.scenario, page: r.page || 'Report',
      title: r.title, target: r.target || '', diff: r.diff_ratio != null ? Number((r.diff_ratio * 100).toFixed(4)) : null,
      secs: r.duration_ms != null ? Number((r.duration_ms / 1000).toFixed(1)) : null,
      details: r.status === 'pass' ? '' : r.status === 'accepted' ? acceptedText(r) : describe(r),
      vision: v ? `${v.whatChanged}${v.likelyNoise ? ' (likely rendering noise)' : ''}` : '',
    };
  });

  const aiRows = [];
  if (S) {
    for (const f of S.findings || []) aiRows.push({ type: 'Finding', level: f.severity, category: f.category, title: f.title, detail: f.explanation, action: f.recommendation, refs: (f.resultRefs || []).map((x) => `#${x}`).join(' ') });
    for (const rc of S.rootCauses || []) aiRows.push({ type: 'Likely root cause', level: `${rc.confidence} confidence`, title: rc.cause, detail: rc.evidence, refs: (rc.resultRefs || []).map((x) => `#${x}`).join(' ') });
    (S.nextSteps || []).forEach((x, i) => aiRows.push({ type: 'Next step', level: `${i + 1}`, title: x }));
    for (const n of S.noise || []) aiRows.push({ type: 'Likely noise', title: n.reason, refs: (n.resultRefs || []).map((x) => `#${x}`).join(' ') });
  }
  if (AN) {
    for (const a of AN.anomalies || []) aiRows.push({ type: 'Data anomaly', level: a.severity, category: `${a.page} · ${a.visual}`, title: a.issue, detail: a.evidence, refs: (a.resultRefs || []).map((x) => `#${x}`).join(' ') });
    for (const r of AN.reconciliation || []) aiRows.push({ type: 'Reconciliation', level: r.status, title: r.check, detail: r.detail });
    if (AN.assessment) aiRows.push({ type: 'Data assessment', title: AN.assessment });
  }

  const sheets = [
    { name: 'Summary', columns: [{ key: 'field', header: 'Field', width: 18 }, { key: 'value', header: 'Value', width: 100, wrap: true }], rows: summary },
    {
      name: 'Checks',
      columns: [
        { key: 'seq', header: '#', width: 6 }, { key: 'status', header: 'Status', width: 10 }, { key: 'scenario', header: 'Scenario', width: 15 },
        { key: 'page', header: 'Page', width: 28 }, { key: 'title', header: 'Check', width: 50, wrap: true }, { key: 'target', header: 'Target', width: 24 },
        { key: 'diff', header: 'Pixels different (%)', width: 18 }, { key: 'secs', header: 'Duration (s)', width: 12 },
        { key: 'details', header: 'What went wrong', width: 70, wrap: true }, { key: 'vision', header: 'AI screenshot review', width: 60, wrap: true },
      ],
      rows: resultRows,
    },
  ];
  const ch = runChanges(run.id);
  const actionItems = S?.actionItems?.length ? S.actionItems : (run.snapshot?.reports?.B ? ch?.report.top : null) || [];
  if (actionItems.length) {
    sheets.splice(1, 0, {
      name: 'Action items',
      columns: [{ key: 'priority', header: 'Priority', width: 9 }, { key: 'area', header: 'Area', width: 14 }, { key: 'page', header: 'Page', width: 24 },
        { key: 'title', header: 'What to look into', width: 50, wrap: true }, { key: 'changed', header: 'What changed', width: 50, wrap: true },
        { key: 'cause', header: 'Likely cause', width: 40, wrap: true }, { key: 'action', header: 'Action', width: 40, wrap: true }, { key: 'owner', header: 'Owner', width: 20 },
        { key: 'refs', header: 'Checks', width: 14 }, { key: 'source', header: 'Ranked by', width: 10 }],
      rows: actionItems.map((x) => ({ priority: x.priority, area: x.area, page: x.page || '', title: x.object ? `${x.title} (${x.object})` : x.title, changed: x.whatChanged || x.evidence || '',
        cause: x.likelyCause || '', action: x.action || '', owner: x.owner || '', refs: (x.resultRefs || x.refs || []).map((n) => `#${n}`).join(' '), source: S?.actionItems?.length ? 'AI' : 'Rules' })),
    });
  }
  if (ch && run.snapshot?.reports?.B) {
    sheets.push({
      name: 'What changed',
      columns: [{ key: 'page', header: 'Page', width: 28 }, { key: 'state', header: 'Page status', width: 14 }, { key: 'level', header: 'Change level', width: 13 },
        { key: 'problems', header: 'Checks needing attention', width: 14 }, { key: 'accepted', header: 'Accepted', width: 10 },
        { key: 'layout', header: 'Layout changes', width: 50, wrap: true }, { key: 'values', header: 'Values changed', width: 12 },
        { key: 'interactions', header: 'Interactions that differ', width: 60, wrap: true }, { key: 'pixel', header: 'Page pixels different (%)', width: 14 }],
      rows: ch.pages.map((p) => ({
        page: p.renamedTo ? `${p.name} → ${p.renamedTo}` : p.name, state: PAGE_STATE[p.state], level: LEVEL_LABEL[p.level],
        problems: p.problems, accepted: p.accepted,
        layout: p.layout.map((l) => `${l.visual}: ${l.change}`).join('\n'),
        values: p.valuesChanged,
        interactions: p.interactions.map((i) => `${i.title}: ${i.summary}`).join('\n'),
        pixel: p.pixel == null ? null : +(p.pixel * 100).toFixed(3),
      })),
    });
    if (ch.report.model?.changes.length) {
      sheets.push({
        name: 'Model changes',
        columns: [{ key: 'status', header: 'Status', width: 10 }, { key: 'kind', header: 'Kind', width: 14 }, { key: 'table', header: 'Table', width: 22 },
          { key: 'object', header: 'Object', width: 40, wrap: true }, { key: 'change', header: 'Change', width: 14 }, { key: 'fields', header: 'What differs', width: 30, wrap: true },
          { key: 'a', header: 'A (before)', width: 60, wrap: true }, { key: 'b', header: 'B (after)', width: 60, wrap: true }],
        rows: ch.report.model.changes.map((c) => ({
          status: STATUS_LABEL[c.status] || c.status, kind: MODEL_KIND[c.kind] || c.kind, table: c.table || '', object: c.label || c.name,
          change: c.change === 'added' ? 'Added in B' : c.change === 'removed' ? 'Missing in B' : 'Changed',
          fields: (c.fields || []).map((f) => f.label).join(', '),
          a: (c.exprA || (c.fields || []).map((f) => (c.fields.length > 1 ? `${f.label}: ${f.a}` : String(f.a))).join('\n')).slice(0, 30000),
          b: (c.exprB || (c.fields || []).map((f) => (c.fields.length > 1 ? `${f.label}: ${f.b}` : String(f.b))).join('\n')).slice(0, 30000),
        })),
      });
    }
    const valueRows = ch.pages.flatMap((p) => p.values.flatMap((v) => v.changes.map((c) => ({ page: p.name, visual: v.visual, change: OP_LABEL[c.op] || c.op, a: c.a ?? '', b: c.b ?? '', status: STATUS_LABEL[v.status] || v.status }))));
    if (valueRows.length) {
      sheets.push({
        name: 'Value changes',
        columns: [{ key: 'page', header: 'Page', width: 24 }, { key: 'visual', header: 'Visual', width: 40, wrap: true }, { key: 'change', header: 'Change', width: 10 },
          { key: 'a', header: 'A (before)', width: 40, wrap: true }, { key: 'b', header: 'B (after)', width: 40, wrap: true }, { key: 'status', header: 'Status', width: 10 }],
        rows: valueRows,
      });
    }
  }
  if (aiRows.length) {
    sheets.push({
      name: 'AI analysis',
      columns: [{ key: 'type', header: 'Type', width: 18 }, { key: 'level', header: 'Severity / confidence', width: 18 }, { key: 'category', header: 'Category', width: 22 },
        { key: 'title', header: 'Title', width: 50, wrap: true }, { key: 'detail', header: 'Detail / evidence', width: 70, wrap: true }, { key: 'action', header: 'Recommendation', width: 60, wrap: true }, { key: 'refs', header: 'Checks', width: 14 }],
      rows: aiRows,
    });
  }
  if (ai.chat?.length) {
    sheets.push({
      name: 'AI questions',
      columns: [{ key: 'at', header: 'Asked', width: 20 }, { key: 'question', header: 'Question', width: 50, wrap: true }, { key: 'answer', header: 'Answer', width: 100, wrap: true }],
      rows: ai.chat.map((x) => ({ at: fmtDate(x.at), question: x.question, answer: x.answer })),
    });
  }
  return sheets;
}

/** One sheet listing runs (for the Runs page export). */
export function runsListSheets(runs) {
  return [{
    name: 'Runs',
    columns: [
      { key: 'id', header: 'Run', width: 7 }, { key: 'suite', header: 'Suite', width: 40 }, { key: 'status', header: 'Result', width: 16 },
      { key: 'trigger', header: 'Trigger', width: 10 }, { key: 'by', header: 'Started by', width: 28 }, { key: 'started', header: 'Started', width: 20 },
      { key: 'duration', header: 'Duration', width: 10 }, { key: 'total', header: 'Checks', width: 8 },
      ...STATUS_ORDER.map((s) => ({ key: s, header: STATUS_LABEL[s], width: 9 })),
    ],
    rows: runs.map((r) => {
      const by = r.summary?.byStatus || {};
      return {
        id: r.id, suite: r.suite_name, status: RUN_STATUS_LABEL[r.status] || r.status, trigger: r.trigger, by: r.triggered_by || '',
        started: fmtDate(r.started_at || r.queued_at), duration: fmtDur(runDurationMs(r)), total: r.summary?.total ?? null,
        ...Object.fromEntries(STATUS_ORDER.map((s) => [s, by[s] || null])),
      };
    }),
  }];
}

// ======================================================================= PDF

const CSS = `
.lvl{display:inline-block;min-width:58px;text-align:center;padding:1px 8px;border-radius:4px;font-size:11px;font-weight:600}
.lvl-none{background:#eef0f3;color:#4b5563}.lvl-low{background:#86b6ef;color:#0b2545}.lvl-medium{background:#256abf;color:#fff}.lvl-high{background:#0d366b;color:#fff}
@page { size: A4; margin: 16mm 14mm 18mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 10.5px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #18202b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1, h2, h3, h4 { margin: 0; line-height: 1.25; }
h2 { font-size: 15px; margin: 22px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #111827; break-after: avoid; }
h3 { font-size: 12px; margin: 14px 0 6px; break-after: avoid; }
p { margin: 0 0 8px; }
.muted { color: #5f6b7a; } .small { font-size: 9px; } .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9px; }
.cover { background: #111827; color: #fff; border-radius: 10px; padding: 18px 20px; display: flex; gap: 16px; align-items: center; }
.mark { width: 40px; height: 40px; border-radius: 9px; background: #f2c811; display: grid; place-items: center; flex: none; }
.cover h1 { font-size: 19px; } .cover .sub { color: #cbd5e1; margin-top: 3px; }
.cover .status { margin-left: auto; text-align: right; }
.pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-weight: 700; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
.big { font-size: 12px; padding: 5px 14px; }
.s-pass, .r-passed, .k-none, .k-low { background: #e9f7ee; color: #15803d; }
.s-diff, .r-diffs, .k-medium { background: #fff4e0; color: #b45309; }
.s-fail, .r-failed, .k-high, .k-critical { background: #fdecec; color: #c81e1e; }
.s-missing { background: #f2ecff; color: #7c3aed; } .s-error, .r-error { background: #ffe8ee; color: #be123c; }
.s-warn { background: #fef7d7; color: #a16207; } .s-accepted { background: #e0f2fe; color: #0369a1; } .s-skipped, .r-cancelled { background: #f0f1f3; color: #6b7280; }
.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 22px; margin: 14px 0 4px; }
.meta div { display: flex; gap: 8px; } .meta b { min-width: 86px; color: #5f6b7a; font-weight: 600; }
.meta .full { grid-column: 1 / -1; }
.tiles { display: flex; gap: 8px; margin: 12px 0 8px; }
.tile { flex: 1; border: 1px solid #e2e6ec; border-radius: 8px; padding: 8px 10px; }
.tile .n { font-size: 20px; font-weight: 800; } .tile .l { font-size: 8.5px; text-transform: uppercase; letter-spacing: .05em; color: #5f6b7a; font-weight: 700; }
.bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: #eef1f5; }
.bar span { display: block; height: 100%; }
.ai { border: 1px solid #ddd6fe; background: #faf8ff; border-radius: 10px; padding: 12px 14px; break-inside: avoid; }
.ai .head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; } .ai .head b { font-size: 12.5px; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; }
th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; color: #5f6b7a; padding: 5px 6px; border-bottom: 1.5px solid #cfd5de; background: #f6f7f9; }
td { padding: 5px 6px; border-bottom: 1px solid #eef1f5; vertical-align: top; }
tr { break-inside: avoid; }
ul, ol { margin: 0 0 8px; padding-left: 18px; } li { margin: 2px 0; }
.issue { border: 1px solid #e2e6ec; border-radius: 8px; padding: 10px 12px; margin: 0 0 10px; break-inside: avoid; }
.issue .t { display: flex; gap: 8px; align-items: center; font-weight: 700; font-size: 11px; }
.issue .why { margin: 5px 0 0; }
.issue .vision { margin-top: 5px; color: #5b21b6; }
.shots { display: flex; gap: 8px; margin-top: 8px; }
.shots figure { flex: 1; margin: 0; border: 1px solid #e2e6ec; border-radius: 6px; overflow: hidden; }
.shots figcaption { font-size: 8.5px; font-weight: 700; padding: 3px 6px; background: #f6f7f9; border-bottom: 1px solid #e2e6ec; }
.shots img { display: block; width: 100%; max-height: 330px; object-fit: contain; object-position: top; background: #fff; }
.note { border-left: 3px solid #cfd5de; padding: 6px 10px; background: #f6f7f9; border-radius: 0 6px 6px 0; margin: 8px 0; }
.qa { margin-bottom: 10px; break-inside: avoid; } .qa .q { font-weight: 700; } .qa .a { white-space: pre-wrap; }
.page-break { break-before: page; }
`;

const STATUS_COLOR = { accepted: '#0284c7', pass: '#16a34a', diff: '#d97706', fail: '#dc2626', missing: '#7c3aed', error: '#be123c', warn: '#ca8a04', skipped: '#9ca3af' };
const LOGO = '<svg width="22" height="22" viewBox="0 0 32 32"><rect x="7" y="16" width="4" height="9" fill="#111"/><rect x="14" y="10" width="4" height="15" fill="#111"/><rect x="21" y="6" width="4" height="19" fill="#111"/></svg>';
const refs = (list) => (list?.length ? ` <span class="muted small">(${list.map((x) => `#${x}`).join(', ')})</span>` : '');

/** Images that exist on disk for a result, as [caption, file] pairs to show in the PDF. */
function shotsFor(r, dir, names) {
  const im = r.images || {};
  const ok = (f) => f && fs.existsSync(path.join(dir, path.basename(f)));
  const out = [];
  if (ok(im.annotated)) out.push([`B · ${names.B || 'report B'} (differences outlined)`, im.annotated]);
  else if (ok(im.diff) && ok(im.b)) out.push([`B · ${names.B || 'report B'}`, im.b], ['Pixel difference (red)', im.diff]);
  if (ok(im.a) && (out.length < 2)) out.unshift([`A · ${names.A || 'report A'}`, im.a]);
  if (!out.length && ok(im.b)) out.push([`B · ${names.B || 'report B'}`, im.b]);
  return out.slice(0, 2).map(([cap, f]) => [cap, path.basename(f)]);
}

/** "What changed" section: report-level headline, page heatmap, value changes. */
function changesHtml(ch) {
  const t = ch.report.totals;
  let h = `<h2>What changed</h2><p><b>${esc(ch.report.headline)}</b></p><div class="tiles">
    <div class="tile"><div class="n">${t.pagesChanged}</div><div class="l">Pages changed${t.pagesA != null ? ` (of ${Math.max(t.pagesA, t.pagesB || 0)})` : ''}</div></div>
    <div class="tile"><div class="n">${t.visualsAdded}/${t.visualsRemoved}</div><div class="l">Visuals added / removed</div></div>
    <div class="tile"><div class="n">${t.valuesChanged}</div><div class="l">Values changed</div></div>
    <div class="tile"><div class="n">${t.interactionsChanged}</div><div class="l">Interactions that differ</div></div></div>`;
  const rp = ch.report;
  if (rp.removed.length || rp.added.length || rp.renamed.length) {
    h += `<p class="small">${rp.removed.length ? `<b>Pages only in A:</b> ${rp.removed.map(esc).join(', ')}. ` : ''}${rp.added.length ? `<b>Pages only in B:</b> ${rp.added.map(esc).join(', ')}. ` : ''}${rp.renamed.length ? `<b>Renamed:</b> ${rp.renamed.map((x) => `${esc(x.a)} → ${esc(x.b)}`).join(', ')}.` : ''}</p>`;
  }
  h += `<table><thead><tr><th>Page</th><th>Change</th><th>Need attention</th><th>Layout</th><th>Values changed</th><th>Interactions</th><th>Page pixels</th></tr></thead><tbody>
    ${ch.pages.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.renamedTo ? `<br><span class="muted small">now "${esc(p.renamedTo)}"</span>` : ''}</td>
      <td><span class="lvl lvl-${p.level}">${p.state === 'removed' ? 'Removed' : p.state === 'added' ? 'Added' : LEVEL_LABEL[p.level]}</span></td>
      <td>${p.problems || '<span class="muted">·</span>'}${p.accepted ? ` <span class="muted small">(+${p.accepted} accepted)</span>` : ''}</td>
      <td class="small">${p.layout.length ? p.layout.slice(0, 6).map((l) => `${esc(l.visual)}: <b>${esc(l.change)}</b>`).join('<br>') : '<span class="muted">·</span>'}</td>
      <td>${p.valuesChanged || '<span class="muted">·</span>'}</td>
      <td class="small">${p.interactions.filter((i) => i.status !== 'accepted').slice(0, 4).map((i) => esc(i.title)).join('<br>') || '<span class="muted">·</span>'}</td>
      <td>${p.pixel == null ? '' : pct(p.pixel)}</td></tr>`).join('')}
  </tbody></table>`;
  const md = ch.report.model;
  if (md) {
    h += '<h3>Data model</h3>';
    if (!md.compared) h += `<p class="muted small">${esc(md.note)}</p>`;
    else {
      const st = md.info.stats || {};
      h += `<p class="small">A: ${esc(md.info.sources?.A || '')} · B: ${esc(md.info.sources?.B || '')}</p>
        <table><thead><tr><th></th><th>Tables</th><th>Columns</th><th>Measures</th><th>Relationships</th><th>Roles</th></tr></thead><tbody>
        ${['A', 'B'].map((s) => `<tr><td><b>${s}</b></td><td>${st[s]?.tables ?? ''}</td><td>${st[s]?.columns ?? ''}</td><td>${st[s]?.measures ?? ''}</td><td>${st[s]?.relationships ?? ''}</td><td>${st[s]?.roles ?? ''}</td></tr>`).join('')}</tbody></table>`;
      if (!md.changes.length) h += '<p class="small"><b>The two data models are identical.</b></p>';
      else {
        h += `<table><thead><tr><th>Status</th><th>Kind</th><th>Object</th><th>Change</th></tr></thead><tbody>
          ${md.changes.slice(0, 80).map((c) => `<tr><td><span class="pill s-${esc(c.status)}">${esc(STATUS_LABEL[c.status] || c.status)}</span></td><td>${esc(MODEL_KIND[c.kind] || c.kind)}</td><td class="mono">${esc(c.table && !['table', 'relationship'].includes(c.kind) ? `${c.table} · ${c.label}` : c.label)}</td>
            <td class="small">${esc(c.change === 'added' ? 'Added in B' : c.change === 'removed' ? 'Missing in B' : `Changed: ${(c.fields || []).map((f) => f.label).join(', ')}`)}</td></tr>`).join('')}
        </tbody></table>${md.changes.length > 80 ? `<p class="muted small">${md.changes.length - 80} more in the Excel export.</p>` : ''}`;
      }
    }
  }
  const vals = ch.pages.flatMap((p) => p.values.flatMap((v) => v.changes.map((c) => ({ page: p.name, visual: v.visual, ...c }))));
  if (vals.length) {
    h += `<h3>Value changes (${vals.length})</h3><table><thead><tr><th>Page</th><th>Visual</th><th>Change</th><th>A (before)</th><th>B (after)</th></tr></thead><tbody>
      ${vals.slice(0, 60).map((v) => `<tr><td>${esc(v.page)}</td><td>${esc(v.visual)}</td><td>${OP_LABEL[v.op] || esc(v.op)}</td><td class="mono">${esc(v.a ?? '')}</td><td class="mono">${esc(v.b ?? '')}</td></tr>`).join('')}
    </tbody></table>${vals.length > 60 ? `<p class="muted small">${vals.length - 60} more in the Excel export.</p>` : ''}`;
  }
  return h;
}

/** Print-ready HTML for one run. Image paths are relative to the run's folder. */
export function reportHtml(bundle, { maxIssues = 40, maxPageShots = 24, includeImages = true } = {}) {
  const { run, results, ai = {} } = bundle;
  const dir = runDir(run.id);
  const reps = run.snapshot?.reports || {};
  const names = { A: reps.A?.name, B: reps.B?.name };
  const c = counts(results);
  const total = results.length || 1;
  const S = done(ai.summary), AN = done(ai.anomalies);
  const vision = ai.vision || {};
  const problems = results.filter((r) => PROBLEM.has(r.status)).sort((a, b) => rank(a.status) - rank(b.status) || a.seq - b.seq);
  const reportLine = (side, rep) => (rep ? `<div class="full"><b>Report ${side}</b><span>${esc(rep.name)}${rep.environment ? ` · ${esc(rep.environment)}` : ''}<br><span class="mono muted">${esc(rep.url || '')}</span></span></div>` : '');

  let h = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(run.suite_name)} · run #${run.id}</title><style>${CSS}</style></head><body>`;
  h += `<div class="cover"><div class="mark">${LOGO}</div><div><h1>Power BI validation report</h1><div class="sub">${esc(run.suite_name)} · run #${run.id}</div></div>
    <div class="status"><span class="pill big r-${esc(run.status)}">${esc(RUN_STATUS_LABEL[run.status] || run.status)}</span>
    ${S ? `<div style="margin-top:6px"><span class="pill k-${esc(S.risk)}">${esc(S.risk)} risk</span></div>` : ''}</div></div>`;
  h += `<div class="meta">${reportLine('A', reps.A)}${reps.B ? reportLine('B', reps.B) : '<div class="full"><b>Mode</b><span>Single report (validated on its own, no comparison)</span></div>'}
    <div><b>Started</b><span>${fmtDate(run.started_at || run.queued_at)}</span></div><div><b>Duration</b><span>${fmtDur(runDurationMs(run))}</span></div>
    <div><b>Started by</b><span>${esc(run.triggered_by || run.trigger)}${run.triggered_by ? ` (${esc(run.trigger)})` : ''}</span></div><div><b>Generated</b><span>${fmtDate(new Date().toISOString())}</span></div></div>`;
  if (run.error) h += `<div class="note"><b>Run error:</b> ${esc(run.error)}</div>`;

  // Result summary.
  h += '<h2>Result summary</h2><div class="tiles">';
  h += `<div class="tile"><div class="n">${results.length}</div><div class="l">Checks</div></div>`;
  h += `<div class="tile"><div class="n" style="color:#15803d">${c.pass || 0}</div><div class="l">Passed</div></div>`;
  h += `<div class="tile"><div class="n" style="color:${problems.length ? '#c81e1e' : '#15803d'}">${problems.length}</div><div class="l">Need attention</div></div>`;
  h += `<div class="tile"><div class="n">${Math.round(((c.pass || 0) / total) * 100)}%</div><div class="l">Pass rate</div></div></div>`;
  h += `<div class="bar">${STATUS_ORDER.filter((s) => c[s]).map((s) => `<span style="width:${(c[s] / total) * 100}%;background:${STATUS_COLOR[s]}"></span>`).join('')}</div>`;
  h += `<p class="small" style="margin-top:6px">${STATUS_ORDER.filter((s) => c[s]).map((s) => `<span class="pill s-${s}">${STATUS_LABEL[s]} ${c[s]}</span>`).join(' ')}</p>`;
  const byScenario = {};
  for (const r of results) { byScenario[r.scenario] ??= {}; byScenario[r.scenario][r.status] = (byScenario[r.scenario][r.status] || 0) + 1; }
  h += `<table><thead><tr><th>Scenario</th>${STATUS_ORDER.map((s) => `<th>${STATUS_LABEL[s]}</th>`).join('')}<th>Total</th></tr></thead><tbody>
    ${Object.entries(byScenario).map(([sc, m]) => `<tr><td><b>${esc(SCENARIO_LABEL[sc] || sc)}</b></td>${STATUS_ORDER.map((s) => `<td>${m[s] ? `<span class="pill s-${s}">${m[s]}</span>` : '<span class="muted">·</span>'}</td>`).join('')}<td>${Object.values(m).reduce((a, b) => a + b, 0)}</td></tr>`).join('')}
  </tbody></table>`;

  // What changed (comparisons only), led by what the Power BI team should look into.
  const ch = reps.B ? runChanges(run.id) : null;
  const items = S?.actionItems?.length ? S.actionItems : ch?.report.top || [];
  if (items.length) {
    h += `<h2>Action items for the Power BI team</h2><p class="muted small">${S?.actionItems?.length ? 'Prioritised by AI from the checks below; verify before acting.' : 'Ranked automatically: P1 numbers, missing content and model changes first.'}</p>
      <table><thead><tr><th>Priority</th><th>What to look into</th><th>What changed</th><th>${S?.actionItems?.length ? 'Likely cause → action' : 'Who'}</th><th>Checks</th></tr></thead><tbody>
      ${items.map((x) => `<tr><td><span class="pill ${x.priority === 'P1' ? 's-fail' : x.priority === 'P2' ? 's-warn' : 's-skipped'}">${esc(x.priority)}</span></td>
        <td><b>${esc(x.title)}</b><div class="muted small">${esc([x.area, x.page, x.object].filter(Boolean).join(' · '))}</div>${x.impact ? `<div class="small">${esc(x.impact)}</div>` : ''}</td>
        <td class="mono small">${esc(x.whatChanged || x.evidence || '')}</td>
        <td class="small">${S?.actionItems?.length ? `${esc(x.likelyCause || '')}${x.action ? `<div>→ ${esc(x.action)}</div>` : ''}${x.owner ? `<div class="muted">${esc(x.owner)}</div>` : ''}` : esc(x.owner || '')}</td>
        <td class="small">${(x.resultRefs || x.refs || []).slice(0, 8).map((n) => `#${n}`).join(' ')}</td></tr>`).join('')}
      </tbody></table>`;
  }
  if (ch) h += changesHtml(ch);

  // AI analysis.
  h += '<h2>AI analysis</h2>';
  if (S) {
    h += `<div class="ai"><div class="head"><span class="pill k-${esc(S.risk)}">${esc(S.risk)} risk</span><b>${esc(S.headline)}</b></div><p>${esc(S.summary)}</p>
      <div class="muted small">Model: ${esc(ai.summary.model || '')}. AI output can be wrong; check the evidence before acting on it.</div></div>`;
    if (S.findings?.length) {
      h += `<h3>Findings</h3><table><thead><tr><th style="width:70px">Severity</th><th>Finding</th><th style="width:34%">Recommendation</th></tr></thead><tbody>
        ${S.findings.map((f) => `<tr><td><span class="pill k-${esc(f.severity === 'info' ? 'none' : f.severity)}">${esc(f.severity)}</span></td><td><b>${esc(f.title)}</b>${refs(f.resultRefs)}<br>${esc(f.explanation)}</td><td>${esc(f.recommendation || '')}</td></tr>`).join('')}</tbody></table>`;
    }
    if (S.rootCauses?.length) h += `<h3>Likely root causes</h3><ul>${S.rootCauses.map((x) => `<li><b>${esc(x.cause)}</b> <span class="muted">(${esc(x.confidence)} confidence)</span>: ${esc(x.evidence)}${refs(x.resultRefs)}</li>`).join('')}</ul>`;
    if (S.nextSteps?.length) h += `<h3>Recommended next steps</h3><ol>${S.nextSteps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`;
    if (S.noise?.length) h += `<h3>Probably not real problems</h3><ul>${S.noise.map((n) => `<li>${esc(n.reason)}${refs(n.resultRefs)}</li>`).join('')}</ul>`;
  } else {
    h += `<div class="note">AI analysis ${ai.summary?.status === 'error' ? `failed for this run: ${esc(ai.summary.error || '')}` : 'was not run for this run'}. Open the run in PBI Report Test and use “AI insights” to run it, then export again.</div>`;
  }
  if (AN) {
    h += `<h3>Data anomalies</h3>${AN.assessment ? `<p>${esc(AN.assessment)}</p>` : ''}`;
    if (AN.anomalies?.length) h += `<table><thead><tr><th style="width:70px">Severity</th><th style="width:30%">Where</th><th>Issue</th></tr></thead><tbody>${AN.anomalies.map((a) => `<tr><td><span class="pill k-${esc(a.severity)}">${esc(a.severity)}</span></td><td>${esc(a.page)}<br><b>${esc(a.visual)}</b></td><td>${esc(a.issue)}${refs(a.resultRefs)}<br><span class="muted">${esc(a.evidence)}</span></td></tr>`).join('')}</tbody></table>`;
    if (AN.reconciliation?.length) h += `<table><thead><tr><th>Reconciliation check</th><th style="width:90px">Result</th><th>Detail</th></tr></thead><tbody>${AN.reconciliation.map((x) => `<tr><td>${esc(x.check)}</td><td><span class="pill ${x.status === 'consistent' ? 's-pass' : x.status === 'inconsistent' ? 's-fail' : 's-skipped'}">${esc(x.status)}</span></td><td>${esc(x.detail)}</td></tr>`).join('')}</tbody></table>`;
  }

  // Issues needing attention, with screenshots.
  if (problems.length) {
    h += `<h2 class="page-break">Checks needing attention (${problems.length})</h2>`;
    if (problems.length > maxIssues) h += `<p class="muted">Showing the ${maxIssues} most severe. Every check is listed in the appendix.</p>`;
    for (const r of problems.slice(0, maxIssues)) {
      const v = done(vision[r.id]);
      const shots = includeImages ? shotsFor(r, dir, names) : [];
      h += `<div class="issue"><div class="t"><span class="pill s-${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span><span>#${r.seq} · ${esc(r.title)}</span></div>
        <div class="muted small">${esc(SCENARIO_LABEL[r.scenario] || r.scenario)} · page: ${esc(r.page || 'Report')}${r.diff_ratio != null ? ` · ${pct(r.diff_ratio)} pixels differ` : ''}</div>
        <div class="why">${esc(describe(r))}</div>
        ${v ? `<div class="vision">AI screenshot review: ${esc(v.whatChanged)}${v.likelyNoise ? ' (likely rendering noise)' : ''}</div>` : ''}
        ${shots.length ? `<div class="shots">${shots.map(([cap, f]) => `<figure><figcaption>${esc(cap)}</figcaption><img src="${encodeURIComponent(f)}"></figure>`).join('')}</div>` : ''}</div>`;
    }
  } else if (includeImages) {
    const pages = results.filter((r) => r.scenario === 'page_render').slice(0, maxPageShots);
    const withShots = pages.map((r) => [r, shotsFor(r, dir, names)]).filter(([, s]) => s.length);
    if (withShots.length) {
      h += '<h2 class="page-break">Page screenshots</h2><p class="muted">Every check passed. The pages as they were captured during this run:</p>';
      for (const [r, shots] of withShots) {
        h += `<div class="issue"><div class="t"><span class="pill s-pass">Pass</span><span>${esc(r.page || r.title)}</span></div>
          <div class="shots">${shots.map(([cap, f]) => `<figure><figcaption>${esc(cap)}</figcaption><img src="${encodeURIComponent(f)}"></figure>`).join('')}</div></div>`;
      }
    }
  }

  // Differences accepted as expected (kept visible for transparency).
  const accepted = results.filter((r) => r.status === 'accepted');
  if (accepted.length) {
    h += `<h2>Accepted as expected (${accepted.length})</h2><p class="muted">These differences were marked as intended by an editor, so they don't count as problems.</p>
      <table><thead><tr><th style="width:28px">#</th><th>Check</th><th style="width:70px">Was</th><th style="width:34%">Accepted</th></tr></thead><tbody>
      ${accepted.map((r) => { const a = r.details?.accepted || {}; return `<tr><td class="muted">${r.seq}</td><td><b>${esc(r.title)}</b><br><span class="muted small">${esc(SCENARIO_LABEL[r.scenario] || r.scenario)} · ${esc(r.page || 'Report')}</span></td><td><span class="pill s-${esc(a.originalStatus || '')}">${esc(STATUS_LABEL[a.originalStatus] || a.originalStatus || '')}</span></td><td>${esc(a.by || '')}${a.at ? `, ${esc(fmtDate(a.at))}` : ''}${a.note ? `<br><span class="muted">“${esc(a.note)}”</span>` : ''}<br><span class="muted small">${a.scope === 'any' ? 'Any difference in this check' : 'This exact difference'}</span></td></tr>`; }).join('')}
      </tbody></table>`;
  }

  // Q&A.
  if (ai.chat?.length) {
    h += '<h2>Questions asked to the AI</h2>';
    for (const x of ai.chat) h += `<div class="qa"><div class="q">Q: ${esc(x.question)}</div><div class="a">${esc(x.answer)}</div><div class="muted small">${fmtDate(x.at)}</div></div>`;
  }

  // Appendix: every check.
  h += `<h2 class="page-break">Appendix: all checks (${results.length})</h2>
    <table><thead><tr><th style="width:28px">#</th><th style="width:62px">Status</th><th style="width:78px">Scenario</th><th style="width:24%">Page</th><th>Check</th><th style="width:56px">Diff</th></tr></thead><tbody>
    ${[...results].sort((a, b) => a.seq - b.seq).slice(0, 3000).map((r) => `<tr><td class="muted">${r.seq}</td><td><span class="pill s-${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td><td>${esc(SCENARIO_LABEL[r.scenario] || r.scenario)}</td><td>${esc(r.page || 'Report')}</td><td>${esc(r.title)}${PROBLEM.has(r.status) ? `<br><span class="muted small">${esc(describe(r)).slice(0, 400)}</span>` : ''}</td><td class="mono">${pct(r.diff_ratio)}</td></tr>`).join('')}
    </tbody></table>`;
  h += '</body></html>';
  return h;
}

// One PDF at a time: each render starts a browser, and runs share the machine.
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

/** Renders the run report to a PDF Buffer with headless Chromium. */
export function renderRunPdf(bundle) {
  return serial(async () => {
    const { run } = bundle;
    const dir = runDir(run.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `.print-${crypto.randomBytes(6).toString('hex')}.html`);
    fs.writeFileSync(file, reportHtml(bundle));
    const started = Date.now();
    const browser = await launchBrowser({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 90_000 });
      const footer = `<div style="font:8px Helvetica,Arial,sans-serif;color:#6b7686;width:100%;padding:0 14mm;display:flex;justify-content:space-between">
        <span>PBI Report Test · ${esc(run.suite_name)} · run #${run.id}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
      const pdf = await page.pdf({
        format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer,
        margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
      });
      logger.info(`PDF for run #${run.id}: ${(pdf.length / 1024).toFixed(0)} KB in ${Date.now() - started} ms`);
      return pdf;
    } finally {
      await browser.close().catch(() => {});
      fs.rmSync(file, { force: true });
    }
  });
}
