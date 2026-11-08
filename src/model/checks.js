import fs from 'node:fs';
import { diffLines } from '../engine/compare.js';
import { compareModels, changeTitle, KIND_LABEL } from './compare.js';
import { fetchModel, parseReportUrl, servicePrincipalConfigured, servicePrincipalToken } from './powerbi.js';
import { modelStats } from './snapshot.js';

const MAX_CHANGES = 300;
const exprLines = (s) => (s ? String(s).split('\n') : []);

/**
 * Gets a model snapshot for one side: an uploaded model file first, then the
 * Power BI API with the service principal, then with the report's signed-in
 * Power BI session. Returns { snap } or { unavailable: reason }.
 */
export async function loadModel(rep, { browserToken, log }) {
  if (rep.modelPath && fs.existsSync(rep.modelPath)) {
    const snap = JSON.parse(fs.readFileSync(rep.modelPath, 'utf8'));
    return { snap: { ...snap, source: `uploaded file ${snap.source || ''}`.trim() } };
  }
  if (!parseReportUrl(rep.url)) {
    return { unavailable: 'no model file was uploaded for this report link, and its URL has no workspace/report ID (publish-to-web links don\'t), so the model can\'t be read from Power BI' };
  }
  const errors = [];
  if (servicePrincipalConfigured()) {
    try { return { snap: await fetchModel({ url: rep.url, token: await servicePrincipalToken(), via: 'service principal' }) }; }
    catch (e) { errors.push(`service principal: ${e.message}`); log('warn', `Model via service principal failed: ${e.message}`); }
  }
  const token = await browserToken().catch(() => null);
  if (token) {
    try { return { snap: await fetchModel({ url: rep.url, token, via: 'signed-in session' }) }; }
    catch (e) { errors.push(`signed-in session: ${e.message}`); log('warn', `Model via signed-in session failed: ${e.message}`); }
  }
  if (!errors.length) return { unavailable: 'no Power BI sign-in or service principal is available to read the model, and no model file was uploaded' };
  return { failed: errors.join(' · ') };
}

/** Records the data-model checks of a run. */
export async function runModelChecks({ compare, reports, record, log, browserToken }) {
  const sides = compare ? ['A', 'B'] : ['A'];
  const got = {};
  for (const side of sides) got[side] = await loadModel(reports[side], { browserToken: () => browserToken(side), log });

  const problem = sides.find((s) => !got[s].snap);
  if (problem) {
    const g = got[problem];
    await record({
      page: '', scenario: 'model', target: 'model', title: 'Data model comparison',
      status: g.failed ? 'warn' : 'skipped',
      details: {
        note: g.failed ? `Could not read the data model of ${problem}: ${g.failed}` : `Data model not compared: for report ${problem}, ${g.unavailable}. Upload a .pbit, model.bim or TMDL file on the report link to enable it.`,
        model: { sources: Object.fromEntries(sides.map((s) => [s, got[s].snap?.source || null])) },
      },
    });
    return { compared: false };
  }

  const A = got.A.snap, B = got.B?.snap;
  const stats = Object.fromEntries(sides.map((s) => [s, modelStats(got[s].snap)]));
  const summary = {
    sources: Object.fromEntries(sides.map((s) => [s, got[s].snap.source])),
    names: Object.fromEntries(sides.map((s) => [s, got[s].snap.name || null])),
    lastRefresh: Object.fromEntries(sides.map((s) => [s, got[s].snap.meta?.lastRefresh || null])),
    stats,
  };
  if (!compare) {
    const st = stats.A;
    await record({ page: '', scenario: 'model', target: 'model', title: 'Data model inventory', status: 'pass',
      details: { note: `${st.tables} tables, ${st.columns} columns, ${st.measures} measures, ${st.relationships} relationships, ${st.roles} roles`, model: summary } });
    return { compared: false };
  }

  const res = compareModels(A, B);
  log(res.changes.length ? 'warn' : 'info', `Data model: ${res.changes.length ? `${res.counts.changed} changed, ${res.counts.added} added in B, ${res.counts.removed} missing in B` : 'identical'}`);
  await record({
    page: '', scenario: 'model', target: 'model', title: 'Data model comparison',
    status: res.changes.length ? 'diff' : 'pass',
    details: {
      model: { ...summary, counts: res.counts, byKind: res.byKind, total: res.changes.length },
      note: res.changes.length
        ? Object.entries(res.byKind).map(([k, v]) => `${KIND_LABEL[k]}s: ${[v.changed && `${v.changed} changed`, v.added && `${v.added} added`, v.removed && `${v.removed} missing in B`].filter(Boolean).join(', ')}`).join(' · ')
        : `Identical: ${stats.A.tables} tables, ${stats.A.measures} measures, ${stats.A.relationships} relationships`,
    },
  });
  for (const c of res.changes.slice(0, MAX_CHANGES)) {
    // Only show expressions when they are what differs (not for a format-only change).
    const exprChanged = c.change !== 'changed' || c.fields.some((f) => ['expression', 'source', 'table'].includes(f.field) || f.field.startsWith('filter:'));
    if (!exprChanged) { c.exprA = ''; c.exprB = ''; }
    const hasExpr = c.exprA || c.exprB;
    const plain = c.fields.filter((f) => !['expression', 'source'].includes(f.field) && !f.field.startsWith('filter:'));
    await record({
      page: '', scenario: 'model', target: `model|${c.kind}|${c.table}|${c.name}`, title: changeTitle(c),
      status: c.change === 'removed' ? 'missing' : 'diff',
      details: {
        model: { kind: c.kind, change: c.change, table: c.table, name: c.name, label: c.label, fields: c.fields, exprA: String(c.exprA || '').slice(0, 20000), exprB: String(c.exprB || '').slice(0, 20000) },
        ...(c.change === 'removed' ? { missingIn: 'B' } : {}),
        ...(hasExpr ? { data: diffLines(exprLines(c.exprA), exprLines(c.exprB), { normalize: (s) => s.replace(/\s+/g, ' ').trim() }) } : {}),
        ...(plain.length ? { note: plain.map((f) => `${f.label}: ${f.a === '' ? '(none)' : f.a} → ${f.b === '' ? '(none)' : f.b}`).join('; ') } : {}),
      },
    });
  }
  if (res.changes.length > MAX_CHANGES) log('warn', `Data model: only the first ${MAX_CHANGES} of ${res.changes.length} changes were recorded`);
  return { compared: true, changes: res.changes.length };
}
