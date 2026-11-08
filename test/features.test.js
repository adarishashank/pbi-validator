/**
 * Schedules (due-time scheduler with catch-up and time zones), "accept as
 * expected" (fingerprints, acceptance rules, undo, run recount) and trend data.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-feat-'));
Object.assign(process.env, {
  DATA_DIR: tmp, LOG_LEVEL: 'error', TIMEZONE: 'Asia/Kolkata', API_TOKEN: 'feat-token-0123456789',
  NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false',
});

let db, sched, acc, queue, server, base;
const enqueued = [];
before(async () => {
  db = await import('../src/db.js');
  sched = await import('../src/jobs/scheduler.js');
  acc = await import('../src/jobs/acceptances.js');
  queue = await import('../src/jobs/queue.js');
  // Don't launch browsers here: record what the scheduler would start.
  queue.runQueue.enqueue = (suiteId, trigger) => { enqueued.push({ suiteId, trigger }); return 1000 + enqueued.length; };
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const api = (p, opts = {}) => fetch(base + p, { ...opts, headers: { Authorization: 'Bearer feat-token-0123456789', 'Content-Type': 'application/json', ...(opts.headers || {}) } })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

let suiteId;
test('schedules use the configured time zone', () => {
  // 06:00 in India is 00:30 UTC.
  const next = sched.nextAfter('0 6 * * *', new Date('2026-11-08T12:00:00Z'));
  assert.equal(next, '2026-11-09T00:30:00.000Z');
  assert.throws(() => sched.validateCron('not a cron'), /Invalid cron/);
});

test('new and edited schedules get a due time; the API exposes the next one', async () => {
  const a = db.insert('reports', { name: 'A', url: 'https://example.com/a' });
  const b = db.insert('reports', { name: 'B', url: 'https://example.com/b' });
  let r = await api('/api/suites', { method: 'POST', body: JSON.stringify({ name: 'Nightly', mode: 'compare', report_a_id: a, report_b_id: b, schedule: '30 7 * * *' }) });
  assert.equal(r.status, 201);
  suiteId = r.json.id;
  assert.ok(r.json.next_run, 'next run computed');
  assert.equal(new Date(r.json.next_run).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }), '07:30');
  r = await api('/api/schedules/next');
  assert.equal(r.json.next, db.q.get('SELECT next_scheduled_at n FROM suites WHERE id = ?', suiteId).n);
  assert.equal(r.json.timezone, 'Asia/Kolkata');
  // Changing the schedule recomputes; clearing it removes the due time.
  r = await api(`/api/suites/${suiteId}`, { method: 'PUT', body: JSON.stringify({ name: 'Nightly', mode: 'compare', report_a_id: a, report_b_id: b, schedule: '0 22 * * 1-5' }) });
  assert.equal(new Date(r.json.next_run).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }), '22:00');
  const viewerless = await fetch(`${base}/api/schedules/next`);
  assert.equal(viewerless.status, 401, 'requires sign-in or the API token');
});

test('a run missed while asleep is caught up once; very old ones are skipped', () => {
  const set = (iso) => db.q.run('UPDATE suites SET next_scheduled_at = ? WHERE id = ?', iso, suiteId);
  const now = new Date();
  set(new Date(now - 2 * 3600e3).toISOString()); // due 2 h ago (app was asleep)
  enqueued.length = 0;
  let queued = sched.runDueSchedules(now);
  assert.equal(queued.length, 1, 'caught up once');
  assert.deepEqual(enqueued, [{ suiteId, trigger: 'schedule' }]);
  const next = db.q.get('SELECT next_scheduled_at n FROM suites WHERE id = ?', suiteId).n;
  assert.ok(Date.parse(next) > now.getTime(), 'advanced to the next future occurrence');
  assert.equal(sched.runDueSchedules(now).length, 0, 'not started twice');

  set(new Date(now - 30 * 3600e3).toISOString()); // due 30 h ago: older than the 24 h catch-up window
  enqueued.length = 0;
  queued = sched.runDueSchedules(now);
  assert.equal(queued.length, 0);
  assert.ok(Date.parse(db.q.get('SELECT next_scheduled_at n FROM suites WHERE id = ?', suiteId).n) > now.getTime(), 'skipped but advanced');

  // A suite with an active run is skipped (and advanced).
  set(new Date(now - 60e3).toISOString());
  const runId = db.insert('runs', { suite_id: suiteId, suite_name: 'Nightly', trigger: 'manual', status: 'running', queued_at: now.toISOString() });
  enqueued.length = 0;
  assert.equal(sched.runDueSchedules(now).length, 0);
  db.q.run('DELETE FROM runs WHERE id = ?', runId);
});

// ------------------------------------------------------------- acceptances
let runId;
const now = () => new Date().toISOString();
function makeRun(rows, status = 'failed') {
  const id = db.insert('runs', { suite_id: suiteId, suite_name: 'Nightly', trigger: 'manual', status, queued_at: now(), started_at: now(), finished_at: now(), summary: JSON.stringify({ durationMs: 60000 }) });
  rows.forEach((r, i) => db.insert('results', { run_id: id, seq: i + 1, page: r.page || 'Overview', scenario: r.scenario, target: r.target, title: r.title, status: r.status, details: JSON.stringify(r.details || {}), images: '{}', created_at: now() }));
  acc.recomputeRun(id);
  return id;
}
const kpi = (b, status = 'diff') => ({ page: 'Overview', scenario: 'visual', target: 'card|New KPI', title: 'Card · New KPI', status, details: { data: { equal: false, added: 1, removed: 1, ops: [{ op: 'chg', a: '40', b }] } } });
const button = { page: 'Overview', scenario: 'button', target: 'btn|Go', title: 'Click button · Go', status: 'fail', details: { note: 'Button behaviour differs: 0.44% px', outcome: { A: { page: 'Details', navigated: true }, B: { page: 'Trend Analysis', navigated: true } } } };
const ok = { scenario: 'visual', target: 'card|Sales', title: 'Card · Sales', status: 'pass' };

test('fingerprints ignore pixel noise but see real changes', () => {
  assert.equal(acc.fingerprint(kpi('42')), acc.fingerprint(kpi('42')));
  assert.notEqual(acc.fingerprint(kpi('42')), acc.fingerprint(kpi('43')), 'different value → different difference');
  assert.notEqual(acc.fingerprint(kpi('42')), acc.fingerprint(kpi('42', 'fail')), 'status is part of it');
  const b2 = { ...button, details: { ...button.details, note: 'Button behaviour differs: 0.71% px' } };
  assert.equal(acc.fingerprint(button), acc.fingerprint(b2), 'pixel percentage is noise');
});

test('accepting a difference recounts the run; later runs match it until it changes', async () => {
  runId = makeRun([kpi('42'), button, ok]);
  assert.equal(db.q.get('SELECT status FROM runs WHERE id = ?', runId).status, 'failed');
  const results = db.q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId);

  let r = await api(`/api/results/${results[1].id}/accept`, { method: 'POST', body: JSON.stringify({ scope: 'exact', note: 'Navigation changed on purpose' }) });
  assert.equal(r.status, 201);
  assert.equal(r.json.run.status, 'diffs', 'fail accepted → only a diff left');
  r = await api(`/api/results/${results[0].id}/accept`, { method: 'POST', body: JSON.stringify({ scope: 'exact', note: 'New KPI in 4.2' }) });
  assert.equal(r.json.run.status, 'passed');
  assert.equal(r.json.run.summary.byStatus.accepted, 2);
  const kpiRow = db.q.get('SELECT * FROM results WHERE id = ?', results[0].id);
  assert.equal(kpiRow.status, 'accepted');
  assert.equal(kpiRow.details.accepted.originalStatus, 'diff');
  assert.equal(kpiRow.details.accepted.note, 'New KPI in 4.2');
  assert.equal((await api(`/api/results/${results[0].id}/accept`, { method: 'POST', body: '{}' })).status, 400, 'already accepted');
  assert.equal((await api(`/api/results/${results[2].id}/accept`, { method: 'POST', body: '{}' })).status, 400, 'a pass cannot be accepted');

  // The next run: same differences → accepted at record time; a changed value → flagged again.
  const rules = acc.loadAcceptances(suiteId);
  assert.equal(rules.length, 2);
  const same = acc.applyAcceptances(rules, { ...kpi('42'), details: structuredClone(kpi('42').details) });
  assert.equal(same.status, 'accepted');
  const changed = acc.applyAcceptances(rules, { ...kpi('43'), details: structuredClone(kpi('43').details) });
  assert.equal(changed.status, 'diff', 'value changed again → flagged');
  const noisyButton = acc.applyAcceptances(rules, { ...button, details: { ...button.details, note: 'Button behaviour differs: 0.9% px' } });
  assert.equal(noisyButton.status, 'accepted');
  assert.equal(db.q.get('SELECT match_count n FROM acceptances WHERE title = ?', 'Card · New KPI').n, 2);
});

test('"any difference" scope and undo', async () => {
  const run2 = makeRun([kpi('77'), ok]);
  const row = db.q.get("SELECT * FROM results WHERE run_id = ? AND status = 'diff'", run2);
  const r = await api(`/api/results/${row.id}/accept`, { method: 'POST', body: JSON.stringify({ scope: 'any' }) });
  assert.equal(r.json.acceptance.scope, 'any');
  const rules = acc.loadAcceptances(suiteId);
  assert.equal(acc.applyAcceptances(rules, { ...kpi('999'), details: structuredClone(kpi('999').details) }).status, 'accepted', 'any value accepted');

  const list = (await api(`/api/suites/${suiteId}/acceptances`)).json;
  assert.equal(list.length, 3);
  const del = await api(`/api/acceptances/${r.json.acceptance.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.json.runsUpdated, 1);
  assert.equal(db.q.get('SELECT status FROM results WHERE id = ?', row.id).status, 'diff', 'flagged again');
  assert.equal(db.q.get('SELECT status FROM runs WHERE id = ?', run2).status, 'diffs');
  const audit = db.q.all("SELECT action FROM audit_log WHERE action IN ('result.accept','acceptance.revoke')").map((a) => a.action);
  assert.ok(audit.includes('result.accept') && audit.includes('acceptance.revoke'));
});

test('trend data per suite and overall, oldest first', async () => {
  const r = await api(`/api/suites/${suiteId}/trend?limit=10`);
  assert.equal(r.status, 200);
  assert.equal(r.json.suite.name, 'Nightly');
  const ids = r.json.runs.map((x) => x.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  const first = r.json.runs.find((x) => x.id === runId);
  assert.equal(first.status, 'passed');
  assert.equal(first.byStatus.accepted, 2);
  assert.equal(first.total, 3);
  const all = await api('/api/trend?limit=5');
  assert.ok(all.json.runs.length >= 2);
});
