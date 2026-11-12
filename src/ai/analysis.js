import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { q, insert, update } from '../db.js';
import { createLogger } from '../logger.js';
import { chat, chatJson, imagePart, aiStatus } from './client.js';
import { buildComparisonImage, singleImage } from './images.js';
import { runChanges } from '../jobs/changes.js';
import { evidenceOf, basisOf, basisNote } from './values.js';

const logger = createLogger('ai');
const runDirOf = (runId) => path.join(config.runsDir, String(runId));
const PROBLEM = ['fail', 'error', 'missing', 'diff', 'warn'];
const SEV_RANK = { fail: 0, missing: 1, error: 2, diff: 3, warn: 4 };
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

let emitter = null;
/** Lets the queue forward AI progress to live run subscribers. */
export function setAiEmitter(fn) { emitter = fn; }
const emit = (runId, payload) => emitter?.(runId, { type: 'ai', ...payload });

// ---------------------------------------------------------------- digests
const LOOK_ONLY = new Set(['appearance', 'page', 'unread']);
const localeOf = (run) => run?.snapshot?.config?.locale || 'en-US';

/**
 * One check as the AI reads it: what it is, then its values. Every changed
 * value comes with its before, its after and the difference already worked
 * out. How different the pictures are is not passed on: a check whose values
 * match is only labelled as looking different.
 */
function resultLine(r, { locale = 'en-US', max = 12 } = {}) {
  const d = r.details || {};
  const ev = evidenceOf(r, { locale, max });
  const bits = [`#${r.seq} [${r.status.toUpperCase()}] ${r.scenario} | page: ${r.page || '(report)'} | ${r.title}`];
  if (d.note && !LOOK_ONLY.has(ev.basis)) bits.push(`  note: ${d.note}`);
  if (typeof d.error === 'string') bits.push(`  error: ${clip(d.error.split('\n')[0], 200)}`);
  if (d.missingIn) bits.push(`  missing in report ${d.missingIn}${d.lines?.length ? `; it showed: ${d.lines.slice(0, 8).map((l) => clip(l, 60)).join(' | ')}` : ''}`);
  if (d.outcome) bits.push(`  outcome A: ${JSON.stringify(d.outcome.A)}${d.outcome.B ? ` | B: ${JSON.stringify(d.outcome.B)}` : ''}`);
  if (d.value) bits.push(`  slicer value applied: ${d.value}`);
  if (d.dataPoint?.A) bits.push(`  data point used: A "${clip(d.dataPoint.A, 60)}"${d.dataPoint.B ? `, B "${clip(d.dataPoint.B, 60)}"` : ''}`);
  if (d.defaultA || d.defaultB) bits.push(`  opens on: A ${JSON.stringify(d.defaultA || [])} | B ${JSON.stringify(d.defaultB || [])}`);
  bits.push(...ev.lines);
  if (basisNote(ev.basis)) bits.push(`  ${basisNote(ev.basis)}`);
  if (d.issues?.length) bits.push(`  layout: ${d.issues.slice(0, 6).map((i) => `${i.kind} ${i.visual}`).join('; ')}`);
  if (d.onlyInA?.length || d.onlyInB?.length || d.renamed?.length) bits.push(`  pages only in A: ${d.onlyInA?.join(', ') || '-'}; only in B: ${d.onlyInB?.join(', ') || '-'}; renamed: ${(d.renamed || []).map((x) => `${x.a}→${x.b}`).join(', ') || '-'}`);
  if (d.errors) {
    const errs = Object.entries(d.errors).flatMap(([s, l]) => l.map((e) => `${s}: ${e.visual} — ${e.error}`));
    if (errs.length) bits.push(`  visual errors: ${errs.slice(0, 5).join('; ')}`);
  }
  return bits.join('\n');
}

