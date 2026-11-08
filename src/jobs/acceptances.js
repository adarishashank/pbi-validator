import crypto from 'node:crypto';
import { q, insert, update, nowIso } from '../db.js';

// "Accept as expected": an editor marks a difference as intended. Later runs
// of the same suite that produce the same check with the same difference get
// the status "accepted" instead of being reported as a problem.
//
//   scope "exact": accepted only while the difference stays the same (same
//                  status, same changed values / behaviour / missing items);
//                  if the data or behaviour changes again, it is flagged again.
//   scope "any":   any difference in this check is accepted (for visuals whose
//                  content legitimately changes every time).

export const ACCEPTABLE = new Set(['diff', 'fail', 'missing', 'warn']);

/** Identifies the same check across runs of a suite. */
export const matchKey = (r) => `${r.scenario}|${r.page || ''}|${r.target || r.title}`;

const ops = (list) => (list || []).filter((o) => o.op !== 'skip').map((o) => [o.op, o.a ?? null, o.b ?? null]);
// Percentages and pixel counts vary from run to run even when nothing meaningful changed.
const stableNote = (s) => String(s || '').replace(/\d+(?:[.,]\d+)?\s*(?:%|px\b)/g, '#');

/** Fingerprint of *what* differs, ignoring noise such as exact pixel percentages. */
export function fingerprint(r) {
  const d = r.details || {};
  const parts = { status: r.status };
  if (d.data && !d.data.equal) parts.data = ops(d.data.ops);
  if (d.dataDiffs?.length) parts.dataDiffs = d.dataDiffs.map((x) => [x.visual, x.only || null, ops(x.ops)]);
  if (d.issues?.length) parts.issues = d.issues.map((i) => `${i.kind}:${i.visual}`).sort();
  if (d.missingIn) parts.missingIn = d.missingIn;
  if (d.outcome) {
    parts.outcome = ['A', 'B'].map((s) => (d.outcome[s] ? { page: d.outcome[s].page ?? null, navigated: !!d.outcome[s].navigated, popups: d.outcome[s].popups || [] } : null));
  }
  if (d.onlyInA || d.onlyInB || d.renamed) parts.pages = { a: d.onlyInA || [], b: d.onlyInB || [], renamed: d.renamed || [], order: !!d.orderChanged };
  if (d.errors) parts.errors = Object.entries(d.errors).map(([side, list]) => [side, (list || []).map((e) => `${e.visual}:${e.error}`).sort()]);
  if (d.note && !parts.data && !parts.outcome && !parts.dataDiffs) parts.note = stableNote(d.note);
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

export const loadAcceptances = (suiteId) => (suiteId ? q.all('SELECT * FROM acceptances WHERE suite_id = ?', suiteId) : []);

/**
 * Applies acceptances to a result row about to be stored. Mutates and returns
 * the row: status "accepted" with details.accepted describing why.
 */
export function applyAcceptances(rules, row) {
  if (!rules.length || !ACCEPTABLE.has(row.status)) return row;
  const key = matchKey(row);
  const candidates = rules.filter((a) => a.match_key === key);
  if (!candidates.length) return row;
  const fp = fingerprint(row);
  const rule = candidates.find((a) => a.scope === 'exact' && a.fingerprint === fp) || candidates.find((a) => a.scope === 'any');
  if (!rule) return row;
  row.details = { ...(row.details || {}), accepted: describe(rule, row.status) };
  row.status = 'accepted';
  q.run('UPDATE acceptances SET last_matched_at = ?, match_count = match_count + 1 WHERE id = ?', nowIso(), rule.id);
  return row;
}

const describe = (rule, originalStatus) => ({
  id: rule.id, scope: rule.scope, by: rule.created_by, at: rule.created_at, note: rule.note, originalStatus,
});

const STATUS_RANK = (byStatus) => {
  if ((byStatus.fail || 0) + (byStatus.missing || 0) + (byStatus.error || 0) > 0) return 'failed';
  if (byStatus.diff) return 'diffs';
  return 'passed';
};

/** Recounts a finished run after results were accepted or un-accepted. */
export function recomputeRun(runId) {
  const run = q.get('SELECT * FROM runs WHERE id = ?', runId);
  if (!run) return null;
  const results = q.all('SELECT scenario, status FROM results WHERE run_id = ?', runId);
  const byStatus = {}, byScenario = {};
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byScenario[r.scenario] ??= {};
    byScenario[r.scenario][r.status] = (byScenario[r.scenario][r.status] || 0) + 1;
  }
  const summary = { ...(run.summary || {}), total: results.length, byStatus, byScenario };
  const status = ['passed', 'diffs', 'failed'].includes(run.status) ? STATUS_RANK(byStatus) : run.status;
  update('runs', runId, { summary, status });
  return { status, summary };
}

