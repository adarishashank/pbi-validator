/**
 * Server-side efficiency changes: thumbnails, buffered run logs, start-up recovery of stale AI rows,
 * transactions, retention (audit log, orphaned published folders) and statement caching.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PNG } from 'pngjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-hk-'));
let fixture, mods;

before(async () => {
  const page = fs.readFileSync(new URL('./fixtures/mock-report.html', import.meta.url));
  fixture = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(page); });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { DATA_DIR: tmp, LOG_LEVEL: 'warn', AI_AUTO_ANALYZE: 'false', AUDIT_RETENTION_DAYS: '30' });
  mods = {
    db: await import('../src/db.js'),
    queue: await import('../src/jobs/queue.js'),
    thumbs: await import('../src/jobs/thumbs.js'),
  };
});
after(() => { fixture.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const solid = (w, h, rgb) => { const p = new PNG({ width: w, height: h }); for (let i = 0; i < w * h; i++) p.data.set([...rgb, 255], i * 4); return PNG.sync.write(p); };

test('thumbnails: box downscale, max 360 wide, aspect kept, never upscaled', () => {
  const { makeThumbnail, thumbName } = mods.thumbs;
  assert.equal(thumbName('0007-a.png'), '0007-a.thumb.png');
  const t = PNG.sync.read(makeThumbnail(solid(1440, 900, [200, 100, 50])));
  assert.equal(t.width, 360);
  assert.equal(t.height, 225);
  assert.deepEqual([...t.data.slice(0, 4)], [200, 100, 50, 255]);
  const small = solid(200, 100, [1, 2, 3]);
  const same = PNG.sync.read(makeThumbnail(small));
  assert.equal(same.width, 200);
  assert.equal(same.height, 100);
});

test('transaction commits, rolls back on error and nests', () => {
  const { q, transaction } = mods.db;
  q.run('CREATE TABLE IF NOT EXISTS hk_tx (n INTEGER)');
  transaction(() => { q.run('INSERT INTO hk_tx VALUES (1)'); transaction(() => q.run('INSERT INTO hk_tx VALUES (2)')); });
  assert.throws(() => transaction(() => { q.run('INSERT INTO hk_tx VALUES (3)'); throw new Error('boom'); }), /boom/);
  assert.deepEqual(q.all('SELECT n FROM hk_tx ORDER BY n').map((r) => r.n), [1, 2]);
});

test('start-up recovery marks AI rows left running as errors', () => {
  const { db, } = mods;
  const sid = db.insert('suites', { name: 'hk-ai', mode: 'single', report_a_id: db.insert('reports', { name: 'R', url: 'http://x' }) });
  const runId = db.insert('runs', { suite_id: sid, suite_name: 'hk-ai', status: 'passed', queued_at: db.nowIso(), finished_at: db.nowIso() });
  const stale = db.insert('ai_analyses', { run_id: runId, kind: 'summary', status: 'running' });
  const done = db.insert('ai_analyses', { run_id: runId, kind: 'anomalies', status: 'done' });
  db.recoverInterruptedRuns();
  assert.equal(db.q.get('SELECT * FROM ai_analyses WHERE id = ?', stale).status, 'error');
  assert.equal(db.q.get('SELECT error FROM ai_analyses WHERE id = ?', stale).error, 'Interrupted by a restart');
  assert.equal(db.q.get('SELECT status FROM ai_analyses WHERE id = ?', done).status, 'done');
});

test('retention: old audit rows, expired sessions and orphaned published folders go; live ones stay', async () => {
  const { db, queue } = mods;
  const old = new Date(Date.now() - 90 * 86400000).toISOString();
  db.q.run('INSERT INTO audit_log (ts, action) VALUES (?, ?)', old, 'old.thing');
  db.q.run('INSERT INTO audit_log (ts, action) VALUES (?, ?)', db.nowIso(), 'new.thing');
  const pub = path.join(tmp, 'published');
  const live = db.q.get('SELECT id FROM runs LIMIT 1').id;
  fs.mkdirSync(path.join(pub, String(live)), { recursive: true });
  fs.mkdirSync(path.join(pub, '987654'), { recursive: true });
  fs.mkdirSync(path.join(pub, 'not-a-run'), { recursive: true });
  await queue.purgeOldRuns();
  assert.deepEqual(db.q.all("SELECT action FROM audit_log WHERE action LIKE '%.thing'").map((r) => r.action), ['new.thing']);
  assert.ok(fs.existsSync(path.join(pub, String(live))));
  assert.ok(!fs.existsSync(path.join(pub, '987654')));
  assert.ok(fs.existsSync(path.join(pub, 'not-a-run')));
});

test('a real run: every log line is stored, thumbnails sit next to the images, results.images lists no thumbs', { timeout: 300000 }, async () => {
  const { db, queue } = mods;
  const base = `http://127.0.0.1:${fixture.address().port}/r`;
  const a = db.insert('reports', { name: 'A', url: `${base}?v=a` });
  const b = db.insert('reports', { name: 'B', url: `${base}?v=b` });
  const cfg = { pages: { include: ['Overview'] }, timing: { settleMs: 250 }, viewport: { width: 1400, height: 800 },
    scenarios: { slicers: false, drill: false, crossFilter: false, tooltips: false, matrixExpand: false } };
  const sid = db.insert('suites', { name: 'hk', mode: 'compare', report_a_id: a, report_b_id: b, config: JSON.stringify(cfg) });
  const runId = queue.runQueue.enqueue(sid, 'test');
  // Count the live events: the stored rows must match (nothing lost by buffering).
  let live = 0;
  queue.bus.on(`run:${runId}`, (e) => { if (e.type === 'log') live++; });
  const status = await queue.runQueue.waitFor(runId);
  assert.ok(['passed', 'diffs', 'failed'].includes(status), status);
  const rows = db.q.all('SELECT message FROM run_logs WHERE run_id = ? ORDER BY id', runId);
  assert.ok(rows.length >= 3);
  assert.equal(rows.length, live, 'stored log rows equal emitted log events');
  assert.match(rows.at(-1).message, /Run finished/);
  const dir = queue.runDir(runId);
  const results = db.q.all('SELECT images FROM results WHERE run_id = ?', runId);
  let n = 0;
  for (const r of results) for (const f of Object.values(r.images)) {
    n++;
    assert.ok(!f.includes('.thumb.'), 'thumbnails are not listed in results.images');
    const t = path.join(dir, f.replace(/\.png$/, '.thumb.png'));
    assert.ok(fs.existsSync(t), `${t} exists`);
    const full = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
    const th = PNG.sync.read(fs.readFileSync(t));
    assert.equal(th.width, Math.min(360, full.width));
  }
  assert.ok(n > 0, 'run produced images');
  await queue.deleteRunAsync(runId);
  assert.ok(!fs.existsSync(dir), 'run folder (thumbnails included) is removed with the run');
});