/** Data model and page overview of a comparison (the "What changed" tab), as text. */
function overviewText(runId, snap) {
  try {
    const ch = runChanges(runId);
    if (!ch || !snap.reports?.B) return '';
    const m = ch.report.model;
    return [
      `WHAT CHANGED (A → B): ${ch.report.headline}`,
      m ? `Data model: ${m.compared ? `${m.changes.length} difference(s): ${m.changes.slice(0, 25).map((c) => `${c.title}${c.fields?.length ? ` [${c.fields.map((f) => (/^(DAX|Source query|Row filter|Expression)/.test(f.label) ? `${f.label}: ${clip(String(c.exprA || f.a).replace(/\s+/g, ' '), 120)} → ${clip(String(c.exprB || f.b).replace(/\s+/g, ' '), 120)}` : `${f.label}: ${clip(f.a, 40) || '(none)'} → ${clip(f.b, 40) || '(none)'}`)).join('; ')}]` : ''}`).join(' | ')}` : m.note}` : null,
      `Pages: ${ch.pages.map((p) => `${p.name}=${p.state === 'unchanged' ? 'unchanged' : `${p.level}${p.valuesChanged ? `, ${p.valuesChanged} values` : ''}${p.layout.length ? `, ${p.layout.length} layout` : ''}${p.interactions.length ? `, ${p.interactions.length} interactions` : ''}`}`).join('; ')}`,
      `RANKED BY RULES (P1 highest): ${ch.report.top.map((t) => `${t.priority} ${t.area}${t.page ? ` @${t.page}` : ''}: ${t.title} — ${t.evidence}${t.refs.length ? ` (#${t.refs.join(', #')})` : ''}`).join(' | ')}`,
    ].filter(Boolean).join('\n');
  } catch { return ''; /* the overview is optional */ }
}

export function buildRunDigest(runId, maxChars = 28000) {
  const run = q.get('SELECT * FROM runs WHERE id = ?', runId);
  if (!run) throw Object.assign(new Error('Run not found'), { status: 404 });
  const results = q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId);
  const snap = run.snapshot || {};
  const locale = localeOf(run);
  const problems = results.filter((r) => PROBLEM.includes(r.status)).map((r) => ({ r, ev: evidenceOf(r, { locale }) }));
  // Checks that rest on values and facts first, biggest value changes first;
  // checks that only look different go last, in their own list.
  const facts = problems.filter((x) => !LOOK_ONLY.has(x.ev.basis)).sort((a, b) => (SEV_RANK[a.r.status] - SEV_RANK[b.r.status]) || (b.ev.impact - a.ev.impact) || a.r.seq - b.r.seq);
  const looks = problems.filter((x) => LOOK_ONLY.has(x.ev.basis)).sort((a, b) => a.r.seq - b.r.seq);
  const valueChecks = facts.filter((x) => x.ev.basis === 'values' && x.ev.changed);
  const head = [
    `Suite: ${run.suite_name} (${snap.suite?.mode === 'single' ? 'single-report validation' : 'comparison A ⇄ B'})`,
    `Report A (baseline): ${snap.reports?.A?.name || '?'}${snap.reports?.A?.environment ? ` [${snap.reports.A.environment}]` : ''}`,
    snap.reports?.B ? `Report B (candidate): ${snap.reports.B.name}${snap.reports.B.environment ? ` [${snap.reports.B.environment}]` : ''}` : null,
    `Run status: ${run.status}${run.error ? ` (error: ${run.error})` : ''}; ${results.length} checks; by status: ${JSON.stringify(run.summary?.byStatus || {})}`,
    `Checks by scenario: ${Object.entries(run.summary?.byScenario || {}).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join('; ')}`,
    `Values: ${valueChecks.length} check(s) with different values, ${valueChecks.reduce((n, x) => n + x.ev.changed, 0)} changed value(s) in all; ${looks.length} check(s) that only look different. Numbers within ${snap.config?.thresholds?.numericTolerance ?? 0} (relative) of each other count as equal.`,
  ].filter(Boolean).join('\n');
  let body = '', shown = 0;
  for (const { r } of facts) {
    const line = resultLine(r, { locale });
    if (body.length + line.length > maxChars) break;
    body += `${line}\n`;
    shown++;
  }
  if (shown < facts.length) body += `… ${facts.length - shown} more checks omitted (smaller changes than the ones listed)\n`;
  let look = '';
  for (const { r, ev } of looks.slice(0, 60)) look += `#${r.seq} ${r.scenario} | page: ${r.page || '(report)'} | ${clip(r.title, 90)} — ${ev.basis === 'unread' ? 'picture only, values not readable' : ev.basis === 'page' ? 'the page as a whole looks different; its values are in the visual checks of this page' : 'values identical, looks different'}\n`;
  if (looks.length > 60) look += `… ${looks.length - 60} more\n`;
  const overview = overviewText(runId, snap);
  return {
    run,
    results,
    text: `${head}${overview ? `\n\n${clip(overview, 9000)}` : ''}\n\nCHECKS THAT DIFFER IN VALUES, CONTENT OR BEHAVIOUR (#id = result reference; Δ and % are already worked out):\n${body || '(none)'}`
      + `\nCHECKS THAT ONLY LOOK DIFFERENT (their own values match, or are covered by the checks above; cosmetic unless a check above says otherwise):\n${look || '(none)'}`,
  };
}

