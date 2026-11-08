/**
 * Results site (Cloudflare Pages): publish / unpublish / password / errors.
 * Wrangler is replaced by a stub that records its arguments, so no Cloudflare
 * account is needed; the generated site and its password worker are checked.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-pages-'));
const stub = path.join(tmp, 'wrangler-stub.mjs');
const log = path.join(tmp, 'wrangler.log');
fs.writeFileSync(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
let input = '';
if (args.includes('secret')) input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
if (fs.existsSync(${JSON.stringify(path.join(tmp, 'fail'))})) { console.error('✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]'); process.exit(1); }
if (args[1] === 'project' && args[2] === 'create' && fs.existsSync(${JSON.stringify(path.join(tmp, 'created'))})) { console.error('✘ [ERROR] A project with this name already exists. [code: 8000002]'); process.exit(1); }
if (args[1] === 'project') fs.writeFileSync(${JSON.stringify(path.join(tmp, 'created'))}, '1');
if (args[1] === 'deploy') console.log('✨ Deployment complete! Take a peek over at https://a1b2c3d4.pbireporttest.pages.dev');
`);
fs.chmodSync(stub, 0o755);
Object.assign(process.env, {
  DATA_DIR: tmp, LOG_LEVEL: 'error', PAGES_WRANGLER: stub, API_TOKEN: '',
  NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false',
});

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
let server, base, db;
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

class Client {
  constructor() { this.cookie = ''; }
  async req(method, p, body) {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie && { Cookie: this.cookie }) }, body: body && JSON.stringify(body) });
    const c = res.headers.getSetCookie().find((x) => x.startsWith('pbiv_session='));
    if (c) this.cookie = c.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  }
}
const admin = new Client(), viewer = new Client();
const waitIdle = async (c) => {
  for (let i = 0; i < 200; i++) {
    const s = (await c.req('GET', '/api/pages/status')).json;
    if (!s.deploying) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('deploy did not finish');
};

before(async () => {
  db = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await admin.req('POST', '/api/auth/setup', { email: 'admin@example.com', password: 'Cloud-Pages-2026x' });
  const r = await admin.req('POST', '/api/admin/users', { email: 'view@example.com', role: 'viewer' });
  await viewer.req('POST', '/api/auth/login', { email: 'view@example.com', password: r.json.tempPassword });
  await viewer.req('POST', '/api/auth/password', { next: 'Read-Only-2026x' });

  // A finished run with screenshots.
  const now = new Date().toISOString();
  const runId = db.insert('runs', {
    suite_name: 'Sales · PROD vs DEV', trigger: 'manual', status: 'failed', progress: 1, queued_at: now, started_at: now, finished_at: now,
    snapshot: JSON.stringify({ reports: { A: { name: 'Sales', environment: 'PROD', url: 'https://example.com/a' }, B: { name: 'Sales', environment: 'DEV', url: 'https://example.com/b' } } }),
    summary: JSON.stringify({ total: 2, byStatus: { fail: 1, pass: 1 }, durationMs: 5000 }),
  });
  const dir = path.join(tmp, 'runs', String(runId));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['0001-a.png', '0001-b.png', '0002-a.png']) fs.writeFileSync(path.join(dir, f), PNG);
  db.insert('results', { run_id: runId, seq: 1, page: 'Overview', scenario: 'button', title: 'Click button · Go to Details', status: 'fail', images: JSON.stringify({ a: '0001-a.png', b: '0001-b.png' }), details: JSON.stringify({ note: 'Button goes to a different page' }), created_at: now });
  db.insert('results', { run_id: runId, seq: 2, page: 'Overview', scenario: 'visual', title: 'Card · Total Sales', status: 'pass', images: JSON.stringify({ a: '0002-a.png' }), details: '{}', created_at: now });
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('viewers can see the status but cannot publish', async () => {
  const s = (await viewer.req('GET', '/api/pages/status')).json;
  assert.equal(s.project, 'pbireporttest');
  assert.deepEqual(s.published, []);
  assert.equal((await viewer.req('POST', '/api/runs/1/publish')).status, 403);
  assert.equal((await viewer.req('PUT', '/api/admin/pages', { password: 'whatever-123' })).status, 403);
});

test('publishing builds the run page, PDF, Excel and screenshots, then deploys', { timeout: 120_000 }, async () => {
  const r = await admin.req('POST', '/api/runs/1/publish');
  assert.equal(r.status, 202);
  const s = await waitIdle(admin);
  assert.equal(s.lastError, null);
  assert.equal(s.url, 'https://pbireporttest.pages.dev');
  assert.deepEqual(s.published.map((p) => p.id), [1]);

  const site = path.join(tmp, 'pages-site');
  const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.match(index, /Sales · PROD vs DEV/);
  assert.match(index, /href="runs\/1\/report\.pdf"/);
  assert.match(fs.readFileSync(path.join(site, 'runs/1/index.html'), 'utf8'), /All published runs/);
  assert.equal(fs.readFileSync(path.join(site, 'runs/1/report.pdf')).subarray(0, 5).toString(), '%PDF-');
  assert.equal(fs.readFileSync(path.join(site, 'runs/1/report.xlsx')).subarray(0, 2).toString(), 'PK');
  assert.deepEqual(fs.readdirSync(path.join(site, 'runs/1/images')).sort(), ['0001-a.png', '0001-b.png', '0002-a.png']);
  for (const f of ['_worker.js', '_headers', 'robots.txt']) assert.ok(fs.existsSync(path.join(site, f)), f);

  const c = calls();
  assert.deepEqual(c[0].args.slice(0, 4), ['pages', 'project', 'create', 'pbireporttest']);
  const deploy = c.find((x) => x.args[1] === 'deploy').args;
  assert.deepEqual([deploy[2], deploy[4], deploy[6]], [site, 'pbireporttest', 'main']);
});

test('the site password is stored as a Cloudflare secret and enforced by the worker', { timeout: 60_000 }, async () => {
  assert.equal((await admin.req('PUT', '/api/admin/pages', { password: 'short' })).status, 400);
  assert.equal((await admin.req('PUT', '/api/admin/pages', { password: 'Results-Only-2026' })).status, 202);
  const s = await waitIdle(admin);
  assert.equal(s.passwordSet, true);
  const put = calls().find((x) => x.args.includes('secret') && x.args.includes('put'));
  assert.deepEqual(put.args.slice(0, 4), ['pages', 'secret', 'put', 'SITE_PASSWORD']);
  assert.equal(put.input, 'Results-Only-2026', 'password passed on stdin, never as an argument');
  assert.ok(!calls().some((x) => x.args.join(' ').includes('Results-Only-2026')));

  const worker = (await import(`${path.join(tmp, 'pages-site', '_worker.js')}?t=${Date.now()}`)).default;
  const ASSETS = { fetch: async () => new Response('asset', { status: 200 }) };
  const env = { SITE_PASSWORD: 'Results-Only-2026', ASSETS };
  const basic = (u, p) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
  let res = await worker.fetch(new Request('https://x.pages.dev/'), env);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('WWW-Authenticate'), /Basic/);
  res = await worker.fetch(new Request('https://x.pages.dev/', { headers: basic('anyone', 'wrong') }), env);
  assert.equal(res.status, 401);
  res = await worker.fetch(new Request('https://x.pages.dev/', { headers: basic('anyone', 'Results-Only-2026') }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  res = await worker.fetch(new Request('https://x.pages.dev/'), { ASSETS });
  assert.equal(res.status, 200, 'no password configured = public');
});

test('unpublishing removes the run; Cloudflare errors are reported, not hidden', { timeout: 60_000 }, async () => {
  assert.equal((await admin.req('DELETE', '/api/runs/1/publish')).status, 202);
  let s = await waitIdle(admin);
  assert.deepEqual(s.published, []);
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'pages-site', 'index.html'), 'utf8'), /Sales · PROD vs DEV/);
  assert.ok(!fs.existsSync(path.join(tmp, 'published', '1')));

  fs.writeFileSync(path.join(tmp, 'fail'), '1');
  await admin.req('POST', '/api/admin/pages/deploy');
  s = await waitIdle(admin);
  assert.match(s.lastError, /Authentication error/);
  fs.rmSync(path.join(tmp, 'fail'));
  await admin.req('POST', '/api/admin/pages/deploy');
  s = await waitIdle(admin);
  assert.equal(s.lastError, null, 'cleared after a successful deploy');

  const audit = (await admin.req('GET', '/api/admin/audit?limit=50')).json.rows.map((x) => x.action);
  for (const a of ['run.publish', 'run.unpublish', 'pages.settings', 'pages.deploy']) assert.ok(audit.includes(a), a);
});
