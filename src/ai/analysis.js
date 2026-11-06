import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { q, insert, update } from '../db.js';
import { createLogger } from '../logger.js';
import { chat, chatJson, imagePart, aiStatus } from './client.js';
import { buildComparisonImage, singleImage } from './images.js';

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
function resultLine(r) {
  const d = r.details || {};
  const bits = [`#${r.seq} [${r.status.toUpperCase()}] ${r.scenario} | page: ${r.page || '(report)'} | ${r.title}`];
  if (d.note) bits.push(`  note: ${d.note}`);
  if (typeof d.error === 'string') bits.push(`  error: ${clip(d.error.split('\n')[0], 200)}`);
  if (d.missingIn) bits.push(`  missing in report ${d.missingIn}`);
  if (r.diff_ratio != null && r.diff_ratio > 0) bits.push(`  pixels differ: ${(r.diff_ratio * 100).toFixed(3)}%`);
  if (d.outcome) bits.push(`  outcome A: ${JSON.stringify(d.outcome.A)}${d.outcome.B ? ` | B: ${JSON.stringify(d.outcome.B)}` : ''}`);
  if (d.value) bits.push(`  slicer value: ${d.value}`);
  if (d.data && !d.data.equal) {
    const chg = d.data.ops.filter((o) => o.op !== 'eq' && o.op !== 'skip').slice(0, 8)
      .map((o) => (o.op === 'chg' ? `"${clip(o.a, 80)}" → "${clip(o.b, 80)}"` : o.op === 'add' ? `+ "${clip(o.b, 80)}"` : `- "${clip(o.a, 80)}"`));
    bits.push(`  data A→B: ${chg.join('; ')}${d.data.added + d.data.removed > 16 ? ' …' : ''}`);
  }
  if (d.dataDiffs?.length) bits.push(`  visuals with different data afterwards: ${d.dataDiffs.slice(0, 6).map((x) => `${x.visual}${x.only ? ` (only ${x.only})` : ` (+${x.added}/-${x.removed})`}`).join('; ')}`);
  if (d.issues?.length) bits.push(`  layout: ${d.issues.slice(0, 6).map((i) => `${i.kind} ${i.visual}`).join('; ')}`);
  if (d.onlyInA?.length || d.onlyInB?.length || d.renamed?.length) bits.push(`  pages only in A: ${d.onlyInA?.join(', ') || '-'}; only in B: ${d.onlyInB?.join(', ') || '-'}; renamed: ${(d.renamed || []).map((x) => `${x.a}→${x.b}`).join(', ') || '-'}`);
  if (d.errors) {
    const errs = Object.entries(d.errors).flatMap(([s, l]) => l.map((e) => `${s}: ${e.visual} — ${e.error}`));
    if (errs.length) bits.push(`  visual errors: ${errs.slice(0, 5).join('; ')}`);
  }
  return bits.join('\n');
}

