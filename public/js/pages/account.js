import { html, useState, useStore, useApi, api, setStore, fmtAgo, fmtDate, toast } from '../lib.js';
import { Modal, Field, act, confirmDialog, CopyBox, Empty } from '../ui.js';
import { Topbar } from './common.js';
import { PasswordForm } from './login.js';

export const RoleBadge = ({ role }) => html`<span class="badge b-role-${role}">${role}</span>`;

/** "Chrome on macOS"-style label from a user-agent string. */
export function deviceLabel(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici|python|powershell/i.test(ua) ? 'Script' : 'Browser';
  const osName = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return osName ? `${browser} on ${osName}` : browser;
}

export function SessionsTable({ sessions, onRevoke }) {
  if (!sessions?.length) return html`<p class="muted" style="margin:0">No active sessions.</p>`;
  return html`<table class="t"><thead><tr><th>Device</th><th>Signed in with</th><th>IP address</th><th>Signed in</th><th>Last active</th><th></th></tr></thead><tbody>
    ${sessions.map((x) => html`<tr>
      <td><b>${deviceLabel(x.user_agent)}</b>${x.current && html` <span class="badge b-pass">This device</span>`}</td>
      <td>${x.method === 'microsoft' ? 'Microsoft' : 'Password'}</td>
      <td class="mono">${x.ip || '—'}</td><td class="muted">${fmtDate(x.created_at)}</td><td class="muted">${fmtAgo(x.last_seen_at)}</td>
      <td style="text-align:right">${onRevoke && !x.current && html`<button class="btn sm ghost danger" onClick=${() => onRevoke(x)}>Sign out</button>`}</td></tr>`)}
  </tbody></table>`;
}

function NewKeyModal({ onDone }) {
  const [f, setF] = useState({ name: '', expiresDays: 90 });
  const [created, setCreated] = useState(null);
  const close = () => { setStore({ modal: null }); onDone(); };
  const create = async () => {
    const r = await act(() => api('/auth/api-keys', { method: 'POST', body: { name: f.name, expiresDays: Number(f.expiresDays) } }));
    if (r) setCreated(r);
  };
  if (created) {
    return html`<${Modal} title="API key created" onClose=${close} footer=${html`<button class="btn primary" onClick=${close}>Done</button>`}>
      <div class="stack">
        <div class="callout warn">⚠ <div>Copy this key now. For security it's stored only as a hash and <b>won't be shown again</b>.</div></div>
        <${CopyBox} value=${created.key} />
        <div><div class="small muted" style="margin-bottom:6px">Use it from scripts or CI as a Bearer token:</div>
          <pre class="json">curl -H "Authorization: Bearer ${created.key.slice(0, 12)}…" ${location.origin}/api/runs</pre></div>
      </div></${Modal}>`;
  }
  return html`<${Modal} title="New API key" onClose=${() => setStore({ modal: null })}
    footer=${html`<button class="btn" onClick=${() => setStore({ modal: null })}>Cancel</button><button class="btn primary" disabled=${!f.name.trim()} onClick=${create}>Create key</button>`}>
    <div class="form-grid">
      <${Field} label="Name" hint="What will use it, e.g. Azure DevOps pipeline" full><input type="text" autofocus value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /></${Field}>
      <${Field} label="Expires" full><select value=${f.expiresDays} onChange=${(e) => setF({ ...f, expiresDays: e.target.value })}>
        <option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In 1 year</option><option value="0">Never</option></select></${Field}>
      <div class="full small muted">The key acts as you, with your current role. Disabling your account revokes it.</div>
    </div></${Modal}>`;
}