/** Extracted values per page/visual, for anomaly detection and Q&A. */
export function buildValueDigest(results, maxChars = 22000) {
  const byPage = new Map();
  for (const r of results) {
    if (r.scenario !== 'visual') continue;
    const d = r.details || {};
    const lines = d.sample || d.linesA || d.lines;
    if (!lines?.length || /textbox|shape|image/i.test(d.type || '')) continue;
    if (!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page).push(`  - #${r.seq} ${r.title}: ${lines.slice(0, 18).map((l) => clip(l, 70)).join(' | ')}`);
  }
  let text = '';
  for (const [page, items] of byPage) {
    const block = `Page "${page}":\n${items.join('\n')}\n`;
    if (text.length + block.length > maxChars) { text += '… (truncated)\n'; break; }
    text += block;
  }
  return text || '(no extracted values available)';
}

// ---------------------------------------------------------------- prompts
const SYSTEM = `You are a senior Power BI QA analyst. You review automated end-to-end validation results that compare a baseline report (A) with a candidate report (B), or validate a single report.
Scenarios: report_pages (page inventory), model (semantic model: tables, columns, measures/DAX, relationships, security roles), health (visual errors), page_render (the whole page as a picture; its values are in the visual checks), structure (visual layout/inventory), visual (the values of one visual: the text on screen and, where captured, the unrounded data behind it), button (action buttons/navigators), slicer (applied slicer values), drill (hierarchy drill/expand, several levels), drill_through, matrix_expand, cross_filter (clicking data points), tooltip, selections (a slicer opens on different values in A and B; B was then set to A's values, so the other checks on that page compare the SAME selection and their differences are NOT caused by that slicer), budget (interactions skipped because the run's time limit was reached — coverage gap, not a defect).
Statuses: fail = functional mismatch; missing = exists on one side only; diff = the values differ, or the values match and it only looks different (each check says which); warn = interaction had no visible effect; error = the tool could not execute the step; accepted = an editor marked the difference as intended (do not report it as a problem).
Your audience is the Power BI team (report developers and semantic model owners). They need to know exactly what to look at: which page, which visual or model object, the exact before/after values, and the likely cause.
Work from the VALUES, never from how something looks. Every difference in the input lists the exact before → after values with the difference already worked out (Δ and %): quote those figures as given, and never recalculate, round differently or estimate a number. Judge how serious a difference is by what happened to the values: which measure, how many values, how large the change, and whether rows appeared or disappeared.
A check marked APPEARANCE ONLY has identical values: it is cosmetic (formatting, colour, position), never a change in the numbers. A check marked PICTURE ONLY could not be read: say its numbers are unverified, do not guess. A check marked WHOLE PAGE is explained by the visual checks of that page.
Be precise and evidence-based: cite result references as numbers (the #id) and never state a value that is not in the input.`;

const SUMMARY_SCHEMA = `{
  "actionItems": [{"priority": "P1 | P2 | P3", "title": "what the Power BI team must look into (one line)", "area": "Data model | Defaults | Numbers | Page | Visual | Interaction | Layout | Security", "page": "page name or empty for report/model level", "object": "visual title or model object, e.g. [Total Sales] or Sales[Region]", "whatChanged": "exact before → after from the input (values, DAX, data type, destination page)", "impact": "what report users would see or get wrong", "likelyCause": "most likely cause in the report or model", "action": "concrete thing to check or fix", "owner": "Report developer | Semantic model owner | Data engineering", "resultRefs": [3]}],
  "headline": "one sentence verdict, at most 25 words",
  "risk": "none | low | medium | high | critical",
  "summary": "3-6 sentence executive summary for a release manager",
  "rootCauses": [{"cause": "likely root cause (e.g. dataset refresh, measure/DAX change, filter or RLS change, visual config edit, page/layout edit, broken navigation)", "confidence": "low | medium | high", "evidence": "short evidence", "resultRefs": [1, 2]}],
  "findings": [{"title": "short", "severity": "critical | high | medium | low | info", "category": "data | layout | interaction | appearance | availability", "explanation": "what is wrong and why it matters", "recommendation": "what to check or fix", "resultRefs": [3]}],
  "noise": [{"reason": "what only looks different while its values are identical", "resultRefs": [4]}],
  "nextSteps": ["prioritised action"]
}`;