/**
 * Accepts the difference in one result. Creates the rule for the run's suite,
 * marks matching problem results in the same run as accepted, and recounts it.
 */
export function acceptResult(resultId, { scope = 'exact', note = '', user = null } = {}) {
  const r = q.get('SELECT * FROM results WHERE id = ?', resultId);
  if (!r) throw Object.assign(new Error('Result not found'), { status: 404 });
  const run = q.get('SELECT id, suite_id, status FROM runs WHERE id = ?', r.run_id);
  if (['queued', 'running'].includes(run.status)) throw Object.assign(new Error('Wait for the run to finish before accepting differences'), { status: 409 });
  if (!run.suite_id) throw Object.assign(new Error('The suite of this run was deleted, so the acceptance could not be remembered'), { status: 409 });
  if (!ACCEPTABLE.has(r.status)) throw Object.assign(new Error(r.status === 'accepted' ? 'Already accepted' : `A "${r.status}" result can't be accepted`), { status: 400 });
  const key = matchKey(r), fp = scope === 'exact' ? fingerprint(r) : '';
  const existing = q.get('SELECT * FROM acceptances WHERE suite_id = ? AND match_key = ? AND scope = ? AND fingerprint = ?', run.suite_id, key, scope, fp);
  const id = existing?.id ?? insert('acceptances', {
    suite_id: run.suite_id, match_key: key, scope, fingerprint: fp, original_status: r.status,
    title: r.title, page: r.page, scenario: r.scenario, note: String(note || '').slice(0, 500),
    created_by: user, created_at: nowIso(), from_run_id: run.id,
  });
  const rule = q.get('SELECT * FROM acceptances WHERE id = ?', id);
  // Same run: this result and any other result for the same check.
  let changed = 0;
  for (const other of q.all('SELECT * FROM results WHERE run_id = ?', run.id)) {
    if (!ACCEPTABLE.has(other.status) || matchKey(other) !== key) continue;
    if (scope === 'exact' && fingerprint(other) !== fp) continue;
    update('results', other.id, { status: 'accepted', details: { ...(other.details || {}), accepted: describe(rule, other.status) } });
    changed++;
  }
  q.run('UPDATE acceptances SET last_matched_at = ?, match_count = match_count + ? WHERE id = ?', nowIso(), changed, id);
  return { acceptance: q.get('SELECT * FROM acceptances WHERE id = ?', id), run: recomputeRun(run.id), changed };
}

/** Removes an acceptance; results it accepted (in any run) are flagged again. */
export function revokeAcceptance(acceptanceId) {
  const rule = q.get('SELECT * FROM acceptances WHERE id = ?', acceptanceId);
  if (!rule) throw Object.assign(new Error('Acceptance not found'), { status: 404 });
  const runs = new Set();
  for (const r of q.all("SELECT r.* FROM results r JOIN runs u ON u.id = r.run_id WHERE u.suite_id = ? AND r.status = 'accepted'", rule.suite_id)) {
    if (r.details?.accepted?.id !== rule.id) continue;
    const { accepted, ...rest } = r.details;
    update('results', r.id, { status: accepted.originalStatus || rule.original_status, details: rest });
    runs.add(r.run_id);
  }
  q.run('DELETE FROM acceptances WHERE id = ?', rule.id);
  for (const runId of runs) recomputeRun(runId);
  return { rule, runsUpdated: runs.size };
}