export function Account() {
  const s = useStore();
  const me = s.me?.user || {};
  const sessions = useApi('/auth/sessions');
  const keys = useApi('/auth/api-keys');
  const [name, setName] = useState(me.name || '');
  const saveName = async () => {
    const r = await act(() => api('/auth/me', { method: 'PUT', body: { name } }), 'Profile saved');
    if (r) setStore({ me: { ...s.me, user: r.user } });
  };
  const revoke = async (x) => { await act(() => api(`/auth/sessions/${x.id}`, { method: 'DELETE' }), 'Session signed out'); sessions.reload(); };
  const revokeOthers = async () => {
    if (!await confirmDialog({ title: 'Sign out other devices?', message: 'Every session except this one will be signed out.', okLabel: 'Sign out others' })) return;
    const r = await act(() => api('/auth/sessions', { method: 'DELETE' }));
    if (r) toast(`${r.revoked} session(s) signed out`, 'ok');
    sessions.reload();
  };
  const delKey = async (k) => {
    if (!await confirmDialog({ title: 'Delete API key?', message: `Anything using "${k.name}" will stop working immediately.`, okLabel: 'Delete', danger: true })) return;
    await act(() => api(`/auth/api-keys/${k.id}`, { method: 'DELETE' }), 'API key deleted');
    keys.reload();
  };
  if (me.system) {
    return html`<${Topbar} title="My account" /><div class="content"><div class="callout info">You're using the shared API_TOKEN, which acts as an administrator. Sign in as a user to manage a personal account.</div></div>`;
  }
  const otherSessions = (sessions.data || []).filter((x) => !x.current).length;
  return html`
    <${Topbar} title="My account" sub="Your profile, password, signed-in devices and personal API keys." />
    <div class="content stack">
      <div class="grid g2">
        <div class="panel"><div class="panel-h"><h3>Profile</h3></div><div class="panel-b stack" style="gap:12px">
          <dl class="kv">
            <dt>Email</dt><dd><b>${me.email}</b></dd>
            <dt>Role</dt><dd><${RoleBadge} role=${me.role} /> <span class="small muted">${s.me?.roleInfo?.[me.role]}</span></dd>
            <dt>Sign-in</dt><dd>${me.ms_oid ? 'Microsoft account' : ''}${me.ms_oid && me.has_password ? ' · ' : ''}${me.has_password ? 'Password' : ''}</dd>
            <dt>Member since</dt><dd>${fmtDate(me.created_at)}</dd>
          </dl>
          <${Field} label="Display name"><div class="row" style="flex-wrap:nowrap"><input type="text" value=${name} onInput=${(e) => setName(e.target.value)} /><button class="btn" disabled=${name === (me.name || '')} onClick=${saveName}>Save</button></div></${Field}>
        </div></div>
        <div class="panel"><div class="panel-h"><h3>Password</h3></div><div class="panel-b">
          ${me.has_password
            ? html`<${PasswordForm} email=${me.email} minLength=${s.authConfig?.passwordMinLength || 10} onDone=${(r) => { toast(`Password changed${r?.otherSessionsSignedOut ? `; ${r.otherSessionsSignedOut} other session(s) signed out` : ''}`, 'ok'); sessions.reload(); }} />`
            : html`<p class="muted" style="margin:0">You sign in with your Microsoft account, so there's no password to manage here. Your organisation's Microsoft policies (MFA, password rules) apply.</p>`}
        </div></div>
      </div>

      <div class="panel"><div class="panel-h"><h3>Signed-in devices</h3>${otherSessions > 0 && html`<button class="btn sm" onClick=${revokeOthers}>Sign out all other devices</button>`}</div>
        <div class="panel-b" style="padding:0"><${SessionsTable} sessions=${sessions.data} onRevoke=${revoke} /></div></div>

      <div class="panel"><div class="panel-h"><div><h3>Personal API keys</h3><div class="small muted">For CI/CD pipelines and scripts calling the REST API as you.</div></div>
        <button class="btn sm primary" onClick=${() => setStore({ modal: html`<${NewKeyModal} onDone=${keys.reload} />` })}>+ New API key</button></div>
        ${(keys.data || []).length === 0 ? html`<${Empty} title="No API keys">Create one to call the API from a pipeline: <code>Authorization: Bearer pbiv_…</code></${Empty}>` : html`
        <table class="t"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>
          ${keys.data.map((k) => html`<tr><td><b>${k.name}</b></td><td class="mono">${k.prefix}…</td><td class="muted">${fmtDate(k.created_at)}</td>
            <td class="muted">${k.last_used_at ? fmtAgo(k.last_used_at) : 'Never'}</td>
            <td class=${k.expires_at && k.expires_at < new Date().toISOString() ? 'fail-ink' : 'muted'}>${k.expires_at ? fmtDate(k.expires_at) : 'Never'}</td>
            <td style="text-align:right"><button class="btn sm ghost danger" onClick=${() => delKey(k)}>Delete</button></td></tr>`)}
        </tbody></table>`}
      </div>
    </div>`;
}
