/**
 * Accuracy checks of the engine: differences that used to pass unnoticed.
 *  - the data behind a visual (every row, unrounded) is compared, not only the text on screen
 *  - a small but solid changed area in a still screenshot is a difference
 *  - both reports act on the same data point; repeated labels are kept
 *  - a date/range slicer that opens on a different range is reported and aligned
 *  - a page taller than the window is captured whole
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PNG } from 'pngjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-acc-'));
Object.assign(process.env, { DATA_DIR: tmp, LOG_LEVEL: 'error', NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false' });

const fixture = fs.readFileSync(new URL('./fixtures/accuracy-report.html', import.meta.url));

/** What Power BI's querydata endpoint answers: one result per query, in its compact row format. */
function queryAnswer(body) {
  const diff = new Set(body.diff || []);
  const table = [['North', 12], ['South', 9], ['East', 7], ['West', 5], ['Central', diff.has('rows') ? 4 : 3], ['Islands', 1]];
  const data = {
    c0ffee00000000000001: { descriptor: { Select: [{ Kind: 2, Value: 'M0', Name: 'Sum(Sales.Revenue)' }] },
      dsr: { DS: [{ N: 'DS0', PH: [{ DM0: [{ S: [{ N: 'M0', T: 3 }], M0: diff.has('round') ? '1249999.5' : '1200001.25' }] }], IC: true }] } },
    c0ffee00000000000002: { descriptor: { Select: [{ Kind: 1, Value: 'G0', Name: 'Orders.Region' }, { Kind: 2, Value: 'M0', Name: 'Sum(Orders.Count)' }] },
      dsr: { DS: [{ N: 'DS0', PH: [{ DM0: table.map(([g, m], i) => ({ ...(i === 0 ? { S: [{ N: 'G0', T: 1 }, { N: 'M0', T: 4 }] } : {}), C: [g, m] })) }], IC: true }] } },
    c0ffee00000000000003: { descriptor: { Select: [{ Kind: 1, Value: 'G0', Name: 'Sales.Region' }, { Kind: 2, Value: 'M0', Name: 'Sum(Sales.Amount)' }] },
      dsr: { DS: [{ N: 'DS0', PH: [{ DM0: [{ S: [{ N: 'G0', T: 1 }, { N: 'M0', T: 3 }], C: ['North', '100'] }, { C: ['South', '80'] }] }], IC: true }] } },
  };
  return { jobIds: [], results: body.queries.map((q) => ({ jobId: 'j', result: { data: data[q.ApplicationContext.Sources[0].VisualId] } })) };
}

let server, base, db, queue;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/querydata')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(queryAnswer(JSON.parse(raw)))); });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fixture);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/report`;
  db = await import('../src/db.js');
  queue = await import('../src/jobs/queue.js');
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const OFF = { buttons: false, slicers: false, drill: false, drillThrough: false, matrixExpand: false, crossFilter: false, tooltips: false, model: false };
const CFG = { timing: { settleMs: 250, stableTimeoutMs: 15000, loadTimeoutMs: 30000 }, viewport: { width: 1400, height: 800 }, scenarios: OFF };

async function run(name, qa, qb, cfg = {}) {
  const a = db.insert('reports', { name: `${name} A`, url: `${base}?${qa}` });
  const b = db.insert('reports', { name: `${name} B`, url: `${base}?${qb}` });
  const config = { ...CFG, ...cfg, scenarios: { ...OFF, ...(cfg.scenarios || {}) } };
  const sid = db.insert('suites', { name, mode: 'compare', report_a_id: a, report_b_id: b, config: JSON.stringify(config) });
  const runId = queue.runQueue.enqueue(sid, 'test');
  await queue.runQueue.waitFor(runId);
  return { runId, results: db.q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId) };
}
const dump = (rs) => rs.map((r) => `${r.status.padEnd(7)} ${r.scenario.padEnd(12)} ${r.title} ${r.details?.note || ''}`).join('\n');
const visual = (rs, re) => rs.find((r) => r.scenario === 'visual' && re.test(r.title));
const changed = (d) => d.ops.filter((o) => o.op !== 'eq' && o.op !== 'skip');

test('identical reports: everything passes, and the data behind each visual was compared', { timeout: 300_000 }, async () => {
  const { results } = await run('same', 'x=1', 'x=2');
  assert.deepEqual(results.filter((r) => !['pass', 'skipped'].includes(r.status)).map((r) => r.title), [], dump(results));
  const table = visual(results, /Orders/);
  assert.equal(table.details.query.equal, true);
  assert.equal(table.details.query.rowsA, 6, 'all six rows Power BI loaded, not only the two on screen');
  assert.equal(visual(results, /Revenue/).details.query.complete, true);
});

test('a value that is rounded the same on screen but differs behind it is a difference', { timeout: 300_000 }, async () => {
  const { results } = await run('round', 'x=1', 'diff=round');
  const card = visual(results, /Revenue/);
  assert.equal(card.status, 'diff', dump(results));
  assert.equal(card.details.data.equal, true, 'the text on screen ("1.2M") is the same');
  assert.deepEqual(changed(card.details.query).map((o) => [o.a, o.b]), [['1200001.25', '1249999.5']]);
  assert.match(card.details.note, /data behind this visual differs/);
  // The other visuals are untouched.
  assert.equal(visual(results, /Orders/).status, 'pass', dump(results));
});