const ANOMALY_SCHEMA = `{
  "anomalies": [{"page": "page name", "visual": "visual title", "severity": "high | medium | low", "issue": "what looks wrong", "evidence": "the specific values", "resultRefs": [5]}],
  "reconciliation": [{"check": "e.g. card total vs sum of chart bars", "status": "consistent | inconsistent | not-verifiable", "detail": "short"}],
  "assessment": "1-3 sentence overall data-quality assessment"
}`;

const VALUES_SCHEMA = `{
  "changes": [{"resultRef": 12, "whatChanged": "one or two plain sentences on what happened to the values, quoting exact before → after figures from the input", "details": ["one changed value, as given: North: 100,000 → 101,900 (+1.9%)"], "pattern": "one value | same factor | same amount | one direction | rows added | rows removed | blanks | labels | rounding | mixed", "severity": "high | medium | low", "likelyCause": "most likely cause in Power BI terms", "confidence": "low | medium | high"}],
  "links": [{"observation": "the same change seen in several visuals, e.g. a card total and the bars of a chart moving by the same factor", "resultRefs": [12, 15]}],
  "assessment": "2-4 sentences: taken together, do the value changes look like newer data, changed logic, a changed filter, or formatting?"
}`;

// ---------------------------------------------------------------- storage
function startRecord(runId, kind, model, resultId = null) {
  return insert('ai_analyses', { run_id: runId, result_id: resultId, kind, status: 'running', model });
}
function finishRecord(id, { content, error, ms, model }) {
  update('ai_analyses', id, { status: error ? 'error' : 'done', content: content || {}, error: error || null, duration_ms: ms ?? null, ...(model ? { model } : {}) });
}

export function getRunAi(runId) {
  const rows = q.all('SELECT * FROM ai_analyses WHERE run_id = ? ORDER BY id', runId);
  const latest = (kind) => rows.filter((r) => r.kind === kind).at(-1) || null;
  // One explanation per check: the newest, from its values ("explain") or, when
  // screenshots were asked for, from its pictures ("vision").
  const explain = {};
  for (const r of rows.filter((x) => (x.kind === 'explain' || x.kind === 'vision') && x.result_id != null)) explain[r.result_id] = r;
  return {
    status: aiStatus(),
    running: active.has(runId),
    summary: latest('summary'),
    anomalies: latest('anomalies'),
    values: latest('values'),
    explain,
    chat: rows.filter((r) => r.kind === 'chat' && r.status === 'done').map((r) => ({ id: r.id, ...r.content, model: r.model, at: r.created_at })),
  };
}

