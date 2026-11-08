/**
 * Whole-website end-to-end test in a real browser (headless Chromium), the way
 * people use it: first-run setup → admin adds users (temporary passwords are
 * generated automatically) → editor signs in, chooses a password, adds report
 * links, builds a suite, runs it against a local Power BI replica and
 * downloads the PDF / Excel / HTML exports → viewer is read-only → admin
 * regenerates an expired temporary password and checks the audit log.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-ui-'));
Object.assign(process.env, {
  DATA_DIR: tmp, LOG_LEVEL: 'error', API_TOKEN: '', PUBLIC_URL: '',
  NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false',
});

const fixture = fs.readFileSync(new URL('./fixtures/mock-report.html', import.meta.url));
let reportServer, app, base, reportBase, browser, page, db;
const pageErrors = [];

before(async () => {
  reportServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture); });
  await new Promise((r) => reportServer.listen(0, '127.0.0.1', r));
  reportBase = `http://127.0.0.1:${reportServer.address().port}/report`;
  const { createApp } = await import('../src/server.js');
  db = await import('../src/db.js');
  app = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${app.address().port}`;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text()); });
});
after(async () => {
  await browser?.close();
  app?.close(); reportServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----------------------------------------------------------------- helpers
const ADMIN = { email: 'ada@contoso.com', password: 'Admin-Strong-2026' };
const EDITOR = { email: 'ed@contoso.com', password: 'Editor-Strong-2026' };
const VIEWER = { email: 'vic@contoso.com', password: 'Viewer-Strong-2026' };
const temps = {};

const nav = async (hash) => { await page.goto(`${base}/#${hash}`); await page.waitForLoadState('networkidle'); };
async function signIn(email, password) {
  await page.waitForSelector('h1:has-text("Sign in")');
  await page.fill('input[type=email]', email);
  await page.fill('input[autocomplete=current-password]', password);
  await page.click('button:has-text("Sign in")');
}
async function choosePassword(password) {
  await page.waitForSelector('h1:has-text("Choose your own password")');
  const fields = page.locator('input[autocomplete=new-password]');
  await fields.nth(0).fill(password);
  await fields.nth(1).fill(password);
  await page.click('button:has-text("Save password and continue")');
  await page.waitForSelector('h1:has-text("Dashboard")');
}
async function signOut() {
  await page.click('.side-user button:has-text("Sign out")');
  await page.waitForSelector('h1:has-text("Sign in")');
}
async function addUser(email, role) {
  await page.click('button:has-text("+ Add user")');
  await page.fill('.modal input[type=email]', email);
  await page.locator('.modal input[type=radio]').nth(['viewer', 'editor', 'admin'].indexOf(role)).check();
  await page.click('.modal button:has-text("Add user and generate password")');
  await page.waitForSelector('.modal h2:has-text("User added")');
  const pw = (await page.locator('.modal .copybox code').textContent()).trim();
  assert.ok(await page.locator('.modal button:has-text("Copy sign-in instructions")').isVisible());
  assert.match(await page.locator('.modal').textContent(), /Expires/);
  await page.click('.modal button:has-text("Done")');
  return pw;
}
async function download(clickFn) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), clickFn()]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  return { name: dl.suggestedFilename(), bytes: fs.readFileSync(file) };
}

// ------------------------------------------------------------------- flow
test('first visit shows setup; the administrator account is created', { timeout: 60_000 }, async () => {
  await page.goto(base);
  await page.waitForSelector('h1:has-text("Create the administrator account")');
  await page.fill('input[autocomplete=name]', 'Ada Admin');
  await page.fill('input[autocomplete=username]', ADMIN.email);
  const pw = page.locator('input[autocomplete=new-password]');
  await pw.nth(0).fill(ADMIN.password);
  await pw.nth(1).fill(ADMIN.password);
  assert.equal(await page.locator('.pw-rules .ok').count(), 3, 'all password rules satisfied');
  await page.click('button:has-text("Create administrator")');
  await page.waitForSelector('h1:text-is("Admin")');
  assert.match(page.url(), /#\/admin\/users$/);
  assert.ok(await page.locator('.nav a:has-text("Admin")').isVisible());
  assert.ok(await page.locator('.side-user:has-text("Ada Admin")').isVisible());
});

test('admin adds an editor and a viewer; temporary passwords are generated automatically', { timeout: 60_000 }, async () => {
  temps.editor = await addUser(EDITOR.email, 'editor');
  temps.viewer = await addUser(VIEWER.email, 'viewer');
  for (const t of [temps.editor, temps.viewer]) assert.match(t, /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/);
  assert.notEqual(temps.editor, temps.viewer);
  await page.waitForSelector(`td:has-text("${VIEWER.email}")`);
  assert.equal(await page.locator('.badge:has-text("Invited")').count(), 2);
  await signOut();
});

test('wrong password is refused with a clear message', { timeout: 30_000 }, async () => {
  await signIn(EDITOR.email, 'not-the-password');
  await page.waitForSelector('.callout.err:has-text("Incorrect email or password")');
});

test('editor signs in with the temporary password and must choose their own', { timeout: 60_000 }, async () => {
  await page.fill('input[autocomplete=current-password]', temps.editor);
  await page.click('button:has-text("Sign in")');
  await choosePassword(EDITOR.password);
  assert.equal(await page.locator('.nav a:has-text("Admin")').count(), 0, 'editors have no admin area');
});

test('editor adds report links, builds a suite and runs it end to end', { timeout: 420_000 }, async () => {
  await nav('/reports');
  for (const [name, env, v] of [['Sales Overview', 'PROD', 'a'], ['Sales Overview', 'DEV', 'b']]) {
    await page.click('button:has-text("+ Add report link")');
    const inputs = page.locator('.modal input[type=text]');
    await inputs.nth(0).fill(name);
    await inputs.nth(1).fill(env);
    await page.fill('.modal input[type=url]', `${reportBase}?v=${v}`);
    await page.click('.modal button:has-text("Save")');
    await page.waitForSelector('.modal', { state: 'detached' });
  }
  await page.waitForSelector('text=DEV');

  await nav('/suites');
  await page.click('button:has-text("+ New suite")');
  await page.fill('.modal input[placeholder="Sales report · DEV vs PROD"]', 'Sales · PROD vs DEV');
  const selects = page.locator('.modal select');
  await selects.nth(0).selectOption({ label: 'Sales Overview · PROD' });
  await selects.nth(1).selectOption({ label: 'Sales Overview · DEV' });
  // Faster timings for the local replica (same as the engine tests).
  await page.click('.modal .tabs button:has-text("Advanced")');
  const field = (label) => page.locator(`.modal label.f:has-text("${label}") input`);
  await field('Viewport width').fill('1400');
  await field('Viewport height').fill('800');
  await field('Load timeout (ms)').fill('30000');
  await field('Render-settle timeout (ms)').fill('15000');
  await field('Settle delay (ms)').fill('250');
  await page.click('.modal button:has-text("Save suite")');
  await page.waitForSelector('.suite-card:has-text("Sales · PROD vs DEV")');

  await page.click('.suite-card button:has-text("Run now")');
  await page.waitForSelector('h1:has-text("Run #")');
  // "Download PDF" only appears once the run has finished.
  await page.waitForSelector('button:has-text("Download PDF")', { timeout: 360_000 });
  const header = await page.locator('.topbar').textContent();
  assert.match(header, /failed/i, 'planted regressions make the run fail');
  assert.match(header, new RegExp(`by ${EDITOR.email}`));
  await page.click('.chip:has-text("All")');
  await page.waitForSelector('.res:has-text("Go to Details")');
  assert.ok(await page.locator('.res .badge:has-text("Fail")').count() >= 1);
});

test('the run downloads as PDF, Excel and HTML from the browser', { timeout: 240_000 }, async () => {
  const pdf = await download(() => page.click('button:has-text("Download PDF")'));
  assert.match(pdf.name, /^pbi-validation-run-\d+\.pdf$/);
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.bytes.length > 50_000, `PDF has screenshots (${pdf.bytes.length} bytes)`);

  const openMenu = () => page.click('.menu > button:has-text("Export")');
  await openMenu();
  const xlsx = await download(() => page.click('.menu-item:has-text("Excel workbook")'));
  assert.match(xlsx.name, /\.xlsx$/);
  assert.equal(xlsx.bytes.subarray(0, 2).toString(), 'PK');

  await openMenu();
  const zip = await download(() => page.click('.menu-item:has-text("Interactive HTML")'));
  assert.match(zip.name, /\.zip$/);

  await nav('/runs');
  const list = await download(() => page.click('button:has-text("Export to Excel")'));
  assert.match(list.name, /^pbi-validation-runs-.*\.xlsx$/);
  await signOut();
});

test('viewer is read-only but can view and export', { timeout: 120_000 }, async () => {
  await signIn(VIEWER.email, temps.viewer);
  await choosePassword(VIEWER.password);
  assert.ok(await page.locator('.side-note:has-text("Read-only")').isVisible());
  await nav('/suites');
  await page.waitForSelector('.suite-card');
  assert.equal(await page.locator('.suite-card button:has-text("Run now")').isVisible(), false, 'no run button for viewers');
  const r = await page.request.post(`${base}/api/reports`, { data: { name: 'X', url: 'https://example.com/r' } });
  assert.equal(r.status(), 403, 'server refuses viewer writes even if the UI is bypassed');
  assert.equal((await page.request.get(`${base}/api/admin/users`)).status(), 403);

  await nav('/runs');
  await page.click('tr.click');
  const pdf = await download(() => page.click('button:has-text("Download PDF")'));
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  await signOut();
});

test('expired temporary passwords are refused; admin generates a new one', { timeout: 120_000 }, async () => {
  await signIn(ADMIN.email, ADMIN.password);
  await page.waitForSelector('h1:has-text("Dashboard")');
  await nav('/admin/users');
  const late = await addUser('late@contoso.com', 'viewer');
  db.q.run("UPDATE users SET temp_password_expires_at = ? WHERE email = 'late@contoso.com'", new Date(Date.now() - 60e3).toISOString());
  await nav('/admin/settings');
  await nav('/admin/users');
  const row = page.locator('tr:has-text("late@contoso.com")');
  await row.locator('.badge:has-text("Temp password expired")').waitFor();
  await signOut();

  await signIn('late@contoso.com', late);
  await page.waitForSelector('.callout.err:has-text("temporary password has expired")');

  await page.fill('input[type=email]', ADMIN.email);
  await page.fill('input[autocomplete=current-password]', ADMIN.password);
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('h1:has-text("Dashboard")');
  await nav('/admin/users');
  await page.locator('tr:has-text("late@contoso.com") button:has-text("New temporary password")').click();
  await page.click('.modal button:has-text("Generate password")');
  await page.waitForSelector('.modal h2:has-text("New temporary password")');
  const fresh = (await page.locator('.modal .copybox code').textContent()).trim();
  assert.notEqual(fresh, late);
  await page.click('.modal button:has-text("Done")');
  await signOut();

  await signIn('late@contoso.com', fresh);
  await choosePassword('Fresh-Start-2026x');
  await signOut();
});

test('audit log shows who did what; no browser errors anywhere', { timeout: 60_000 }, async () => {
  await signIn(ADMIN.email, ADMIN.password);
  await page.waitForSelector('h1:has-text("Dashboard")');
  await nav('/admin/audit');
  await page.waitForSelector('table.t');
  const text = await page.locator('table.t').textContent();
  for (const action of ['setup.first_admin', 'user.create', 'login.success', 'login.failed', 'account.change_password', 'report.create', 'suite.create', 'suite.run', 'user.reset_password']) {
    assert.ok(text.includes(action), `audit log lists ${action}`);
  }
  assert.deepEqual(pageErrors, [], 'no JavaScript errors in the browser');
});
