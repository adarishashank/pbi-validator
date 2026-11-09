/**
 * Restoring a page after an interaction tries "Reset to default" before a
 * reload: it puts slicers, drill and expanded rows back in seconds, while a
 * reload opens the whole report again.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { launchBrowser, newReportContext } from '../src/engine/runner.js';
import { PbiReport } from '../src/engine/pbi.js';
import { resolveSelectors } from '../src/engine/selectors.js';
import { parseSuiteConfig } from '../src/engine/options.js';

const fixture = fs.readFileSync(new URL('./fixtures/mock-report.html', import.meta.url));
let server, base, browser;
before(async () => {
  server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/report`;
  browser = await launchBrowser({ headless: true });
});
after(async () => { await browser?.close(); server.close(); });

async function openReport(qs) {
  const cfg = parseSuiteConfig({ timing: { settleMs: 250, stableTimeoutMs: 15000, loadTimeoutMs: 30000 }, viewport: { width: 1400, height: 800 } });
  const context = await newReportContext(browser, cfg, null);
  const page = await context.newPage();
  const logs = [];
  const r = new PbiReport(page, { url: `${base}?v=a${qs}`, side: 'A', sel: resolveSelectors(), cfg, log: (lvl, m) => logs.push(m) });
  await r.open();
  await r.listPages();
  return { r, logs, context };
}

// Clicks a bar: the chart cross-filters the page, and nothing undoes it.
async function crossFilter(r) {
  const bar = r.frame.locator('rect.bar').first();
  await bar.click();
  await r.waitStable();
}

test('a page is restored with "Reset to default" when the report has it, and reloaded when not', { timeout: 120_000 }, async () => {
  for (const [qs, want] of [['&reset=1', { reloaded: false, reset: true }], ['', { reloaded: true }]]) {
    const { r, logs, context } = await openReport(qs);
    const ref = r.pages[0];
    const baseline = await r.screenshotCanvas();
    await crossFilter(r);
    const res = await r.restore(ref, baseline, null);
    assert.deepEqual({ reloaded: res.reloaded, ...(res.reset ? { reset: true } : {}) }, want, logs.join('\n'));
    assert.equal(r.reloads, want.reloaded ? 1 : 0);
    assert.equal(r.resets, want.reset ? 1 : 0);
    await context.close();
  }
});
