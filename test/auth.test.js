/**
 * Accounts, roles, sessions, API keys, audit and Microsoft Entra ID sign-in.
 * A mock identity provider signs real RS256 ID tokens so the whole OIDC flow
 * (PKCE, state, nonce, JWKS signature, issuer/audience checks) is exercised.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-auth-'));
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const API_TOKEN = 'test-api-token-0123456789abcdef';

// ------------------------------------------------------------ mock Entra ID
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig' };
const codes = new Map();
let idp, idpBase, nextIdentity = {}, tamper = {};

const sign = (claims) => {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
};

function startIdp() {
  idp = http.createServer(async (req, res) => {
    const url = new URL(req.url, idpBase);
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === `/${TENANT}/v2.0/.well-known/openid-configuration`) {
      return json(200, {
        issuer: `${idpBase}/${TENANT}/v2.0`,
        authorization_endpoint: `${idpBase}/${TENANT}/oauth2/v2.0/authorize`,
        token_endpoint: `${idpBase}/${TENANT}/oauth2/v2.0/token`,
        jwks_uri: `${idpBase}/keys`,
      });
    }
    if (url.pathname === '/keys') return json(200, { keys: [jwk] });
    if (url.pathname.endsWith('/token') && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const f = new URLSearchParams(body);
      const c = codes.get(f.get('code'));
      if (!c || f.get('client_secret') !== 'test-secret' || f.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant' });
      const challenge = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
      if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: `${idpBase}/${TENANT}/v2.0`, aud: CLIENT_ID, tid: TENANT, iat: now, nbf: now, exp: now + 3600,
        nonce: c.nonce, ...c.identity, ...tamper,
      };
      return json(200, { id_token: sign(claims), token_type: 'Bearer' });
    }
    if (url.pathname === '/null') return json(404, {});
    json(404, { error: 'not found' });
  });
  return new Promise((r) => idp.listen(0, '127.0.0.1', () => { idpBase = `http://127.0.0.1:${idp.address().port}`; r(); }));
}

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
  async login(email, password) { return this.post('/api/auth/login', { email, password }); }
}

/** Plays the browser part of the Microsoft redirect dance. */
async function microsoftSignIn(client, identity, { returnTo = '/#/runs' } = {}) {
  const start = await client.get(`/auth/microsoft/login?returnTo=${encodeURIComponent(returnTo)}`);
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'), base);
  if (!loc.href.startsWith(idpBase)) return { status: 302, location: loc.href };
  const q = loc.searchParams;
  assert.equal(q.get('client_id'), CLIENT_ID);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('state') && q.get('nonce'));
  const code = crypto.randomBytes(8).toString('hex');
  codes.set(code, { nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), identity });
  const cb = new URL(q.get('redirect_uri'));
  const done = await client.get(`${cb.pathname}?code=${code}&state=${encodeURIComponent(q.get('state'))}`);
  return { status: done.status, location: done.headers.get('location'), state: q.get('state'), code };
}