// --------------------------------------------------------------- features
async function summarise(runId, digest, values) {
  const id = startRecord(runId, 'summary', config.ai.textModel);
  emit(runId, { stage: 'summary', status: 'running' });
  try {
    const messages = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Triage this validation run for the Power BI team. First write "actionItems": the major differences they must look into, at most 10, most important first. Merge checks that share a cause (e.g. one changed measure that moves numbers on several pages is ONE item, citing all its checks). P1 = wrong or changed numbers, missing pages/visuals, model, relationship or security (RLS) changes, broken visuals; P2 = behaviour users notice (navigation, slicers, drill, drill-through); P3 = cosmetic or additive. Leave out noise and accepted items; use only facts present below, quoting exact before → after values. Then group related checks into findings, rank by severity (by the size and number of the value changes), infer root causes, and list under "noise" the checks that only look different (identical values).\n\n${digest}\n\nEXTRACTED VALUES (B side, or A in single mode):\n${clip(values, 8000)}\n\nReply with ONLY one JSON object with exactly these top-level keys: actionItems, headline, risk, summary, rootCauses, findings, noise, nextSteps. Each key holds its own content (do not put the summary or items inside "headline"). Shape:\n${SUMMARY_SCHEMA}` },
    ];
    const r = await chatJson({ model: config.ai.textModel, maxTokens: 8000, messages });
    // Some models squeeze everything into one field: retry once with a reminder.
    const ok = (j) => j && Array.isArray(j.actionItems) && typeof j.summary === 'string' && String(j.headline || '').length < 400;
    if (!ok(r.json)) {
      logger.warn('AI summary had the wrong shape; asking again');
      const again = await chatJson({
        model: config.ai.textModel, maxTokens: 8000,
        messages: [...messages, { role: 'assistant', content: JSON.stringify(r.json).slice(0, 4000) }, { role: 'user', content: 'That JSON has the wrong shape. Reply again with ONE JSON object whose top-level keys are exactly: actionItems (array of objects), headline (one short sentence), risk, summary (string), rootCauses (array), findings (array), noise (array), nextSteps (array). No other text.' }],
      });
      if (ok(again.json) || !ok(r.json)) Object.assign(r, again);
    }
    finishRecord(id, { content: r.json, ms: r.ms, model: r.model });
    emit(runId, { stage: 'summary', status: 'done' });
  } catch (e) {
    finishRecord(id, { error: e.message });
    emit(runId, { stage: 'summary', status: 'error', error: e.message });
    throw e;
  }
}

async function anomalies(runId, digest, values) {
  if (values.startsWith('(no extracted values available)')) return; // nothing to review: don't pay for an empty call
  const id = startRecord(runId, 'anomalies', config.ai.textModel);
  emit(runId, { stage: 'anomalies', status: 'running' });
  try {
    const r = await chatJson({
      model: config.ai.textModel,
      maxTokens: 5000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Act as a data-quality reviewer. Inspect the values shown by each visual and flag anomalies: totals that do not reconcile with their breakdowns, percentages that do not add up, unexpected blanks/zeros/negatives, implausible magnitudes or dates, duplicated categories, and values that changed between A and B by an unusual amount. Only use numbers present below.\n\nVALUES BY PAGE:\n${values}\n\nRUN CONTEXT:\n${clip(digest, 9000)}\n\nReply with ONLY JSON matching:\n${ANOMALY_SCHEMA}` },
      ],
    });
    finishRecord(id, { content: r.json, ms: r.ms, model: r.model });
    emit(runId, { stage: 'anomalies', status: 'done' });
  } catch (e) {
    finishRecord(id, { error: e.message });
    emit(runId, { stage: 'anomalies', status: 'error', error: e.message });
  }
}

/**
 * Explains the value differences visual by visual, in one request: what
 * changed, the pattern across the changed values, the likely cause, and the
 * same change showing up in several visuals. Each visual's part is also kept
 * as that check's explanation.
 */
