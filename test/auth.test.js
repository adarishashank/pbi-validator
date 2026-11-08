/**
 * Accounts (email + password), roles, sessions, API keys, settings and the audit log.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-auth-'));
const API_TOKEN = 'test-api-token-0123456789abcdef';

// -------------------------------------------------------------- app client
let server, base;
class Client {
  constructor(headers = {}) { this.cookie = ''; this.headers = headers; }
  async req(method, p, body, extra = {}) {
    const res = await fetch(base + p, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...this.headers, ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const m = /^pbiv_session=([^;]*)/.exec(c);
      if (m) this.cookie = m[1] ? `pbiv_session=${m[1]}` : '';
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers };
  }
  get(p, x) { return this.req('GET', p, undefined, x); }
  post(p, b = {}, x) { return this.req('POST', p, b, x); }
  put(p, b = {}, x) { return this.req('PUT', p, b, x); }
  del(p, x) { return this.req('DELETE', p, undefined, x); }
  async login(email, password, extra = {}) { return this.post('/api/auth/login', { email, password, ...extra }); }
}

before(async () => {
  Object.assign(process.env, {
    DATA_DIR: tmp, LOG_LEVEL: 'error', API_TOKEN, LOGIN_MAX_ATTEMPTS: '3',
    NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false', PUBLIC_URL: '',
  });
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const admin = new Client();
const STRONG = 'Correct-Horse-42';

test('first-run setup: remote needs the setup token, weak passwords rejected, then locked', async () => {
  const anon = new Client();
  let r = await anon.get('/api/auth/config');
  assert.equal(r.json.setupRequired, true);
  assert.equal(r.json.setupNeedsToken, false);

  const remote = new Client({ 'X-Forwarded-For': '203.0.113.9' });
  r = await remote.get('/api/auth/config');
  assert.equal(r.json.setupNeedsToken, true);
  r = await remote.post('/api/auth/setup', { email: 'evil@example.com', password: STRONG });
  assert.equal(r.status, 403);

  r = await admin.post('/api/auth/setup', { email: 'Admin@Contoso.com', name: 'Ada Admin', password: 'password123' });
  assert.equal(r.status, 400);
  r = await admin.post('/api/auth/setup', { email: 'Admin@Contoso.com', name: 'Ada Admin', password: STRONG });
  assert.equal(r.status, 201);
  assert.equal(r.json.user.role, 'admin');
  assert.equal(r.json.user.email, 'admin@contoso.com');
  assert.ok(admin.cookie, 'session cookie set');
  assert.equal(r.json.user.password_hash, undefined, 'hash never leaves the server');

  r = await anon.post('/api/auth/setup', { email: 'second@contoso.com', password: STRONG });
  assert.equal(r.status, 409);
  r = await admin.get('/api/auth/me');
  assert.equal(r.json.user.name, 'Ada Admin');
});

test('everything except health/config/login requires sign-in', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/health')).status, 200);
  assert.deepEqual((await anon.get('/api/auth/me')).json, { user: null });
  for (const p of ['/api/reports', '/api/runs', '/api/admin/users', '/api/auth/sessions', '/artifacts/runs/1/0001-a.png']) {
    const r = await anon.get(p);
    assert.equal(r.status, 401, p);
  }
  const r = await new Client({ Authorization: 'Bearer nope' }).get('/api/reports');
  assert.equal(r.status, 401);
});

const editor = new Client(), viewer = new Client();
let editorId, viewerId;

test('admin creates users; temp passwords force a change; roles are enforced', async () => {
  let r = await admin.post('/api/admin/users', { email: 'ed@contoso.com', name: 'Ed Editor', role: 'editor' });
  assert.equal(r.status, 201);
  editorId = r.json.user.id;
  const temp = r.json.tempPassword;
  assert.match(temp, /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/, 'readable generated password, no look-alike characters');
  assert.equal(r.json.validHours, 72);
  assert.ok(Math.abs(Date.parse(r.json.expiresAt) - Date.now() - 72 * 3600e3) < 60e3, 'expires in 72 h');
  assert.equal(r.json.signInUrl, `${base}/`);
  assert.equal(r.json.user.must_change_password, true);
  assert.equal(r.json.user.temp_password_expired, false);
  // A password supplied by the admin is ignored: it is always generated.
  r = await admin.post('/api/admin/users', { email: 'vi@contoso.com', role: 'viewer', password: 'Viewer-Pass-77' });
  viewerId = r.json.user.id;
  const viewerTemp = r.json.tempPassword;
  assert.ok(viewerTemp && viewerTemp !== 'Viewer-Pass-77');
  assert.equal((await new Client().login('vi@contoso.com', 'Viewer-Pass-77')).status, 401);
  r = await admin.post('/api/admin/users', { email: 'ED@contoso.com', role: 'viewer' });
  assert.equal(r.status, 409, 'emails are case-insensitive unique');

  r = await editor.login('ed@contoso.com', temp);
  assert.equal(r.status, 200);
  assert.equal(r.json.user.must_change_password, true);
  r = await editor.get('/api/reports');
  assert.equal(r.status, 403);
  assert.equal(r.json.passwordChangeRequired, true);
  r = await editor.post('/api/auth/password', { next: 'short' });
  assert.equal(r.status, 400);
  r = await editor.post('/api/auth/password', { next: 'Editor-Pass-2026' });
  assert.equal(r.status, 200);
  assert.equal((await editor.get('/api/reports')).status, 200);

  r = await viewer.login('vi@contoso.com', viewerTemp);
  assert.equal(r.json.user.must_change_password, true);
  r = await viewer.post('/api/auth/password', { next: viewerTemp });
  assert.equal(r.status, 400, 'new password must differ');
  await viewer.post('/api/auth/password', { next: 'Viewer-Pass-2026' });
  assert.equal((await viewer.get('/api/reports')).status, 200);
  r = await viewer.post('/api/reports', { name: 'X', url: 'https://example.com/r' });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /editor role/);
  assert.equal((await viewer.get('/api/admin/users')).status, 403);

  r = await editor.post('/api/reports', { name: 'Sales PROD', url: 'https://example.com/prod' });
  assert.equal(r.status, 201);
  assert.equal((await editor.get('/api/admin/users')).status, 403);
  assert.equal((await editor.put('/api/admin/settings', { publicUrl: 'https://x.example' })).status, 403);
});

test('temporary passwords expire; a new one can be generated; choosing your own clears the expiry', async () => {
  const { q } = await import('../src/db.js');
  let r = await admin.post('/api/admin/users', { email: 'late@contoso.com', role: 'viewer' });
  const { tempPassword, user } = r.json;
  q.run('UPDATE users SET temp_password_expires_at = ? WHERE id = ?', new Date(Date.now() - 60e3).toISOString(), user.id);
  const list = (await admin.get('/api/admin/users')).json;
  assert.equal(list.find((u) => u.id === user.id).temp_password_expired, true);
  r = await new Client().login('late@contoso.com', tempPassword);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /temporary password has expired/);

  r = await admin.post(`/api/admin/users/${user.id}/reset-password`);
  assert.equal(r.status, 200);
  assert.notEqual(r.json.tempPassword, tempPassword);
  assert.equal(r.json.user.temp_password_expired, false);
  assert.equal((await new Client().login('late@contoso.com', tempPassword)).status, 401, 'old temporary password no longer works');
  const late = new Client();
  assert.equal((await late.login('late@contoso.com', r.json.tempPassword)).status, 200);
  assert.equal((await late.post('/api/auth/password', { next: 'Night-Owl-2026x' })).status, 200);
  const row = q.get('SELECT must_change_password, temp_password_expires_at FROM users WHERE id = ?', user.id);
  assert.deepEqual({ ...row }, { must_change_password: 0, temp_password_expires_at: null });
  assert.equal((await admin.del(`/api/admin/users/${user.id}`)).status, 204);
});

test('CLI add-user prints an automatically generated temporary password', async () => {
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env, DATA_DIR: tmp, LOG_LEVEL: 'error' };
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'add-user', 'cli.user@contoso.com', '--role', 'editor', '--name', 'Cli User'], { env, encoding: 'utf8' });
  const pw = /Temporary password:\s+(\S+)/.exec(out)?.[1];
  assert.ok(pw, out);
  assert.match(out, /Expires:/);
  const c = new Client();
  const r = await c.login('cli.user@contoso.com', pw);
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'editor');
  assert.equal(r.json.user.must_change_password, true);
  const dup = (() => { try { execFileSync(process.execPath, ['src/cli.js', 'add-user', 'cli.user@contoso.com'], { env, encoding: 'utf8', stdio: 'pipe' }); return 0; } catch (e) { return e.status; } })();
  assert.equal(dup, 2, 'duplicate email refused');
  const me = (await admin.get('/api/admin/users')).json.find((u) => u.email === 'cli.user@contoso.com');
  await admin.del(`/api/admin/users/${me.id}`);
});

test('cross-site writes are blocked', async () => {
  const r = await admin.post('/api/reports', { name: 'CSRF', url: 'https://example.com/x' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const r2 = await new Client().post('/api/auth/login', { email: 'admin@contoso.com', password: STRONG }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r2.status, 403);
});

test('repeated wrong passwords are throttled', async () => {
  const c = new Client({ 'X-Forwarded-For': '198.51.100.7' });
  for (let i = 0; i < 3; i++) assert.equal((await c.login('vi@contoso.com', 'wrong-password!')).status, 401);
  const r = await c.login('vi@contoso.com', 'Viewer-Pass-2026');
  assert.equal(r.status, 429);
  assert.match(r.json.error, /Too many failed attempts/);
  const other = await new Client().login('vi@contoso.com', 'Viewer-Pass-2026');
  assert.equal(other.status, 200, 'other IPs are not locked out by one attacker');
});

test('last-admin and self-protection rules', async () => {
  const me = (await admin.get('/api/auth/me')).json.user;
  let r = await admin.put(`/api/admin/users/${me.id}`, { role: 'viewer' });
  assert.equal(r.status, 409);
  r = await admin.del(`/api/admin/users/${me.id}`);
  assert.equal(r.status, 409);
});

test('disabling a user ends their sessions immediately', async () => {
  const c = new Client();
  await c.login('vi@contoso.com', 'Viewer-Pass-2026');
  assert.equal((await c.get('/api/runs')).status, 200);
  await admin.put(`/api/admin/users/${viewerId}`, { disabled: true });
  assert.equal((await c.get('/api/runs')).status, 401);
  assert.equal((await new Client().login('vi@contoso.com', 'Viewer-Pass-2026')).status, 403);
  await admin.put(`/api/admin/users/${viewerId}`, { disabled: false });
  const reset = await admin.post(`/api/admin/users/${viewerId}/reset-password`);
  assert.ok(reset.json.tempPassword);
  const r = await new Client().login('vi@contoso.com', reset.json.tempPassword);
  assert.equal(r.json.user.must_change_password, true);
});

test('personal API keys and the legacy API_TOKEN work as Bearer tokens', async () => {
  let r = await editor.post('/api/auth/api-keys', { name: 'CI pipeline', expiresDays: 30 });
  assert.equal(r.status, 201);
  const key = r.json.key;
  assert.match(key, /^pbiv_/);
  const ci = new Client({ Authorization: `Bearer ${key}` });
  assert.equal((await ci.get('/api/reports')).status, 200);
  r = await ci.post('/api/reports', { name: 'From CI', url: 'https://example.com/ci' }, { Origin: 'https://anything.example' });
  assert.equal(r.status, 201, 'Bearer requests are not subject to the browser origin check');
  assert.equal((await ci.get('/api/admin/users')).status, 403, 'key carries the owner\'s role');
  const list = (await editor.get('/api/auth/api-keys')).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].key_hash, undefined);
  await editor.del(`/api/auth/api-keys/${list[0].id}`);
  assert.equal((await ci.get('/api/reports')).status, 401);

  const sys = new Client({ Authorization: `Bearer ${API_TOKEN}` });
  assert.equal((await sys.get('/api/admin/users')).status, 200);
});

test('sessions: list, sign out others, logout', async () => {
  const second = new Client();
  await second.login('admin@contoso.com', STRONG);
  let list = (await admin.get('/api/auth/sessions')).json;
  assert.ok(list.length >= 2);
  assert.equal(list.filter((s) => s.current).length, 1);
  await admin.del('/api/auth/sessions');
  assert.equal((await second.get('/api/auth/me')).json.user, null);
  assert.ok((await admin.get('/api/auth/me')).json.user);
  list = (await admin.get('/api/auth/sessions')).json;
  assert.equal(list.length, 1);

  const temp = new Client();
  await temp.login('ed@contoso.com', 'Editor-Pass-2026');
  await temp.post('/api/auth/logout');
  assert.equal((await temp.get('/api/auth/me')).json.user, null);
});

test('sign-in is email + password only; "keep me signed in" controls the cookie', async () => {
  const cfg = (await new Client().get('/api/auth/config')).json;
  assert.equal(cfg.microsoft, undefined);
  assert.equal(cfg.localLogin, undefined);
  assert.equal(typeof cfg.version, 'string');
  // The old Microsoft endpoints no longer exist (the SPA is served instead of a redirect).
  const old = await new Client().get('/auth/microsoft/login');
  assert.equal(old.status, 200);
  assert.equal(old.headers.get('location'), null);

  const persistent = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ed@contoso.com', password: 'Editor-Pass-2026' }) });
  assert.match(persistent.headers.getSetCookie().join(), /Max-Age=\d+/, 'remembered by default');
  const browserOnly = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ed@contoso.com', password: 'Editor-Pass-2026', remember: false }) });
  assert.equal(browserOnly.status, 200);
  const cookie = browserOnly.headers.getSetCookie().find((c) => c.startsWith('pbiv_session='));
  assert.ok(cookie && !/Max-Age/.test(cookie), 'session cookie when "keep me signed in" is off');
  const empty = await new Client().login('', '');
  assert.equal(empty.status, 400);
});

test('settings: public URL is validated and saved', async () => {
  let r = await admin.put('/api/admin/settings', { publicUrl: 'not a url' });
  assert.equal(r.status, 400);
  r = await admin.put('/api/admin/settings', { publicUrl: 'https://pbi.contoso.com/' });
  assert.equal(r.status, 200);
  assert.equal(r.json.publicUrl, 'https://pbi.contoso.com');
  assert.deepEqual(Object.keys(r.json).sort(), ['locked', 'publicUrl']);
  // Requests from the public URL are accepted as same-origin.
  r = await admin.post('/api/reports', { name: 'Via tunnel', url: 'https://example.com/t' }, { Origin: 'https://pbi.contoso.com' });
  assert.equal(r.status, 201);
  await admin.put('/api/admin/settings', { publicUrl: '' });
});

test('audit log records who did what', async () => {
  const r = await admin.get('/api/admin/audit?limit=500');
  const actions = r.json.rows.map((x) => `${x.action}|${x.user_email || ''}`);
  for (const want of ['setup.first_admin|admin@contoso.com', 'login.success|ed@contoso.com', 'login.failed|vi@contoso.com',
    'login.blocked|vi@contoso.com', 'user.create|admin@contoso.com', 'report.create|ed@contoso.com',
    'settings.update|admin@contoso.com', 'account.change_password|ed@contoso.com', 'user.reset_password|admin@contoso.com']) {
    assert.ok(actions.includes(want), `missing audit entry ${want}`);
  }
  const create = r.json.rows.find((x) => x.action === 'user.create');
  assert.match(create.target, /@contoso\.com/);
  assert.ok(!JSON.stringify(r.json.rows).includes('Editor-Pass-2026'), 'passwords never logged');
  const failed = await admin.get('/api/admin/audit?failed=1');
  assert.ok(failed.json.rows.every((x) => x.status >= 400 || /failed|blocked/.test(x.action)));
  const sys = await admin.get('/api/admin/system');
  assert.equal(sys.json.counts.admins, 1);
  assert.ok(sys.json.counts.users >= 3);
});