export function buildRunDigest(runId, maxChars = 28000) {
  const run = q.get('SELECT * FROM runs WHERE id = ?', runId);
  if (!run) throw Object.assign(new Error('Run not found'), { status: 404 });
  const results = q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId);
  const snap = run.snapshot || {};
  const head = [
    `Suite: ${run.suite_name} (${snap.suite?.mode === 'single' ? 'single-report validation' : 'comparison A ⇄ B'})`,
    `Report A (baseline): ${snap.reports?.A?.name || '?'}${snap.reports?.A?.environment ? ` [${snap.reports.A.environment}]` : ''}`,
    snap.reports?.B ? `Report B (candidate): ${snap.reports.B.name}${snap.reports.B.environment ? ` [${snap.reports.B.environment}]` : ''}` : null,
    `Run status: ${run.status}${run.error ? ` (error: ${run.error})` : ''}; ${results.length} checks; by status: ${JSON.stringify(run.summary?.byStatus || {})}`,
    `Checks by scenario: ${Object.entries(run.summary?.byScenario || {}).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join('; ')}`,
    `Thresholds: max differing pixels ${((snap.config?.thresholds?.maxDiffRatio ?? 0.002) * 100).toFixed(2)}%, numeric tolerance ${snap.config?.thresholds?.numericTolerance ?? 0}`,
  ].filter(Boolean).join('\n');
  const problems = results.filter((r) => PROBLEM.includes(r.status)).sort((a, b) => (SEV_RANK[a.status] - SEV_RANK[b.status]) || a.seq - b.seq);
  let body = '';
  for (const r of problems) {
    const line = resultLine(r);
    if (body.length + line.length > maxChars) { body += `\n… ${problems.length - body.split('\n#').length} more problem results omitted`; break; }
    body += `${line}\n`;
  }
  return { run, results, text: `${head}\n\nNON-PASSING CHECKS (#id = result reference):\n${body || '(none — every check passed)'}` };
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
Scenarios: report_pages (page inventory), health (visual errors), page_render (full-page screenshot diff), structure (visual layout/inventory), visual (per-visual screenshot + extracted data), button (action buttons/navigators), slicer (applied slicer values), drill (hierarchy drill/expand), matrix_expand, cross_filter (clicking data points), tooltip.
Statuses: fail = functional mismatch; missing = exists on one side only; diff = visual or data difference; warn = interaction had no visible effect; error = the tool could not execute the step.
Be precise and evidence-based: cite result references as numbers (the #id), never invent values that are not in the input, and distinguish real regressions from rendering noise (sub-pixel shifts, anti-aliasing, animation).`;

const SUMMARY_SCHEMA = `{
  "headline": "one sentence verdict",
  "risk": "none | low | medium | high | critical",
  "summary": "3-6 sentence executive summary for a release manager",
  "rootCauses": [{"cause": "likely root cause (e.g. dataset refresh, measure/DAX change, filter or RLS change, visual config edit, page/layout edit, broken navigation)", "confidence": "low | medium | high", "evidence": "short evidence", "resultRefs": [1, 2]}],
  "findings": [{"title": "short", "severity": "critical | high | medium | low | info", "category": "data | layout | interaction | rendering | availability | noise", "explanation": "what is wrong and why it matters", "recommendation": "what to check or fix", "resultRefs": [3]}],
  "noise": [{"reason": "why these look like rendering noise / acceptable", "resultRefs": [4]}],
  "nextSteps": ["prioritised action"]
}`;

const ANOMALY_SCHEMA = `{
  "anomalies": [{"page": "page name", "visual": "visual title", "severity": "high | medium | low", "issue": "what looks wrong", "evidence": "the specific values", "resultRefs": [5]}],
  "reconciliation": [{"check": "e.g. card total vs sum of chart bars", "status": "consistent | inconsistent | not-verifiable", "detail": "short"}],
  "assessment": "1-3 sentence overall data-quality assessment"
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
  const vision = {};
  for (const r of rows.filter((x) => x.kind === 'vision')) vision[r.result_id] = r;
  return {
    status: aiStatus(),
    running: active.has(runId),
    summary: latest('summary'),
    anomalies: latest('anomalies'),
    vision,
    chat: rows.filter((r) => r.kind === 'chat' && r.status === 'done').map((r) => ({ id: r.id, ...r.content, model: r.model, at: r.created_at })),
  };
}

// --------------------------------------------------------------- features
async function summarise(runId, digest, values) {
  const id = startRecord(runId, 'summary', config.ai.textModel);
  emit(runId, { stage: 'summary', status: 'running' });
  try {
    const r = await chatJson({
      model: config.ai.textModel,
      maxTokens: 3000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Triage this validation run. Group related checks into findings, rank by severity, infer root causes, and mark checks that look like noise.\n\n${digest}\n\nEXTRACTED VALUES (B side, or A in single mode):\n${clip(values, 8000)}\n\nReply with ONLY JSON matching:\n${SUMMARY_SCHEMA}` },
      ],
    });
    finishRecord(id, { content: r.json, ms: r.ms, model: r.model });
    emit(runId, { stage: 'summary', status: 'done' });
  } catch (e) {
    finishRecord(id, { error: e.message });
    emit(runId, { stage: 'summary', status: 'error', error: e.message });
    throw e;
  }
}

