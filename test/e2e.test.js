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

// Model files for the two practice reports: B changes one measure's DAX and adds one.
const model = (b) => ({ model: { tables: [{ name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }],
  measures: [{ name: 'Total Sales', expression: b ? 'SUM ( Sales[Amount] ) * 1.001' : 'SUM ( Sales[Amount] )' }, ...(b ? [{ name: 'New KPI', expression: '42' }] : [])] }] } });

async function runSuite(name, urlA, urlB, cfg = {}, models = null) {
  const a = db.insert('reports', { name: `${name} A`, url: urlA });
  const b = db.insert('reports', { name: `${name} B`, url: urlB });
  if (models) {
    const { snapshotFromUpload } = await import('../src/model/snapshot.js');
    for (const [id, m] of [[a, models.A], [b, models.B]]) {
      fs.writeFileSync(path.join(tmp, 'models', `report-${id}.json`), JSON.stringify(snapshotFromUpload(Buffer.from(JSON.stringify(m)), 'model.bim')));
    }
  }
  const sid = db.insert('suites', { name, mode: 'compare', report_a_id: a, report_b_id: b, config: JSON.stringify({ ...FAST, ...cfg }) });
  const runId = queue.runQueue.enqueue(sid, 'test');
  const status = await queue.runQueue.waitFor(runId);
  const results = db.q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId);
  return { runId, status, results };
}

const find = (rs, scenario, pred = () => true) => rs.filter((r) => r.scenario === scenario && pred(r));
let regressionRunId;

test('A vs B: every scenario detects the planted regressions', { timeout: 600000 }, async () => {
  const { runId, status, results } = await runSuite('regressions', `${base}?v=a`, `${base}?v=b`, {}, { A: model(false), B: model(true) });
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
  assert.ok(drills.every((r) => r.status === 'diff'), 'city- and store-level values differ after drilling');
  // Two levels deep: Region → City → Store, on the drilled member's path.
  const deep = drills.find((r) => /Drill down on "100" › "\d+" \(level 2\)/.test(r.title));
  assert.ok(deep, `level-2 drill recorded: ${drills.map((r) => r.title).join(' | ')}`);
  assert.equal(deep.details.level, 2);
  assert.ok(drills.some((r) => /Expand all down one level.*\(level 2\)/.test(r.title)), 'expand-all followed to level 2');
  // Drill-through to the hidden "Region detail" page: Orders differ (12 vs 13).
  const dt = find(results, 'drill_through');
  assert.equal(dt.length, 1, dump());
  assert.match(dt[0].title, /→ "Region detail"/);
  assert.equal(dt[0].status, 'diff', JSON.stringify(dt[0].details).slice(0, 400));
  assert.ok(dt[0].details.dataDiffs.some((d) => d.visual.includes('Orders')));

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
  // Data model: one DAX change, one measure only in B.
  const mod = find(results, 'model');
  assert.equal(mod.find((r) => r.target === 'model').status, 'diff', dump());
  assert.ok(mod.some((r) => /^Measure \[Total Sales\] changed: DAX/.test(r.title)));
  assert.ok(mod.some((r) => /^Measure \[New KPI\] added in B/.test(r.title)));

  // "What changed" summary of the real run.
  const { runChanges } = await import('../src/jobs/changes.js');
  const ch = runChanges(runId);
  assert.deepEqual(ch.report.removed, ['Archive']);
  assert.deepEqual(ch.report.renamed, [{ a: 'Trends', b: 'Trend Analysis' }]);
  const ov = ch.pages.find((p) => p.name === 'Overview');
  assert.equal(ov.state, 'changed');
  assert.ok(ov.values.some((v) => v.visual.includes('Total Sales') && v.changes.some((c) => c.op === 'chg')), JSON.stringify(ov.values).slice(0, 400));
  assert.ok(ov.interactions.some((i) => i.scenario === 'drill_through'));
  const det = ch.pages.find((p) => p.name === 'Details');
  assert.deepEqual(det.layout.map((l) => l.change).sort(), ['added', 'removed']);
  assert.equal(ch.pages.find((p) => p.name === 'Archive').state, 'removed');
  assert.equal(ch.report.model.changes.length, 2);
  assert.match(ch.report.headline, /pages: 1 removed, 1 renamed/);
  // Ranked for the Power BI team: P1 first (model change, changed numbers, missing page).
  const top = ch.report.top;
  assert.equal(top[0].priority, 'P1');
  assert.ok(top.some((t) => t.area === 'Data model' && /Total Sales/.test(t.title) && t.priority === 'P1'), JSON.stringify(top.slice(0, 4)));
  assert.ok(top.some((t) => t.area === 'Numbers' && /Total Sales/.test(t.title) && /280,000 → 285,285/.test(t.evidence)), JSON.stringify(top));
  assert.ok(top.some((t) => t.area === 'Page' && /"Archive" is missing in B/.test(t.title)));
  assert.ok(top.every((t, i) => i === 0 || ['P1', 'P2', 'P3'].indexOf(top[i - 1].priority) <= ['P1', 'P2', 'P3'].indexOf(t.priority)), 'sorted by priority');
  assert.ok(top.every((t) => t.refs.every((n) => results.some((x) => x.seq === n))), 'refs point at real checks');

  assert.equal(find(results, 'error').length, 0);
  assert.equal(results.filter((r) => r.status === 'error').length, 0, dump());
});

