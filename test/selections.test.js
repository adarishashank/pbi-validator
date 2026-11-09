/**
 * Same parameters on both sides: when a slicer opens on different values in A
 * and B, that is reported once and B is set to A's values before the page is
 * compared, so the visuals are compared on the same selection. Fixed suite
 * parameters are applied to both reports.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-sel-'));
Object.assign(process.env, { DATA_DIR: tmp, LOG_LEVEL: 'warn', NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false' });

const fixture = fs.readFileSync(new URL('./fixtures/mock-report.html', import.meta.url));
let server, base, db, queue;
before(async () => {
  server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/report`;
  db = await import('../src/db.js');
  queue = await import('../src/jobs/queue.js');
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const CFG = {
  timing: { settleMs: 250, stableTimeoutMs: 15000, loadTimeoutMs: 30000 }, viewport: { width: 1400, height: 800 },
  pages: { include: ['Overview'] },
  scenarios: { buttons: false, drill: false, drillThrough: false, matrixExpand: false, crossFilter: false, tooltips: false, model: false },
  limits: { slicerValues: 1 },
};

async function run(name, urlA, urlB, cfg = {}) {
  const a = db.insert('reports', { name: `${name} A`, url: urlA });
  const b = db.insert('reports', { name: `${name} B`, url: urlB });
  const config = { ...CFG, ...cfg, scenarios: { ...CFG.scenarios, ...(cfg.scenarios || {}) } };
  const sid = db.insert('suites', { name, mode: 'compare', report_a_id: a, report_b_id: b, config: JSON.stringify(config) });
  const runId = queue.runQueue.enqueue(sid, 'test');
  await queue.runQueue.waitFor(runId);
  return { runId, results: db.q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId) };
}
const dump = (rs) => rs.map((r) => `${r.status.padEnd(7)} ${r.scenario.padEnd(12)} ${r.title}`).join('\n');
const card = (rs) => rs.find((r) => r.scenario === 'visual' && /Total Sales/.test(r.title));

test('a slicer that opens on different values is reported once; the page is compared on the same values', { timeout: 300_000 }, async () => {
  const { runId, results } = await run('aligned', `${base}?v=a`, `${base}?v=a&sel=South`);
  const sel = results.filter((r) => r.scenario === 'selections');
  assert.equal(sel.length, 1, dump(results));
  assert.equal(sel[0].status, 'diff');
  assert.deepEqual([sel[0].details.defaultA, sel[0].details.defaultB], [[], ['South']]);
  assert.equal(sel[0].details.applied, true);
  assert.match(sel[0].title, /"Region" opens on different values: All \(A\) vs South \(B\)/);
  assert.ok(sel[0].images.a && sel[0].images.b, 'pictures of both slicers as they opened');

  // Identical reports otherwise: with B aligned, the visuals and the page match.
  assert.equal(card(results).status, 'pass', dump(results));
  assert.equal(results.find((r) => r.scenario === 'page_render').status, 'pass', dump(results));
  assert.deepEqual(results.find((r) => r.scenario === 'page_render').details.selections.map((x) => [x.slicer, x.why, x.values]), [['Region', 'aligned', []]]);
  // Slicer interactions start from, and return to, the aligned state.
  const slicer = results.filter((r) => r.scenario === 'slicer');
  assert.ok(slicer.length && slicer.every((r) => r.status === 'pass'), dump(results));

  const { runChanges } = await import('../src/jobs/changes.js');
  const ch = runChanges(runId);
  assert.match(ch.report.headline, /1 slicer opens on different values/);
  const top = ch.report.top[0];
  assert.deepEqual([top.priority, top.area, top.title], ['P1', 'Defaults', 'Slicer "Region" opens on All in A but South in B']);
  assert.deepEqual(ch.pages.find((p) => p.name === 'Overview').selections.map((x) => [x.slicer, x.b]), [['Region', ['South']]]);
  // Each page lists the slicer values both sides were compared on.
  const region = ch.pages.find((p) => p.name === 'Overview').filters.find((f) => f.slicer === 'Region');
  assert.deepEqual([region.a, region.b, region.same, region.how], ['All', 'All', true, 'aligned']);
});

test('with alignment off, the default selection shows up as value differences', { timeout: 300_000 }, async () => {
  const { results } = await run('not aligned', `${base}?v=a`, `${base}?v=a&sel=South`, { scenarios: { alignSelections: false, slicers: false } });
  assert.equal(results.filter((r) => r.scenario === 'selections').length, 0);
  const c = card(results);
  assert.equal(c.status, 'diff');
  assert.ok(c.details.data.ops.some((o) => o.op === 'chg' && o.a === '280,000' && o.b === '80'), JSON.stringify(c.details.data));
});

test('fixed parameters are applied to both reports; a value one report lacks fails', { timeout: 300_000 }, async () => {
  const { results } = await run('parameters', `${base}?v=a`, `${base}?v=b`, {
    scenarios: { slicers: false },
    parameters: [{ slicer: 'Region', values: ['East'] }],
  });
  // East is the same in both reports (60), so the card matches on that selection.
  const c = card(results);
  assert.equal(c.status, 'pass', dump(results));
  assert.ok(c.details.sample.includes('60'), JSON.stringify(c.details.sample));
  const pr = results.find((r) => r.scenario === 'page_render');
  assert.deepEqual(pr.details.selections.map((x) => [x.slicer, x.why, x.values, x.changed.sort()]), [['Region', 'parameter', ['East'], ['A', 'B']]]);
  assert.deepEqual(pr.details.filters.filter((f) => f.slicer === 'Region').map((f) => [f.a, f.b, f.same, f.how]), [['East', 'East', true, 'parameter']]);

  const bad = await run('bad parameter', `${base}?v=a`, `${base}?v=a`, { scenarios: { slicers: false }, parameters: [{ slicer: '/^reg/i', values: ['Mars'] }] });
  const f = bad.results.find((r) => r.scenario === 'selections');
  assert.equal(f?.status, 'fail', dump(bad.results));
  assert.match(f.title, /Parameter "Region" = Mars could not be set/);
});

test('a dropdown slicer whose list loads late and scrolls is read from its text and set by scrolling to the value', { timeout: 300_000 }, async () => {
  const { results } = await run('dropdown', `${base}?v=a&dd=1&biz=CFI`, `${base}?v=a&dd=1&biz=AUS`, { scenarios: { slicers: false } });
  const sel = results.filter((r) => r.scenario === 'selections');
  assert.equal(sel.length, 1, dump(results));
  assert.match(sel[0].title, /"Business" opens on different values: CFI \(A\) vs AUS \(B\)/);
  assert.equal(sel[0].details.applied, true, JSON.stringify(sel[0].details));
  // CFI is the 7th of 8 values and only 3 render at a time: B was scrolled to it.
  const biz = results.find((r) => r.scenario === 'visual' && /Business Sales/.test(r.title));
  assert.equal(biz.status, 'pass', dump(results));
  assert.equal(results.find((r) => r.scenario === 'visual' && /Slicer · Business/.test(r.title)).status, 'pass', dump(results));
});

test('when B cannot be set, the finding says so instead of claiming the page was aligned', { timeout: 300_000 }, async () => {
  // B's list has no "XX": a default only A can show.
  const { results } = await run('cannot align', `${base}?v=a&dd=1&biz=XX`, `${base}?v=a&dd=1&biz=AUS`, { scenarios: { slicers: false } });
  const sel = results.find((r) => r.scenario === 'selections');
  assert.ok(sel, dump(results));
  assert.equal(sel.details.applied, false);
  const biz = results.find((r) => r.scenario === 'page_render').details.filters.find((f) => f.slicer === 'Business');
  assert.deepEqual([biz.a, biz.b, biz.same, biz.how], ['XX', 'AUS', false, 'not aligned']);
  assert.match(sel.details.note, /XX not available in B: the rest of this page was compared with different selections/);
});