async function anomalies(runId, digest, values) {
  const id = startRecord(runId, 'anomalies', config.ai.textModel);
  emit(runId, { stage: 'anomalies', status: 'running' });
  try {
    const r = await chatJson({
      model: config.ai.textModel,
      maxTokens: 2500,
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

/** Vision explanation of one result's screenshots. */
export async function explainResult(resultId) {
  const r = q.get('SELECT * FROM results WHERE id = ?', resultId);
  if (!r) throw Object.assign(new Error('Result not found'), { status: 404 });
  if (!config.ai.allowImages) throw Object.assign(new Error('Sending screenshots to the AI is disabled (AI_ALLOW_IMAGES=false)'), { status: 403 });
  const dir = runDirOf(r.run_id);
  const im = r.images || {};
  let img, layout;
  if (im.a && im.b) { img = buildComparisonImage(path.join(dir, im.a), path.join(dir, im.b)).png; layout = 'LEFT half = report A (baseline), RIGHT half = report B (candidate), separated by a red vertical bar.'; }
  else if (im.a || im.b) { img = singleImage(path.join(dir, im.a || im.b)); layout = `Single screenshot from report ${im.a ? 'A' : 'B'}.`; }
  else throw Object.assign(new Error('This result has no screenshots'), { status: 400 });

  const id = startRecord(r.run_id, 'vision', config.ai.visionModel, resultId);
  emit(r.run_id, { stage: 'vision', status: 'running', resultId });
  try {
    const out = await chatJson({
      model: config.ai.visionModel,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: 'You are a meticulous visual QA reviewer for Power BI dashboards. Describe concrete, observable differences only.' },
        { role: 'user', content: [
          { type: 'text', text: `${layout}\nCheck: ${resultLine(r)}\n\nCompare the two sides carefully: numbers, labels, bar/line heights, colours, legend, axis ranges, sort order, titles, missing or extra elements, highlighted/filtered state. If they look identical, say so and treat any pixel difference as rendering noise.\nReply with ONLY JSON: {"whatChanged": "one or two sentences", "details": ["specific observable difference"], "severity": "high | medium | low | none", "category": "data | layout | formatting | interaction | noise", "likelyNoise": true/false, "confidence": "low | medium | high"}` },
          imagePart(img),
        ] },
      ],
    });
    finishRecord(id, { content: out.json, ms: out.ms, model: out.model });
    emit(r.run_id, { stage: 'vision', status: 'done', resultId });
    return getRunAi(r.run_id).vision[resultId];
  } catch (e) {
    finishRecord(id, { error: e.message });
    emit(r.run_id, { stage: 'vision', status: 'error', resultId, error: e.message });
    throw e;
  }
}

/** Free-form Q&A grounded in the run's results and extracted values. */
export async function askRun(runId, question, history = []) {
  const { text: digest, results } = buildRunDigest(runId, 20000);
  const values = buildValueDigest(results, 14000);
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

/** Full post-run analysis: summary + anomalies + vision on the top problems. */
export async function analyzeRun(runId, { vision = true, maxVision = config.ai.maxVisionItems } = {}) {
  if (active.has(runId)) return { started: false, reason: 'Analysis already running' };
  if (!aiStatus().configured) throw Object.assign(new Error('AI is not configured: set NVIDIA_API_KEY'), { status: 503 });
  active.add(runId);
  const t0 = Date.now();
  emit(runId, { stage: 'start', status: 'running' });
  try {
    const { text: digest, results } = buildRunDigest(runId);
    const values = buildValueDigest(results);
    await Promise.allSettled([summarise(runId, digest, values), anomalies(runId, digest, values)]);
    if (vision && config.ai.allowImages && maxVision > 0) {
      const done = new Set(q.all("SELECT result_id FROM ai_analyses WHERE run_id = ? AND kind = 'vision' AND status = 'done'", runId).map((x) => x.result_id));
      const targets = results
        .filter((r) => ['fail', 'diff', 'missing'].includes(r.status) && r.images?.a && r.images?.b && !done.has(r.id))
        .sort((a, b) => (SEV_RANK[a.status] - SEV_RANK[b.status]) || (b.diff_ratio || 0) - (a.diff_ratio || 0))
        .slice(0, maxVision);
      for (const r of targets) {
        if (!fs.existsSync(path.join(runDirOf(runId), r.images.a))) continue;
        await explainResult(r.id).catch((e) => logger.warn(`vision #${r.seq}: ${e.message}`));
      }
    }
    logger.info(`AI analysis of run #${runId} finished in ${Math.round((Date.now() - t0) / 1000)}s`);
    return { started: true };
  } finally {
    active.delete(runId);
    emit(runId, { stage: 'finish', status: 'done' });
  }
}
