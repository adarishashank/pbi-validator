/**
 * Signing in to Power BI from the website: a headless browser on the server is
 * shown as live pictures, and clicks / typing are forwarded to it. Uses a fake
 * Microsoft-style sign-in page that sets a cookie and redirects to "home".
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-remote-'));
Object.assign(process.env, {
  DATA_DIR: tmp, LOG_LEVEL: 'error', API_TOKEN: 'remote-token-0123456789',
  NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false',
  PBI_SIGNED_IN_RE: '/home$',
});

const LOGIN = `<!DOCTYPE html><html><body style="margin:0;font:16px sans-serif">
<form method="post" action="/signin">
  <input id="email" name="email" style="position:absolute;left:100px;top:100px;width:300px;height:40px">
  <input id="pw" name="pw" type="password" style="position:absolute;left:100px;top:200px;width:300px;height:40px">
  <button type="submit" style="position:absolute;left:100px;top:300px">Sign in</button>
</form></body></html>`;

let site, siteUrl, server, base, db;
const posted = [];
before(async () => {
  site = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/signin') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        posted.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(302, { Location: '/home', 'Set-Cookie': 'pbi_session=abc123; Path=/; HttpOnly' });
        res.end();
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.url === '/home' ? '<h1>Power BI home</h1>' : LOGIN);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  db = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await (await import('../src/auth/remote.js')).closeAllRemoteLogins();
  server?.close(); site?.close(); fs.rmSync(tmp, { recursive: true, force: true });
});

const api = (p, opts = {}) => fetch(base + p, { ...opts, headers: { Authorization: 'Bearer remote-token-0123456789', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const json = async (p, opts) => { const r = await api(p, opts); return { status: r.status, json: await r.json().catch(() => null) }; };
const input = (id, ev) => json(`/api/profiles/${id}/remote/input`, { method: 'POST', body: JSON.stringify(ev) });

test('an editor signs in through the live view; the session is saved to the profile', { timeout: 120_000 }, async () => {
  const id = db.insert('auth_profiles', { name: 'Contoso QA', login_url: `${siteUrl}/signin` });
  const start = await json(`/api/profiles/${id}/remote`, { method: 'POST' });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  assert.deepEqual(start.json.view, { width: 1100, height: 760 });

  const frame = await api(`/api/profiles/${id}/remote/frame`);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.equal(frame.headers.get('cache-control'), 'no-store');
  const jpg = Buffer.from(await frame.arrayBuffer());
  assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8], 'a JPEG picture of the page');

  const st = await json(`/api/profiles/${id}/remote`);
  assert.equal(st.json.status, 'waiting');
  assert.equal(st.json.host, new URL(siteUrl).host);

  assert.equal((await input(id, { type: 'key', key: 'F12' })).status, 400, 'only navigation keys are forwarded');
  await input(id, { type: 'click', x: 250, y: 120 });
  await input(id, { type: 'text', text: 'qa@contoso.com' });
  await input(id, { type: 'click', x: 250, y: 220 });
  await input(id, { type: 'text', text: 'Correct-Horse-9' });
  await input(id, { type: 'key', key: 'Enter' });

  let s;
  for (let i = 0; i < 40; i++) {
    s = (await json(`/api/profiles/${id}/remote`)).json;
    if (s.status === 'done') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(s.status, 'done', JSON.stringify(s));
  assert.deepEqual(posted.at(-1), { email: 'qa@contoso.com', pw: 'Correct-Horse-9' }, 'typed into the right fields');
  const state = JSON.parse(fs.readFileSync(path.join(tmp, 'auth', `profile-${id}.json`), 'utf8'));
  assert.ok(state.cookies.some((c) => c.name === 'pbi_session' && c.value === 'abc123'), 'session cookie saved');
  const prof = (await json('/api/profiles')).json.find((p) => p.id === id);
  assert.equal(prof.status, 'active');
  assert.equal(prof.has_session, true);

  // Typed text never reaches the audit log; starting the sign-in does.
  const audit = db.q.all('SELECT action, detail FROM audit_log').map((a) => `${a.action} ${JSON.stringify(a.detail)}`).join('\n');
  assert.match(audit, /profile\.sign_in_web/);
  assert.doesNotMatch(audit, /Correct-Horse|qa@contoso|remote\/input/);
});

test('cancel closes the browser; raw browser errors are shown as plain text', { timeout: 60_000 }, async () => {
  const id = db.insert('auth_profiles', { name: 'Fabrikam', login_url: `${siteUrl}/signin` });
  assert.equal((await json(`/api/profiles/${id}/remote`, { method: 'POST' })).status, 201);
  const c = await json(`/api/profiles/${id}/remote`, { method: 'DELETE' });
  assert.equal(c.json.status, 'cancelled');
  assert.equal((await api(`/api/profiles/${id}/remote/frame`)).status, 404);
  assert.equal((await json(`/api/profiles/${id}/remote`)).json.status, 'none');

  db.update('auth_profiles', id, { status_detail: "browserType.launch: Target page, context or browser has been closed\n╔════╗\n║ Looks like you launched a headed browser without having a XServer running. ║" });
  const p = (await json('/api/profiles')).json.find((x) => x.id === id);
  assert.match(p.status_detail, /no screen for a sign-in window/);
  assert.doesNotMatch(p.status_detail, /XServer|╔/);
});