test('A vs A: identical reports produce no differences (no false positives)', { timeout: 600000 }, async () => {
  const { status, results } = await runSuite('identical', `${base}?v=a`, `${base}?v=a`, {}, { A: model(false), B: model(false) });
  assert.equal(find(results, 'model').length, 1, 'identical models: one passing model check');
  assert.equal(find(results, 'model')[0].status, 'pass');
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
  assert.match(htmlDoc, /<h2>What changed<\/h2>/);
  assert.match(htmlDoc, /<h2>Action items for the Power BI team<\/h2>/);
  assert.match(htmlDoc, /lvl lvl-high">Removed/, 'Archive page shown as removed');
  assert.match(htmlDoc, /<h3>Data model<\/h3>/);
  assert.match(htmlDoc, /Value changes \(\d+\)/);

  const pdf = await renderRunPdf(bundle);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 20_000, `PDF has content (${pdf.length} bytes)`);
  assert.ok(!fs.readdirSync(path.join(tmp, 'runs', String(regressionRunId))).some((f) => f.startsWith('.print-')), 'temp print file cleaned up');

  const sheets = runSheets(bundle);
  const names = sheets.map((x) => x.name);
  for (const n of ['What changed', 'Model changes', 'Value changes']) assert.ok(names.includes(n), `${n} sheet: ${names}`);
  assert.deepEqual(sheets.map((s) => s.name), ['Summary', 'Action items', 'Checks', 'What changed', 'Model changes', 'Value changes']);
  assert.equal(sheets.find((x) => x.name === 'Checks').rows.length, bundle.results.length);
  const xlsx = await xlsxBuffer(sheets);
  assert.equal(xlsx.subarray(0, 2).toString(), 'PK', 'xlsx is a zip');
  assert.ok(xlsx.includes(Buffer.from('xl/worksheets/sheet2.xml')));
});

test('accepted differences are recognised in the next real run of the suite', { timeout: 300000 }, async () => {
  assert.ok(regressionRunId, 'needs the regression run');
  const { acceptResult } = await import('../src/jobs/acceptances.js');
  const rows = db.q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', regressionRunId);
  const pick = (scenario, re) => rows.find((r) => r.scenario === scenario && re.test(r.title));
  const button = pick('button', /Go to Details/);
  const card = pick('visual', /Total Sales/);
  const archive = pick('page_render', /Archive/);
  for (const r of [button, card, archive]) acceptResult(r.id, { scope: 'exact', note: 'intended', user: 'e2e' });
  const suiteId = db.q.get('SELECT suite_id FROM runs WHERE id = ?', regressionRunId).suite_id;

  const runId = queue.runQueue.enqueue(suiteId, 'test');
  const status = await queue.runQueue.waitFor(runId);
  const again = db.q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId);
  const find2 = (scenario, re) => again.find((r) => r.scenario === scenario && re.test(r.title));
  for (const [scenario, re] of [['button', /Go to Details/], ['visual', /Total Sales/], ['page_render', /Archive/]]) {
    const r = find2(scenario, re);
    assert.equal(r.status, 'accepted', `${r.title} accepted in the new run (${JSON.stringify(r.details).slice(0, 200)})`);
    assert.equal(r.details.accepted.note, 'intended');
  }
  // Differences that were not accepted are still reported.
  assert.equal(find2('visual', /Sales by Region/).status, 'diff');
  assert.equal(status, 'failed', 'other missing visuals still fail the run');
  const run = db.q.get('SELECT summary FROM runs WHERE id = ?', runId);
  assert.equal(run.summary.byStatus.accepted, 3);
});

test('time budget: every page still gets its static checks; interactions beyond the budget are reported as skipped', { timeout: 300000 }, async () => {
  const t0 = Date.now();
  // 0.8 min budget: interactions stop ~3 s after the start (45 s are kept in reserve).
  const { results, status } = await runSuite('budget', `${base}?v=a`, `${base}?v=b`, { timing: { ...FAST.timing, budgetMinutes: 0.8 }, limits: { parallelPages: 2 } });
  const secs = (Date.now() - t0) / 1000;
  const pagesWith = (sc) => new Set(results.filter((r) => r.scenario === sc).map((r) => r.page));
  for (const p of ['Overview', 'Details', 'Trends']) {
    assert.ok(pagesWith('page_render').has(p), `page render of ${p}`);
    assert.ok(pagesWith('visual').has(p), `visual data of ${p}`);
  }
  const skipped = results.filter((r) => r.scenario === 'budget');
  assert.ok(skipped.length >= 1, 'interactions reported as skipped');
  assert.ok(skipped.every((r) => r.status === 'skipped' && /time budget/.test(r.title)));
  assert.ok(results.filter((r) => ['button', 'slicer', 'drill', 'tooltip', 'cross_filter'].includes(r.scenario)).length < 5, 'interactions mostly not run');
  assert.notEqual(status, 'error');
  assert.ok(secs < 60, `finished quickly (${secs.toFixed(0)} s)`);
});