test('a row that is not on screen but differs is a difference', { timeout: 300_000 }, async () => {
  const { results } = await run('rows', 'x=1', 'diff=rows');
  const table = visual(results, /Orders/);
  assert.equal(table.status, 'diff', dump(results));
  assert.equal(table.details.data.equal, true);
  assert.deepEqual(changed(table.details.query).map((o) => [o.a, o.b]), [['Central | 3', 'Central | 4']]);
  // Switched off, only the screen is compared (the old behaviour).
  const off = await run('rows-off', 'x=1', 'diff=rows', { scenarios: { queryData: false } });
  assert.equal(visual(off.results, /Orders/).status, 'pass', dump(off.results));
});

test('a few solid pixels in a large visual are a difference in still screenshots', { timeout: 300_000 }, async () => {
  const { results } = await run('dot', 'x=1', 'diff=dot');
  const card = visual(results, /Revenue/);
  assert.equal(card.status, 'diff', dump(results));
  assert.ok(card.diff_ratio < 0.002, `below the share-of-pixels limit (${card.diff_ratio})`);
  assert.equal(card.details.pixel.smallChange, true);
  assert.ok(card.details.pixel.maxRegionPixels >= 40 && card.details.pixel.maxRegionPixels <= 64, String(card.details.pixel.maxRegionPixels));
  assert.equal(results.find((r) => r.scenario === 'page_render').status, 'diff');
  // 0 switches the rule off.
  const off = await run('dot-off', 'x=1', 'diff=dot', { thresholds: { minRegionPixels: 0 } });
  assert.equal(visual(off.results, /Revenue/).status, 'pass', dump(off.results));
});

test('repeated labels are kept: two "5" labels against one is a difference', { timeout: 300_000 }, async () => {
  const { results } = await run('labels', 'x=1', 'diff=labels', { scenarios: { queryData: false }, thresholds: { minRegionPixels: 0, maxDiffRatio: 1 } });
  const chart = visual(results, /Sales by Region/);
  assert.equal(chart.status, 'diff', dump(results));
  assert.equal(chart.details.data.removed, 1);
});

test('both reports click the same data point when their order differs', { timeout: 300_000 }, async () => {
  const { results } = await run('order', 'x=1', 'diff=order', { scenarios: { crossFilter: true, tooltips: false }, limits: { crossFilterPerPage: 1 } });
  const cf = results.find((r) => r.scenario === 'cross_filter');
  assert.ok(cf, dump(results));
  assert.deepEqual(cf.details.dataPoint, { A: 'North', B: 'North' });
  assert.equal(cf.details.pointMismatch, undefined);
  // Same point clicked → the "Selected" card shows the same member in both.
  assert.ok(!cf.details.dataDiffs.some((x) => /Selected/.test(x.visual)), JSON.stringify(cf.details.dataDiffs));
});

test('a date slicer that opens on a different range is reported once and B is set to A\'s range', { timeout: 300_000 }, async () => {
  const { results } = await run('range', 'x=1', 'from=2024-06-01');
  const sel = results.filter((r) => r.scenario === 'selections');
  assert.equal(sel.length, 1, dump(results));
  assert.match(sel[0].title, /"Order date" opens on different ranges: 2024-01-01 – 2024-12-31 \(A\) vs 2024-06-01 – 2024-12-31 \(B\)/);
  assert.equal(sel[0].details.applied, true);
  assert.equal(visual(results, /Period/).status, 'pass', dump(results));
  assert.equal(results.find((r) => r.scenario === 'page_render').status, 'pass', dump(results));

  // A slicer that refuses the value: the finding says the page was compared on different ranges.
  const locked = await run('range-locked', 'x=1', 'from=2024-06-01&lock=1');
  const s2 = locked.results.find((r) => r.scenario === 'selections');
  assert.equal(s2.details.applied, false, dump(locked.results));
  assert.match(s2.details.note, /compared with different ranges/);
  assert.equal(visual(locked.results, /Period/).status, 'diff');
});

test('a page taller than the window is captured whole', { timeout: 300_000 }, async () => {
  const { runId, results } = await run('tall', 'tall=1', 'tall=1');
  const render = results.find((r) => r.scenario === 'page_render');
  assert.equal(render.status, 'pass', dump(results));
  const png = PNG.sync.read(fs.readFileSync(path.join(tmp, 'runs', String(runId), render.images.a)));
  assert.ok(png.height >= 1500, `screenshot is ${png.width}×${png.height}`);
  const footer = visual(results, /Footer total/);
  assert.ok(footer && footer.images.a, 'the visual below the fold has its own screenshot');
  assert.equal(footer.status, 'pass');
});

test('an interaction that could not be undone is noticed even when few pixels differ, and the page is reloaded', { timeout: 300_000 }, async () => {
  // In B a second click does not clear the selected data point: only the small
  // "Selected" card still differs from the page's starting state (far below the
  // pixel tolerance). Left like that, it would show up in later checks as a
  // difference between the reports.
  const { runId, results } = await run('sticky', 'x=1', 'sticky=1', { scenarios: { crossFilter: true }, limits: { crossFilterPerPage: 1 } });
  const cf = results.find((r) => r.scenario === 'cross_filter');
  assert.equal(cf.status, 'pass', dump(results));
  const summary = db.q.get('SELECT summary FROM runs WHERE id = ?', runId).summary;
  assert.equal(summary.reloads, 1, 'B is reloaded to get back to its starting state; A is not');
});