before(async () => {
  await startIdp();
  Object.assign(process.env, {
    DATA_DIR: tmp, LOG_LEVEL: 'error', API_TOKEN, MS_AUTHORITY_HOST: idpBase, LOGIN_MAX_ATTEMPTS: '3',
    NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false', MS_CLIENT_ID: '', MS_CLIENT_SECRET: '', MS_TENANT_ID: '', PUBLIC_URL: '',
  });
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); idp?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

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
  assert.ok(temp && temp.length >= 16);
  r = await admin.post('/api/admin/users', { email: 'vi@contoso.com', role: 'viewer', password: 'Viewer-Pass-77' });
  viewerId = r.json.user.id;
  assert.equal(r.json.tempPassword, null);
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

  r = await viewer.login('vi@contoso.com', 'Viewer-Pass-77');
  assert.equal(r.json.user.must_change_password, true, 'admin-chosen passwords must be changed too');
  r = await viewer.post('/api/auth/password', { next: 'Viewer-Pass-77' });
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
  assert.equal((await editor.put('/api/admin/settings', { localLogin: false })).status, 403);
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
  r = await admin.put('/api/admin/settings', { localLogin: false });
  assert.equal(r.status, 400, 'cannot disable passwords before Microsoft sign-in works');
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

test('Microsoft sign-in: config validation, auto-provisioning, linking and token checks', async () => {
  let r = await admin.put('/api/admin/settings', { microsoft: { enabled: true, tenant: 'organizations', clientId: CLIENT_ID, clientSecret: 'test-secret' } });
  assert.equal(r.status, 200);
  assert.match(r.json.microsoft.problem, /allowed tenant/);
  assert.equal(r.json.microsoft.clientSecret, undefined, 'secret is never returned');
  assert.equal(r.json.microsoft.hasSecret, true);
  assert.equal((await new Client().get('/api/auth/config')).json.microsoft.enabled, false);

  r = await admin.put('/api/admin/settings', { microsoft: { tenant: TENANT, allowedDomains: 'contoso.com, fabrikam.com', defaultRole: 'viewer', autoProvision: true } });
  assert.equal(r.json.microsoft.problem, null);
  assert.deepEqual(r.json.microsoft.allowedDomains, ['contoso.com', 'fabrikam.com']);
  assert.equal(r.json.redirectUri, `${base}/auth/microsoft/callback`);
  r = await admin.post('/api/admin/settings/microsoft/test', {});
  assert.equal(r.json.issuer, `${idpBase}/${TENANT}/v2.0`);
  assert.equal((await new Client().get('/api/auth/config')).json.microsoft.enabled, true);

  // New person → auto-provisioned as viewer.
  const ms = new Client();
  let s = await microsoftSignIn(ms, { oid: 'oid-mia', name: 'Mia Microsoft', preferred_username: 'Mia@Contoso.com' });
  assert.equal(s.status, 302);
  assert.equal(s.location, '/#/runs');
  r = await ms.get('/api/auth/me');
  assert.equal(r.json.user.email, 'mia@contoso.com');
  assert.equal(r.json.user.role, 'viewer');
  assert.equal(r.json.user.provider, 'microsoft');

  // Same object id again → same account, even if the UPN changed.
  const ms2 = new Client();
  await microsoftSignIn(ms2, { oid: 'oid-mia', name: 'Mia M', preferred_username: 'mia.m@contoso.com' });
  assert.equal((await ms2.get('/api/auth/me')).json.user.id, r.json.user.id);

  // Existing local user → linked by email, keeps their role.
  const edMs = new Client();
  await microsoftSignIn(edMs, { oid: 'oid-ed', name: 'Ed', email: 'ed@contoso.com' });
  const edMe = (await edMs.get('/api/auth/me')).json.user;
  assert.equal(edMe.id, editorId);
  assert.equal(edMe.role, 'editor');
  // ...and a different Microsoft account can't take it over afterwards.
  s = await microsoftSignIn(new Client(), { oid: 'oid-impostor', email: 'ed@contoso.com' });
  assert.match(decodeURIComponent(s.location), /already linked to a different Microsoft account/);

  // Domain not allowed.
  s = await microsoftSignIn(new Client(), { oid: 'oid-x', preferred_username: 'x@gmail.com' });
  assert.match(decodeURIComponent(s.location), /#\/login\?error=.*gmail\.com are not allowed/);

  // Tampered tokens are rejected.
  for (const [patch, why] of [[{ aud: 'someone-else' }, /audience/], [{ iss: 'https://evil/v2.0' }, /issuer/], [{ exp: 1000 }, /expired/], [{ nonce: 'replayed' }, /nonce/]]) {
    tamper = patch;
    s = await microsoftSignIn(new Client(), { oid: 'oid-t', preferred_username: 't@contoso.com' });
    assert.match(decodeURIComponent(s.location), why, JSON.stringify(patch));
  }
  tamper = {};

  // A callback can't be replayed and forged states are refused.
  const c = new Client();
  r = await c.get('/auth/microsoft/callback?code=abc&state=forged');
  assert.match(decodeURIComponent(r.headers.get('location')), /expired or was already used/);

  // Open-redirect protection on returnTo.
  s = await microsoftSignIn(new Client(), { oid: 'oid-r', preferred_username: 'r@contoso.com' }, { returnTo: 'https://evil.example/' });
  assert.equal(s.location, '/');

  // Invite-only mode.
  await admin.put('/api/admin/settings', { microsoft: { autoProvision: false } });
  s = await microsoftSignIn(new Client(), { oid: 'oid-new', preferred_username: 'newbie@contoso.com' });
  assert.match(decodeURIComponent(s.location), /Ask an administrator to add you/);

  // Now that an admin could sign in with Microsoft, password sign-in can be turned off.
  r = await admin.put('/api/admin/settings', { localLogin: false });
  assert.equal(r.status, 400, 'no admin has used Microsoft yet');
  const adminMs = new Client();
  await microsoftSignIn(adminMs, { oid: 'oid-ada', email: 'admin@contoso.com' });
  r = await admin.put('/api/admin/settings', { localLogin: false });
  assert.equal(r.status, 200);
  r = await new Client().login('ed@contoso.com', 'Editor-Pass-2026');
  assert.equal(r.status, 403);
  await admin.put('/api/admin/settings', { localLogin: true });
});

test('audit log records who did what', async () => {
  const r = await admin.get('/api/admin/audit?limit=500');
  const actions = r.json.rows.map((x) => `${x.action}|${x.user_email || ''}`);
  for (const want of ['setup.first_admin|admin@contoso.com', 'login.success|ed@contoso.com', 'login.failed|vi@contoso.com',
    'login.blocked|vi@contoso.com', 'user.create|admin@contoso.com', 'report.create|ed@contoso.com', 'user.auto_provision|mia@contoso.com',
    'user.link_microsoft|ed@contoso.com', 'settings.update|admin@contoso.com', 'account.change_password|ed@contoso.com']) {
    assert.ok(actions.includes(want), `missing audit entry ${want}`);
  }
  const create = r.json.rows.find((x) => x.action === 'user.create');
  assert.match(create.target, /@contoso\.com/);
  const settings = r.json.rows.find((x) => x.action === 'settings.update');
  assert.ok(!JSON.stringify(settings).includes('test-secret'), 'secrets never logged');
  const failed = await admin.get('/api/admin/audit?failed=1');
  assert.ok(failed.json.rows.every((x) => x.status >= 400 || /failed|blocked/.test(x.action)));
  const sys = await admin.get('/api/admin/system');
  assert.equal(sys.json.counts.admins, 1);
  assert.ok(sys.json.counts.users >= 4);
});
