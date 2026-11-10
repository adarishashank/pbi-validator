/** Front-end support: results delta (?after=), limit clamping, suites list, cache headers. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-front-'));
Object.assign(process.env, { DATA_DIR: tmp, LOG_LEVEL: 'error', API_TOKEN: 'front-token-0123456789', NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false' });

let db, server, base, runId, suiteA, suiteB;
before(async () => {
  db = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const a = db.insert('reports', { name: 'A', url: 'https://example.com/a' });
  const b = db.insert('reports', { name: 'B', url: 'https://example.com/b' });
  suiteA = db.insert('suites', { name: 'S1', mode: 'compare', report_a_id: a, report_b_id: b });
  suiteB = db.insert('suites', { name: 'S2', mode: 'compare', report_a_id: a, report_b_id: b });
  db.insert('suites', { name: 'S3-never-run', mode: 'compare', report_a_id: a, report_b_id: b });
  const mk = (suite, name, status) => db.insert('runs', { suite_id: suite, suite_name: name, status, progress: 1, summary: { total: 1 } });
  mk(suiteA, 'S1', 'passed');
  runId = mk(suiteA, 'S1', 'failed');
  mk(suiteB, 'S2', 'running');
  for (let seq = 1; seq <= 5; seq++) db.insert('results', { run_id: runId, seq, scenario: 'visual', title: `r${seq}`, status: 'pass' });
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = (p) => fetch(base + p, { headers: { Authorization: 'Bearer front-token-0123456789' } });

test('results ?after= returns only newer rows, in seq order; no param returns all', async () => {
  const all = await (await get(`/api/runs/${runId}/results`)).json();
  assert.deepEqual(all.map((r) => r.seq), [1, 2, 3, 4, 5]);
  const delta = await (await get(`/api/runs/${runId}/results?after=3`)).json();
  assert.deepEqual(delta.map((r) => r.seq), [4, 5]);
  assert.deepEqual(Object.keys(delta[0]), Object.keys(all[0]), 'same row shape');
  assert.deepEqual(await (await get(`/api/runs/${runId}/results?after=5`)).json(), []);
  assert.equal((await (await get(`/api/runs/${runId}/results?after=0`)).json()).length, 5);
  assert.equal((await (await get(`/api/runs/${runId}/results?after=junk`)).json()).length, 5, 'unparseable after is ignored');
});

test('limit query params are clamped to at least 1', async () => {
  assert.equal((await (await get('/api/runs?limit=-1')).json()).length, 1, 'negative limit is not "no limit"');
  assert.equal((await (await get('/api/runs?limit=0')).json()).length, 3, '0 falls back to the default');
  assert.equal((await (await get('/api/runs?limit=2')).json()).length, 2);
  assert.equal((await (await get('/api/trend?limit=-5')).json()).runs.length, 1);
  assert.equal((await (await get(`/api/suites/${suiteA}/trend?limit=-5`)).json()).runs.length, 1);
});

test('suites list carries each suite\'s latest run (grouped query)', async () => {
  const list = await (await get('/api/suites')).json();
  const by = Object.fromEntries(list.map((s) => [s.name, s]));
  assert.equal(by.S1.last_run.status, 'failed');
  assert.equal(by.S1.last_run.id, runId);
  assert.equal(by.S2.last_run.status, 'running');
  assert.equal(by['S3-never-run'].last_run, null);
  assert.deepEqual(Object.keys(by.S1.last_run).sort(), ['finished_at', 'id', 'progress', 'status', 'summary']);
  assert.deepEqual(by.S1.last_run, (await (await get(`/api/suites/${suiteA}`)).json()).last_run, 'same as the single-suite endpoint');
});

test('app shell is served with no-cache', async () => {
  for (const p of ['/', '/js/app.js', '/some/spa/route']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('cache-control'), 'no-cache', p);
  }
});
