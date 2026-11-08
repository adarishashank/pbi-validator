/**
 * End-to-end: drives the real engine (headless Chromium) against a local
 * Power BI DOM replica. Variant B contains planted regressions; every
 * scenario type must catch them, and an A-vs-A run must be fully green.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-e2e-'));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = 'warn';
// Never call a real AI endpoint from tests, even if .env holds a key.
Object.assign(process.env, { NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false' });

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

const FAST = { timing: { settleMs: 250, stableTimeoutMs: 15000, loadTimeoutMs: 30000 }, viewport: { width: 1400, height: 800 } };

async function runSuite(name, urlA, urlB, cfg = {}) {
  const a = db.insert('reports', { name: `${name} A`, url: urlA });
  const b = db.insert('reports', { name: `${name} B`, url: urlB });
  const sid = db.insert('suites', { name, mode: 'compare', report_a_id: a, report_b_id: b, config: JSON.stringify({ ...FAST, ...cfg }) });
  const runId = queue.runQueue.enqueue(sid, 'test');
  const status = await queue.runQueue.waitFor(runId);
  const results = db.q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId);
  return { runId, status, results };
}

const find = (rs, scenario, pred = () => true) => rs.filter((r) => r.scenario === scenario && pred(r));
let regressionRunId;

test('A vs B: every scenario detects the planted regressions', { timeout: 600000 }, async () => {
  const { runId, status, results } = await runSuite('regressions', `${base}?v=a`, `${base}?v=b`);
  regressionRunId = runId;
  const dump = () => results.map((r) => `${r.status.padEnd(7)} ${r.scenario.padEnd(13)} ${r.page} :: ${r.title}`).join('\n');
  assert.equal(status, 'failed', dump());

  const pages = find(results, 'report_pages')[0];
  assert.equal(pages.status, 'diff');
  assert.deepEqual(pages.details.onlyInA, ['Archive']);
  assert.deepEqual(pages.details.renamed, [{ a: 'Trends', b: 'Trend Analysis' }]);
  assert.ok(find(results, 'page_render', (r) => r.page === 'Archive' && r.status === 'missing').length, 'orphan page captured');

  const card = find(results, 'visual', (r) => r.page === 'Overview' && /Total Sales/.test(r.title))[0];
  assert.equal(card.status, 'diff', 'card value change detected');
  assert.ok(card.details.data.ops.some((o) => o.op === 'chg' && o.a === '280,000' && o.b === '285,285'), JSON.stringify(card.details.data));
  assert.ok(card.images.a && card.images.b && card.images.diff && card.images.annotated, 'diff screenshots produced');
  for (const f of Object.values(card.images)) assert.ok(fs.existsSync(path.join(tmp, 'runs', String(runId), f)));

  const chart = find(results, 'visual', (r) => r.page === 'Overview' && /Sales by Region/.test(r.title))[0];
  assert.equal(chart.status, 'diff', 'chart data point change detected');

  const btn = find(results, 'button', (r) => /Go to Details/.test(r.title))[0];
  assert.ok(btn, dump());
  assert.equal(btn.status, 'fail', `button navigates to different pages: ${JSON.stringify(btn.details.outcome)}`);
  assert.equal(btn.details.outcome.A.page, 'Details');
  assert.equal(btn.details.outcome.B.page, 'Trend Analysis');

  const slicers = find(results, 'slicer');
  assert.equal(slicers.length, 2, dump());
  assert.equal(slicers.find((r) => /"North"/.test(r.title)).status, 'pass');
  assert.equal(slicers.find((r) => /"West"/.test(r.title)).status, 'diff');

  const drills = find(results, 'drill');
  assert.ok(drills.some((r) => /Expand all down one level/.test(r.title)), dump());
  assert.ok(drills.some((r) => /Drill down on/.test(r.title)), dump());
  assert.ok(drills.every((r) => r.status === 'diff'), 'city-level values differ after drilling');

  const matrix = find(results, 'matrix_expand')[0];
  assert.ok(matrix, dump());
  assert.equal(matrix.status, 'diff');
  assert.ok(matrix.details.data.ops.some((o) => o.op === 'chg' && /75/.test(o.b)));

  const structure = find(results, 'structure', (r) => r.page === 'Details')[0];
  assert.equal(structure.status, 'diff');
  const kinds = structure.details.issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['extra_in_b', 'missing_in_b']);

  assert.ok(find(results, 'cross_filter').length >= 2);
  const tips = find(results, 'tooltip', (r) => r.details.linesA?.length && r.details.linesB?.length);
  assert.ok(tips.length >= 2, `tooltips captured & compared: ${dump()}`);
  assert.ok(tips.every((r) => r.status === 'pass'), 'first data point tooltip is identical in A and B');
  assert.equal(find(results, 'error').length, 0);
  assert.equal(results.filter((r) => r.status === 'error').length, 0, dump());
});

test('A vs A: identical reports produce no differences (no false positives)', { timeout: 600000 }, async () => {
  const { status, results } = await runSuite('identical', `${base}?v=a`, `${base}?v=a`);
  const bad = results.filter((r) => !['pass', 'skipped', 'warn'].includes(r.status));
  assert.deepEqual(bad.map((r) => `${r.status} ${r.scenario} ${r.title} ${JSON.stringify(r.details).slice(0, 300)}`), []);
  assert.equal(status, 'passed');
  assert.ok(results.length > 20, `expected a full scenario sweep, got ${results.length}`);
});

test('exports: PDF report and Excel workbook are built from a real run', { timeout: 120000 }, async () => {
  assert.ok(regressionRunId, 'needs the regression run');
  const { loadRunBundle } = await import('../src/jobs/export.js');
  const { renderRunPdf, runSheets, reportHtml } = await import('../src/jobs/report.js');
  const { xlsxBuffer } = await import('../src/jobs/xlsx.js');
  const bundle = loadRunBundle(regressionRunId);

  const htmlDoc = reportHtml(bundle);
  assert.match(htmlDoc, /Checks needing attention/);
  assert.match(htmlDoc, /Go to Details/);
  assert.match(htmlDoc, /<img src="/, 'problem screenshots embedded');

  const pdf = await renderRunPdf(bundle);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 20_000, `PDF has content (${pdf.length} bytes)`);
  assert.ok(!fs.readdirSync(path.join(tmp, 'runs', String(regressionRunId))).some((f) => f.startsWith('.print-')), 'temp print file cleaned up');

  const sheets = runSheets(bundle);
  assert.deepEqual(sheets.map((s) => s.name), ['Summary', 'Checks']);
  assert.equal(sheets[1].rows.length, bundle.results.length);
  const xlsx = await xlsxBuffer(sheets);
  assert.equal(xlsx.subarray(0, 2).toString(), 'PK', 'xlsx is a zip');
  assert.ok(xlsx.includes(Buffer.from('xl/worksheets/sheet2.xml')));
});