async function valueReview(runId, run, results) {
  const locale = localeOf(run);
  const items = results
    .filter((r) => PROBLEM.includes(r.status) && basisOf(r) === 'values')
    .map((r) => ({ r, ev: evidenceOf(r, { locale, max: 14 }) }))
    .filter((x) => x.ev.changed)
    .sort((a, b) => (SEV_RANK[a.r.status] - SEV_RANK[b.r.status]) || (b.ev.impact - a.ev.impact) || a.r.seq - b.r.seq);
  if (!items.length || !run.snapshot?.reports?.B) return; // no value differs: nothing to explain
  let text = '';
  const sent = [];
  for (const { r } of items) {
    const block = resultLine(r, { locale, max: 14 });
    if (text.length + block.length > 24000) break;
    text += `${block}\n`;
    sent.push(r);
  }
  const id = startRecord(runId, 'values', config.ai.textModel);
  emit(runId, { stage: 'values', status: 'running' });
  try {
    const out = await chatJson({
      model: config.ai.textModel,
      maxTokens: 7000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Explain the value differences between report A (baseline) and report B (candidate), one entry per check below. For each: say what happened to the values in one or two plain sentences, quoting exact before → after figures; list the most telling changed values in "details" exactly as given; name the pattern across the changed values (the "pattern:" line of the input states what was measured); and give the most likely cause in Power BI terms: newer or different data, changed measure logic (DAX), a changed filter or slicer default, a changed relationship or security rule, rows added to or removed from the source, or formatting and rounding. Use the data model changes and the selections below when they explain a difference, and say so. Then, in "links", name changes that are the same change seen in several visuals. Use only the values below. Do not describe how anything looks.\n\n${clip(overviewText(runId, run.snapshot || {}), 6000)}\n\nCHECKS WITH DIFFERENT VALUES (${sent.length}${sent.length < items.length ? ` of ${items.length}, largest changes first` : ''}):\n${text}\nReply with ONLY JSON matching:\n${VALUES_SCHEMA}` },
      ],
    });
    const bySeq = new Map(sent.map((r) => [r.seq, r]));
    const changes = (Array.isArray(out.json?.changes) ? out.json.changes : []).filter((c) => bySeq.has(Number(c?.resultRef)))
      .map((c) => { const r = bySeq.get(Number(c.resultRef)); return { ...c, resultRef: r.seq, page: r.page || '', visual: r.title }; });
    finishRecord(id, { content: { ...out.json, changes, covered: sent.length, total: items.length }, ms: out.ms, model: out.model });
    for (const c of changes) {
      const r = bySeq.get(c.resultRef);
      const row = startRecord(runId, 'explain', config.ai.textModel, r.id);
      finishRecord(row, { content: { basis: 'values', whatChanged: c.whatChanged, details: c.details || [], pattern: c.pattern, likelyCause: c.likelyCause, severity: c.severity, category: 'data', likelyNoise: false, confidence: c.confidence }, ms: 0, model: out.model });
    }
    emit(runId, { stage: 'values', status: 'done' });
  } catch (e) {
    finishRecord(id, { error: e.message });
    emit(runId, { stage: 'values', status: 'error', error: e.message });
  }
}

const explainInFlight = new Map(); // resultId -> promise (two concurrent requests share one paid call)

/**
 * Explains one check from its values. Returns the finished explanation if one
 * exists already. Screenshots are sent only when the suite asks for it, and
 * only for a check whose values are the same and that just looks different.
 */
export function explainResult(resultId) {
  const done = q.get("SELECT * FROM ai_analyses WHERE result_id = ? AND kind IN ('explain', 'vision') AND status = 'done' ORDER BY id DESC LIMIT 1", resultId);
  if (done) return Promise.resolve(done);
  if (explainInFlight.has(resultId)) return explainInFlight.get(resultId);
  const p = explainResultNow(resultId).finally(() => explainInFlight.delete(resultId));
  explainInFlight.set(resultId, p);
  return p;
}

const stored = (id) => q.get('SELECT * FROM ai_analyses WHERE id = ?', id);

async function explainResultNow(resultId) {
  const r = q.get('SELECT * FROM results WHERE id = ?', resultId);
  if (!r) throw Object.assign(new Error('Result not found'), { status: 404 });
  const run = q.get('SELECT * FROM runs WHERE id = ?', r.run_id);
  const locale = localeOf(run);
  const basis = basisOf(r);
  let facts = resultLine(r, { locale, max: 40 });
  let related = [];
  if (basis === 'page') {
    // A page that looks different is explained by its visuals: their values,
    // and visuals that were added, removed or moved.
    related = q.all("SELECT * FROM results WHERE run_id = ? AND page = ? AND scenario IN ('visual', 'structure', 'selections') ORDER BY seq", r.run_id, r.page)
      .filter((x) => PROBLEM.includes(x.status) && ['values', 'presence', 'structure'].includes(basisOf(x)));
    if (related.length) facts += `\n\nWHAT DIFFERS ON THIS PAGE (its visuals: values, added or removed visuals, layout):\n${clip(related.map((x) => resultLine(x, { locale, max: 10 })).join('\n'), 16000)}`;
  }
  const lookOnly = LOOK_ONLY.has(basis) && !related.length;
  if (lookOnly) {
    const wantsImages = run?.snapshot?.config?.ai?.screenshots === true && config.ai.allowImages && (r.images?.a || r.images?.b);
    if (wantsImages) return explainFromScreenshots(r, basis);
    // Nothing in the values to explain: say so without a paid request.
    const id = startRecord(r.run_id, 'explain', 'no AI request needed', resultId);
    const text = basis === 'appearance' ? 'The values are identical in A and B. Only the look differs: formatting, colour, position or how the visual was drawn.'
      : basis === 'page' ? 'No visual on this page has different values, and none was added, removed or moved. The page only looks different.'
        : 'No values could be read from this item, so only its picture was compared. Whether its numbers changed is not known.';
    finishRecord(id, { content: { basis, whatChanged: text, details: [], severity: basis === 'unread' ? 'low' : 'none', category: 'appearance', likelyNoise: false, confidence: 'high' }, ms: 0 });
    return stored(id);
  }
  const id = startRecord(r.run_id, 'explain', config.ai.textModel, resultId);
  emit(r.run_id, { stage: 'explain', status: 'running', resultId });
  try {
    const out = await chatJson({
      model: config.ai.textModel,
      maxTokens: 2500,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Explain this one check to the Power BI team from its values and facts. Say what changed in one or two plain sentences, quoting exact before → after figures as given; list the most telling changed values in "details" exactly as given; name the pattern across them; and give the most likely cause in Power BI terms (newer or different data, changed measure logic, a changed filter or slicer default, a changed relationship or security rule, rows added or removed, formatting and rounding, a changed page or button). Use only what is below. Do not describe how anything looks.\n\n${facts}\n\nReply with ONLY JSON: {"whatChanged": "one or two sentences", "details": ["one changed value, as given"], "pattern": "one value | same factor | same amount | one direction | rows added | rows removed | blanks | labels | rounding | mixed | not about values", "severity": "high | medium | low | none", "category": "data | layout | interaction | availability | appearance", "likelyCause": "most likely cause", "confidence": "low | medium | high"}` },
      ],
    });
    finishRecord(id, { content: { likelyNoise: false, ...out.json, basis: related.length ? 'values' : basis }, ms: out.ms, model: out.model });
    emit(r.run_id, { stage: 'explain', status: 'done', resultId });
    return stored(id);
  } catch (e) {
    finishRecord(id, { error: e.message });
    emit(r.run_id, { stage: 'explain', status: 'error', resultId, error: e.message });
    throw e;
  }
}

/** Only on request (suite setting): describes a look-only difference from the two screenshots. */
async function explainFromScreenshots(r, basis) {
  const resultId = r.id;
  const dir = runDirOf(r.run_id);
  const im = r.images || {};
  let img, layout;
  if (im.a && im.b) { img = buildComparisonImage(path.join(dir, im.a), path.join(dir, im.b), { diffFile: im.diff ? path.join(dir, im.diff) : null }).png; layout = 'LEFT half = report A (baseline), RIGHT half = report B (candidate), separated by a red vertical bar.'; }
  else { img = singleImage(path.join(dir, im.a || im.b)); layout = `Single screenshot from report ${im.a ? 'A' : 'B'}.`; }

  const id = startRecord(r.run_id, 'vision', config.ai.visionModel, resultId);
  emit(r.run_id, { stage: 'vision', status: 'running', resultId });
  try {
    const out = await chatJson({
      model: config.ai.visionModel,
      maxTokens: 2500,
      messages: [
        { role: 'system', content: 'You are a meticulous visual QA reviewer for Power BI dashboards. Describe concrete, observable differences only.' },
        { role: 'user', content: [
          { type: 'text', text: `${layout}\nCheck: #${r.seq} ${r.scenario} | page: ${r.page || '(report)'} | ${r.title}\n${basis === 'appearance' ? 'The values read from both sides are identical, so do not report a change in the numbers: describe what looks different (formatting, colour, size, position, sort order, legend, axis, missing or extra elements).' : 'No values could be read from this item. Describe what looks different; if a number visibly differs, quote both.'}\nIf the two sides look identical, say so.\nReply with ONLY JSON: {"whatChanged": "one or two sentences", "details": ["specific observable difference"], "severity": "high | medium | low | none", "category": "formatting | layout | data | interaction | noise", "likelyNoise": true/false, "confidence": "low | medium | high"}` },
          imagePart(img),
        ] },
      ],
    });
    finishRecord(id, { content: { basis: 'screenshot', ...out.json }, ms: out.ms, model: out.model });
    emit(r.run_id, { stage: 'vision', status: 'done', resultId });
    return stored(id);
  } catch (e) {
    finishRecord(id, { error: e.message });
    emit(r.run_id, { stage: 'vision', status: 'error', resultId, error: e.message });
    throw e;
  }
}

/** Free-form Q&A grounded in the run's results and extracted values. */
const askDigests = new Map(); // runId -> { key, digest, values }
function askDigest(runId) {
  const run = q.get('SELECT status, finished_at, summary FROM runs WHERE id = ?', runId);
  const agg = q.get("SELECT COUNT(*) AS n, MAX(id) AS maxId, SUM(status = 'accepted') AS acc FROM results WHERE run_id = ?", runId);
  // Changes whenever the run is re-finalised or acceptances are applied/revoked.
  const key = run ? `${run.status}|${run.finished_at}|${agg.n}|${agg.maxId}|${agg.acc}|${JSON.stringify(run.summary?.byStatus || {})}` : null;
  const hit = askDigests.get(runId);
  if (key && hit?.key === key && run.finished_at) return hit;
  const { text: digest, results } = buildRunDigest(runId, 20000);
  const entry = { key, digest, values: buildValueDigest(results, 14000) };
  if (run?.finished_at) {
    if (askDigests.size >= 20) askDigests.delete(askDigests.keys().next().value);
    askDigests.set(runId, entry);
  }
  return entry;
}

export async function askRun(runId, question, history = []) {
  const { digest, values } = askDigest(runId);
  const id = startRecord(runId, 'chat', config.ai.textModel);
  try {
    const msgs = [
      { role: 'system', content: `${SYSTEM}\nAnswer questions about the run below. Use short paragraphs or bullet lists, cite result references like #12, and say clearly when the data needed is not in the run.\n\nRUN RESULTS:\n${digest}\n\nEXTRACTED VALUES:\n${values}` },
      ...history.slice(-8).flatMap((h) => [{ role: 'user', content: clip(h.question, 2000) }, { role: 'assistant', content: clip(h.answer, 4000) }]),
      { role: 'user', content: question },
    ];
    const r = await chat({ model: config.ai.textModel, messages: msgs, maxTokens: 1500, temperature: 0.3 });
    finishRecord(id, { content: { question, answer: r.content }, ms: r.ms, model: r.model });
    return { question, answer: r.content, model: r.model };
  } catch (e) {
    finishRecord(id, { content: { question }, error: e.message });
    throw e;
  }
}

// ---------------------------------------------------------- orchestration
const active = new Set();

/**
 * Full post-run analysis, from the values: summary, anomalies, and the value
 * differences explained visual by visual. Screenshots are looked at only when
 * the suite asks for it, and only for checks whose values are the same.
 */
export async function analyzeRun(runId, { screenshots = false, maxVision = config.ai.maxVisionItems } = {}) {
  if (active.has(runId)) return { started: false, reason: 'Analysis already running' };
  if (!aiStatus().configured) throw Object.assign(new Error('AI is not configured: set NVIDIA_API_KEY'), { status: 503 });
  active.add(runId);
  const t0 = Date.now();
  emit(runId, { stage: 'start', status: 'running' });
  try {
    const { text: digest, results, run } = buildRunDigest(runId);
    const values = buildValueDigest(results);
    await Promise.allSettled([summarise(runId, digest, values), anomalies(runId, digest, values), valueReview(runId, run, results)]);
    if (screenshots && config.ai.allowImages && maxVision > 0) {
      const done = new Set(q.all("SELECT result_id FROM ai_analyses WHERE run_id = ? AND kind = 'vision' AND status = 'done'", runId).map((x) => x.result_id));
      const targets = results
        .filter((r) => r.status === 'diff' && ['appearance', 'unread'].includes(basisOf(r)) && r.images?.a && r.images?.b && !done.has(r.id))
        .sort((a, b) => (b.diff_ratio || 0) - (a.diff_ratio || 0))
        .slice(0, maxVision);
      for (const r of targets) {
        if (!fs.existsSync(path.join(runDirOf(runId), r.images.a))) continue;
        await explainFromScreenshots(r, basisOf(r)).catch((e) => logger.warn(`screenshot review #${r.seq}: ${e.message}`));
      }
    }
    logger.info(`AI analysis of run #${runId} finished in ${Math.round((Date.now() - t0) / 1000)}s`);
    return { started: true };
  } finally {
    active.delete(runId);
    emit(runId, { stage: 'finish', status: 'done' });
  }
}
