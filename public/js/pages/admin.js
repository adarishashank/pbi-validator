import { html, useState, useEffect, useStore, useApi, api, setStore, go, fmtAgo, fmtDate, toast } from '../lib.js';
import { Modal, Field, Check, act, confirmDialog, CopyBox, Empty, Spinner } from '../ui.js';
import { Topbar } from './common.js';
import { RoleBadge, SessionsTable } from './account.js';

const TABS = [['users', 'Users'], ['sign-in', 'Sign-in'], ['audit', 'Audit log'], ['system', 'System']];
const fmtBytes = (b) => (b == null ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
const fmtUptime = (s) => (s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`);

// ===================================================================== users
function RolePicker({ value, onChange, roleInfo }) {
  return html`<div class="stack" style="gap:6px">${['viewer', 'editor', 'admin'].map((r) => html`
    <label class="check"><input type="radio" name="role" checked=${value === r} onChange=${() => onChange(r)} />
      <div><b style="text-transform:capitalize">${r}</b><span>${roleInfo?.[r]}</span></div></label>`)}</div>`;
}

function TempPasswordModal({ title, email, password }) {
  return html`<${Modal} title=${title} onClose=${() => setStore({ modal: null })} footer=${html`<button class="btn primary" onClick=${() => setStore({ modal: null })}>Done</button>`}>
    <div class="stack">
      <p style="margin:0">Give this one-time password to <b>${email}</b> through a trusted channel. They'll choose their own password when they first sign in.</p>
      <${CopyBox} value=${password} />
      <p class="small muted" style="margin:0">Sign-in page: <code>${location.origin}</code>. This password won't be shown again.</p>
    </div></${Modal}>`;
}

function NewUserModal({ onDone, roleInfo, msEnabled }) {
  const [f, setF] = useState({ email: '', name: '', role: 'viewer', provider: msEnabled ? 'microsoft' : 'local', password: '', setPw: false });
  const save = async () => {
    const body = { email: f.email, name: f.name, role: f.role, provider: f.provider, password: f.provider === 'local' && f.setPw ? f.password : '' };
    const r = await act(() => api('/admin/users', { method: 'POST', body }), `${f.email} added`);
    if (!r) return;
    onDone();
    if (r.tempPassword) setStore({ modal: html`<${TempPasswordModal} title="User added" email=${r.user.email} password=${r.tempPassword} />` });
    else setStore({ modal: null });
  };
  return html`<${Modal} title="Add user" onClose=${() => setStore({ modal: null })}
    footer=${html`<button class="btn" onClick=${() => setStore({ modal: null })}>Cancel</button><button class="btn primary" disabled=${!f.email} onClick=${save}>Add user</button>`}>
    <div class="form-grid">
      <${Field} label="Work email"><input type="email" autofocus value=${f.email} onInput=${(e) => setF({ ...f, email: e.target.value })} placeholder="name@company.com" /></${Field}>
      <${Field} label="Name" hint="Optional"><input type="text" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /></${Field}>
      <${Field} label="Signs in with" full><div class="btn-group">
        <button type="button" class="btn ${f.provider === 'microsoft' ? 'on' : ''}" onClick=${() => setF({ ...f, provider: 'microsoft' })}>Microsoft account</button>
        <button type="button" class="btn ${f.provider === 'local' ? 'on' : ''}" onClick=${() => setF({ ...f, provider: 'local' })}>Email + password</button></div></${Field}>
      ${f.provider === 'microsoft' && html`<div class="full callout info">ℹ <div>They'll sign in with “Sign in with Microsoft” using this email; their account is linked at first sign-in.${!msEnabled ? html` <b>Microsoft sign-in isn't set up yet</b>: see the Sign-in tab.` : ''}</div></div>`}
      ${f.provider === 'local' && html`<div class="full stack" style="gap:8px">
        <${Check} label="Set the password myself" desc="Otherwise a one-time password is generated for you to share. Either way they must change it at first sign-in." checked=${f.setPw} onChange=${(v) => setF({ ...f, setPw: v })} />
        ${f.setPw && html`<input type="password" autocomplete="new-password" placeholder="Initial password" value=${f.password} onInput=${(e) => setF({ ...f, password: e.target.value })} />`}</div>`}
      <${Field} label="Role" full><${RolePicker} value=${f.role} onChange=${(role) => setF({ ...f, role })} roleInfo=${roleInfo} /></${Field}>
    </div></${Modal}>`;
}

function EditUserModal({ user, me, onDone, roleInfo }) {
  const [f, setF] = useState({ name: user.name || '', role: user.role, disabled: user.disabled });
  const sessions = useApi(`/admin/users/${user.id}/sessions`);
  const self = user.id === me.id;
  const save = async () => {
    const r = await act(() => api(`/admin/users/${user.id}`, { method: 'PUT', body: f }), 'User updated');
    if (r) { setStore({ modal: null }); onDone(); }
  };
  return html`<${Modal} title=${user.email} size="wide" onClose=${() => setStore({ modal: null })}
    footer=${html`<button class="btn" onClick=${() => setStore({ modal: null })}>Cancel</button><button class="btn primary" onClick=${save}>Save changes</button>`}>
    <div class="stack">
      ${self && html`<div class="callout info">ℹ <div>This is your account. Another administrator has to change your role or disable you.</div></div>`}
      <div class="form-grid">
        <${Field} label="Name"><input type="text" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /></${Field}>
        <${Field} label="Status"><${Check} label="Disabled" desc="Blocks sign-in, ends their sessions and deletes their API keys." checked=${f.disabled} onChange=${(v) => !self && setF({ ...f, disabled: v })} /></${Field}>
        <${Field} label="Role" full>${self ? html`<div><${RoleBadge} role=${user.role} /></div>` : html`<${RolePicker} value=${f.role} onChange=${(role) => setF({ ...f, role })} roleInfo=${roleInfo} />`}</${Field}>
      </div>
      <dl class="kv">
        <dt>Sign-in methods</dt><dd>${[user.ms_oid && 'Microsoft (linked)', user.provider === 'microsoft' && !user.ms_oid && 'Microsoft (not signed in yet)', user.has_password && 'Password'].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Last sign-in</dt><dd>${user.last_login_at ? `${fmtDate(user.last_login_at)} (${fmtAgo(user.last_login_at)})` : 'Never'}</dd>
        <dt>Created</dt><dd>${fmtDate(user.created_at)}</dd>
        <dt>Runs started</dt><dd>${user.runs_started}</dd>
        <dt>API keys</dt><dd>${user.api_keys}</dd>
      </dl>
      <div><h3 style="margin-bottom:8px">Active sessions</h3><div class="panel"><${SessionsTable} sessions=${sessions.data} /></div></div>
    </div></${Modal}>`;
}

function Users({ me, roleInfo, msEnabled }) {
  const { data, reload } = useApi('/admin/users');
  const [filter, setFilter] = useState('');
  const [role, setRole] = useState('');
  const list = (data || []).filter((u) => (!role || u.role === role) && (!filter || `${u.email} ${u.name}`.toLowerCase().includes(filter.toLowerCase())));
  const open = (u) => setStore({ modal: html`<${EditUserModal} user=${u} me=${me} onDone=${reload} roleInfo=${roleInfo} />` });
  const reset = async (u) => {
    if (!await confirmDialog({ title: 'Reset password?', message: `Generate a one-time password for ${u.email}? Their current password stops working and all their sessions are signed out.`, okLabel: 'Reset password' })) return;
    const r = await act(() => api(`/admin/users/${u.id}/reset-password`, { method: 'POST' }));
    if (r) { setStore({ modal: html`<${TempPasswordModal} title="Password reset" email=${u.email} password=${r.tempPassword} />` }); reload(); }
  };
  const signOutAll = async (u) => {
    const r = await act(() => api(`/admin/users/${u.id}/sessions`, { method: 'DELETE' }));
    if (r) toast(`${u.email}: ${r.revoked} session(s) signed out`, 'ok');
    reload();
  };
  const toggle = async (u) => { await act(() => api(`/admin/users/${u.id}`, { method: 'PUT', body: { disabled: !u.disabled } }), u.disabled ? 'User enabled' : 'User disabled'); reload(); };
  const del = async (u) => {
    if (!await confirmDialog({ title: 'Delete user?', message: `Permanently delete ${u.email}? Their sessions and API keys are removed. Runs they started are kept. To block access but keep the account, disable it instead.`, okLabel: 'Delete user', danger: true })) return;
    await act(() => api(`/admin/users/${u.id}`, { method: 'DELETE' }), 'User deleted');
    reload();
  };
  const counts = { all: (data || []).length, admin: 0, editor: 0, viewer: 0 };
  (data || []).forEach((u) => { counts[u.role] += 1; });
  return html`<div class="stack">
    <div class="row">
      <input type="search" style="max-width:300px" placeholder="Search name or email" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
      ${[['', 'All', counts.all], ['admin', 'Admins', counts.admin], ['editor', 'Editors', counts.editor], ['viewer', 'Viewers', counts.viewer]].map(([r, l, n]) => html`
        <span class="chip ${role === r ? 'on' : ''}" onClick=${() => setRole(r)}>${l} <span class="n">${n}</span></span>`)}
      <span class="spacer"></span>
      <button class="btn primary" onClick=${() => setStore({ modal: html`<${NewUserModal} onDone=${reload} roleInfo=${roleInfo} msEnabled=${msEnabled} />` })}>+ Add user</button>
    </div>
    <div class="panel">${!data ? html`<div class="panel-b"><${Spinner} /></div>` : list.length === 0 ? html`<${Empty} title="No matching users" />` : html`
      <table class="t"><thead><tr><th>User</th><th>Role</th><th>Sign-in</th><th>Status</th><th>Last sign-in</th><th>Sessions</th><th></th></tr></thead><tbody>
        ${list.map((u) => html`<tr class=${u.disabled ? 'dim' : ''}>
          <td><a href="#" onClick=${(e) => { e.preventDefault(); open(u); }}><b>${u.name || u.email}</b></a>${u.id === me.id && html` <span class="tag">you</span>`}
            ${u.name && html`<div class="small muted">${u.email}</div>`}</td>
          <td><${RoleBadge} role=${u.role} /></td>
          <td class="small">${u.ms_oid ? html`<span title="Linked Microsoft account">Microsoft ✓</span>` : u.provider === 'microsoft' ? html`<span class="muted" title="Will be linked at first sign-in">Microsoft (pending)</span>` : 'Password'}</td>
          <td>${u.disabled ? html`<span class="badge b-error">Disabled</span>` : u.must_change_password ? html`<span class="badge b-warn" title="Must choose a new password at next sign-in">Pending password</span>` : html`<span class="badge b-pass">Active</span>`}</td>
          <td class="muted">${u.last_login_at ? fmtAgo(u.last_login_at) : 'Never'}</td>
          <td class="muted">${u.active_sessions}</td>
          <td style="text-align:right"><div class="row" style="justify-content:flex-end">
            <button class="btn sm" onClick=${() => open(u)}>Edit</button>
            ${u.has_password || u.provider === 'local' ? html`<button class="btn sm ghost" onClick=${() => reset(u)}>Reset password</button>` : ''}
            ${u.active_sessions > 0 && html`<button class="btn sm ghost" onClick=${() => signOutAll(u)}>Sign out</button>`}
            ${u.id !== me.id && html`<button class="btn sm ghost" onClick=${() => toggle(u)}>${u.disabled ? 'Enable' : 'Disable'}</button>
              <button class="btn sm ghost danger" onClick=${() => del(u)}>Delete</button>`}
          </div></td></tr>`)}
      </tbody></table>`}</div>
  </div>`;
}

// ================================================================== sign-in
function SignIn() {
  const { data, reload } = useApi('/admin/settings');
  const [f, setF] = useState(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (!data) return;
    const m = data.microsoft;
    setF({
      localLogin: data.localLogin, publicUrl: data.publicUrl,
      ms: { enabled: m.enabled, tenant: m.tenant, clientId: m.clientId, clientSecret: '', buttonLabel: m.buttonLabel, allowedDomains: m.allowedDomains.join(', '), allowedTenants: m.allowedTenants.join(', '), autoProvision: m.autoProvision, defaultRole: m.defaultRole },
    });
  }, [data]);
  if (!data || !f) return html`<${Spinner} />`;
  const L = data.locked;
  const setMs = (k, v) => setF({ ...f, ms: { ...f.ms, [k]: v } });
  const inp = (k, props = {}) => html`<input type="text" value=${f.ms[k]} disabled=${L[k]} onInput=${(e) => setMs(k, e.target.value)} ...${props} />`;
  const save = async () => {
    const body = { localLogin: f.localLogin, microsoft: { ...f.ms } };
    if (!L.publicUrl) body.publicUrl = f.publicUrl.trim();
    for (const k of ['tenant', 'clientId', 'clientSecret']) if (L[k]) delete body.microsoft[k];
    const r = await act(() => api('/admin/settings', { method: 'PUT', body }), 'Sign-in settings saved');
    if (r) reload();
  };
  const test = async () => {
    setTesting(true);
    const r = await act(() => api('/admin/settings/microsoft/test', { method: 'POST', body: { tenant: f.ms.tenant } }));
    setTesting(false);
    if (r) toast(`Tenant found: ${r.issuer}`, 'ok');
  };
  const clearSecret = async () => {
    if (!await confirmDialog({ title: 'Remove client secret?', message: 'Microsoft sign-in stops working until a new secret is saved.', okLabel: 'Remove', danger: true })) return;
    await act(() => api('/admin/settings', { method: 'PUT', body: { microsoft: { clearSecret: true } } }), 'Secret removed');
    reload();
  };
  const envHint = (k, name) => (L[k] ? `Set by ${name} in .env` : undefined);
  const problem = data.microsoft.problem;
  return html`<div class="stack">
    <div class="panel"><div class="panel-h"><div><h3>Microsoft sign-in (Entra ID)</h3><div class="small muted">Single sign-on with your organisation's Microsoft accounts, including MFA and conditional-access policies.</div></div>
      ${data.microsoft.enabled && !problem ? html`<span class="badge b-pass">Active</span>` : html`<span class="badge b-skipped">${data.microsoft.enabled ? 'Incomplete' : 'Off'}</span>`}</div>
      <div class="panel-b stack">
        ${data.microsoft.enabled && problem && html`<div class="callout warn">⚠ <div>${problem}</div></div>`}
        ${f.ms.enabled !== data.microsoft.enabled && html`<div class="callout info">ℹ <div>Save to apply.</div></div>`}
        <details class="guide" open=${!data.microsoft.clientId}>
          <summary><b>How to set up (5 minutes, free)</b></summary>
          <ol>
            <li>In the <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra admin center</a> open <b>App registrations → New registration</b>.</li>
            <li>Name it “PBI Validator”, choose <b>Accounts in this organizational directory only</b>, and under Redirect URI pick <b>Web</b> and paste:<${CopyBox} value=${data.redirectUri} /></li>
            <li>On the app's <b>Overview</b> page copy the <b>Application (client) ID</b> and <b>Directory (tenant) ID</b> into the fields below.</li>
            <li>Open <b>Certificates & secrets → New client secret</b>, copy its <b>Value</b> (not the Secret ID) into “Client secret”. Note the expiry date and renew it before then.</li>
            <li>Save, then sign in with Microsoft once from a private window to check it.</li>
          </ol>
          <p class="small muted">Serving through a Cloudflare tunnel or a custom domain? Set the <b>Public URL</b> below first so the redirect URI matches what people type in the browser. Every address you use must be registered in Entra.</p>
        </details>
        <${Check} label="Enable Microsoft sign-in" desc="Shows “Sign in with Microsoft” on the sign-in page." checked=${f.ms.enabled} onChange=${(v) => setMs('enabled', v)} />
        <div class="form-grid">
          <${Field} label="Directory (tenant) ID" hint=${envHint('tenant', 'MS_TENANT_ID') || 'GUID or primary domain, e.g. contoso.onmicrosoft.com'}>
            <div class="row" style="flex-wrap:nowrap">${inp('tenant', { placeholder: '00000000-0000-0000-0000-000000000000' })}<button class="btn" disabled=${!f.ms.tenant || testing} onClick=${test}>${testing ? 'Testing…' : 'Test'}</button></div></${Field}>
          <${Field} label="Application (client) ID" hint=${envHint('clientId', 'MS_CLIENT_ID')}>${inp('clientId', { placeholder: '00000000-0000-0000-0000-000000000000' })}</${Field}>
          <${Field} label="Client secret" hint=${envHint('clientSecret', 'MS_CLIENT_SECRET') || (data.microsoft.hasSecret ? 'A secret is saved. Leave empty to keep it.' : 'Stored on the server only; never shown again.')}>
            <div class="row" style="flex-wrap:nowrap"><input type="password" autocomplete="off" disabled=${L.clientSecret} placeholder=${data.microsoft.hasSecret ? '•••••••• (saved)' : 'Secret value'} value=${f.ms.clientSecret} onInput=${(e) => setMs('clientSecret', e.target.value)} />
            ${data.microsoft.hasSecret && !L.clientSecret && html`<button class="btn ghost danger" onClick=${clearSecret}>Remove</button>`}</div></${Field}>
          <${Field} label="Button text" hint="Optional">${inp('buttonLabel', { placeholder: 'Sign in with Microsoft' })}</${Field}>
          <${Field} label="Redirect URI" hint="Register exactly this in Entra (Authentication → Web)." full><${CopyBox} value=${data.redirectUri} /></${Field}>
        </div>
        <div class="fieldset"><h4>Who may sign in</h4><div class="form-grid">
          <${Field} label="Allowed email domains" hint="Comma-separated. Empty = any account in the tenant.">${inp('allowedDomains', { placeholder: 'contoso.com, contoso.co.uk' })}</${Field}>
          <${Field} label="Allowed tenant IDs" hint="Only needed for multi-tenant (“organizations”) sign-in.">${inp('allowedTenants', { placeholder: 'tenant GUIDs, comma-separated' })}</${Field}>
          <div class="full"><${Check} label="Create accounts automatically" desc="Anyone allowed above gets an account at first sign-in with the default role. Turn off for invite-only: add people in Users first." checked=${f.ms.autoProvision} onChange=${(v) => setMs('autoProvision', v)} /></div>
          ${f.ms.autoProvision && html`<${Field} label="Default role for new accounts"><select value=${f.ms.defaultRole} onChange=${(e) => setMs('defaultRole', e.target.value)}>
            <option value="viewer">Viewer (read-only)</option><option value="editor">Editor</option></select></${Field}>`}
        </div></div>
      </div></div>

    <div class="panel"><div class="panel-h"><h3>Password sign-in & address</h3></div><div class="panel-b stack">
      <${Check} label="Allow email + password sign-in" desc="Turn off to require Microsoft sign-in for everyone. An administrator must have signed in with Microsoft first." checked=${f.localLogin} onChange=${(v) => setF({ ...f, localLogin: v })} />
      <${Field} label="Public URL" hint=${L.publicUrl ? 'Set by PUBLIC_URL in .env' : 'The address people use, e.g. https://pbi.contoso.com. Used for the Microsoft redirect URI. Leave empty to use whatever address the browser used.'}>
        <input type="url" disabled=${L.publicUrl} value=${f.publicUrl} onInput=${(e) => setF({ ...f, publicUrl: e.target.value })} placeholder="https://pbi.contoso.com" /></${Field}>
    </div></div>
    <div class="row"><span class="spacer"></span><button class="btn" onClick=${reload}>Discard changes</button><button class="btn primary" onClick=${save}>Save sign-in settings</button></div>
  </div>`;
}

// ==================================================================== audit
const ACTION_GROUPS = [['', 'All actions'], ['login', 'Sign-ins'], ['user', 'User management'], ['settings', 'Settings'], ['account', 'Own account'], ['suite', 'Suites'], ['report', 'Reports'], ['profile', 'Auth profiles'], ['run', 'Runs'], ['ai', 'AI']];
const actionKind = (a) => (/failed|blocked/.test(a) ? 'fail' : /delete|revoke|disable|reset/.test(a) ? 'diff' : /login\.success|setup/.test(a) ? 'pass' : 'skipped');

function Audit() {
  const [flt, setFlt] = useState({ user: '', action: '', failed: false });
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const qs = (before) => new URLSearchParams({ limit: '100', ...(flt.user && { user: flt.user }), ...(flt.action && { action: flt.action }), ...(flt.failed && { failed: '1' }), ...(before && { before }) }).toString();
  const load = async (before) => {
    const r = await act(() => api(`/admin/audit?${qs(before)}`));
    if (!r) return;
    setRows(before ? [...(rows || []), ...r.rows] : r.rows);
    setNext(r.next);
  };
  useEffect(() => { const t = setTimeout(() => load(), 250); return () => clearTimeout(t); }, [flt.user, flt.action, flt.failed]);
  return html`<div class="stack">
    <div class="row">
      <input type="search" style="max-width:260px" placeholder="Filter by user email" value=${flt.user} onInput=${(e) => setFlt({ ...flt, user: e.target.value })} />
      <select style="width:auto" value=${flt.action} onChange=${(e) => setFlt({ ...flt, action: e.target.value })}>${ACTION_GROUPS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
      <label class="row small" style="gap:6px"><input type="checkbox" checked=${flt.failed} onChange=${(e) => setFlt({ ...flt, failed: e.target.checked })} /> Failures only</label>
      <span class="spacer"></span><button class="btn sm" onClick=${() => load()}>↻ Refresh</button>
    </div>
    <div class="panel">${!rows ? html`<div class="panel-b"><${Spinner} /></div>` : rows.length === 0 ? html`<${Empty} title="No matching events" />` : html`
      <table class="t"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>Result</th><th>IP</th><th>Details</th></tr></thead><tbody>
        ${rows.map((r) => html`<tr>
          <td class="muted small" title=${r.ts} style="white-space:nowrap">${fmtDate(r.ts)}</td>
          <td class="small">${r.user_email || html`<span class="muted">—</span>`}</td>
          <td><span class="badge b-${actionKind(r.action)}" style="text-transform:none">${r.action}</span></td>
          <td class="small">${r.target}</td>
          <td class="small ${r.status >= 400 ? 'fail-ink' : 'muted'}">${r.status}</td>
          <td class="mono">${r.ip}</td>
          <td class="small muted" style="max-width:320px">${Object.keys(r.detail || {}).length ? Object.entries(r.detail).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ') : ''}</td></tr>`)}
      </tbody></table>`}</div>
    ${next && html`<div class="row" style="justify-content:center"><button class="btn" onClick=${() => load(next)}>Load older events</button></div>`}
    <p class="small muted" style="margin:0">Every sign-in, failed attempt, and change to users, settings, reports, suites, profiles and runs is recorded with who made it, from which IP, and whether it succeeded. Passwords and secrets are never logged.</p>
  </div>`;
}

// =================================================================== system
function System() {
  const { data } = useApi('/admin/system', { poll: 15000 });
  if (!data) return html`<${Spinner} />`;
  const c = data.counts;
  const kpi = (l, v, sub, href) => html`<div class="panel kpi ${href ? 'click' : ''}" onClick=${href ? () => go(href) : undefined}><div class="l">${l}</div><div class="v">${v}</div>${sub && html`<div class="small muted">${sub}</div>`}</div>`;
  return html`<div class="stack">
    <div class="grid g4">
      ${kpi('Users', c.users, `${c.admins} admin${c.admins === 1 ? '' : 's'}`, '/admin/users')}
      ${kpi('Active sessions', c.activeSessions)}
      ${kpi('Validation runs', c.runs, `${c.suites} suites · ${c.reports} reports`, '/runs')}
      ${kpi('Failed sign-ins (24h)', c.failedLogins24h, c.failedLogins24h ? 'See Audit log' : 'None', '/admin/audit')}
    </div>
    <div class="grid g2">
      <div class="panel"><div class="panel-h"><h3>Server</h3><span class="badge ${data.queue.busy ? 'b-running' : 'b-pass'}">${data.queue.busy ? 'Run in progress' : 'Idle'}</span></div><div class="panel-b"><dl class="kv">
        <dt>Version</dt><dd>PBI Validator ${data.version}</dd>
        <dt>Runtime</dt><dd>Node.js ${data.node}</dd>
        <dt>Host</dt><dd>${data.hostname} · ${data.platform}</dd>
        <dt>Uptime</dt><dd>${fmtUptime(data.uptimeSec)}</dd>
        <dt>Memory</dt><dd>${data.memoryMb} MB</dd>
        <dt>Listening on</dt><dd class="mono">${data.settings.host}:${data.settings.port}</dd>
        <dt>Parallel runs</dt><dd>${data.queue.maxParallelRuns}</dd>
        <dt>Browser</dt><dd>${data.settings.headless ? 'Headless Chromium' : 'Visible Chromium (debug)'}</dd>
      </dl></div></div>
      <div class="panel"><div class="panel-h"><h3>Storage</h3></div><div class="panel-b"><dl class="kv">
        <dt>Data folder</dt><dd class="mono small" style="word-break:break-all">${data.dataDir}</dd>
        <dt>Database</dt><dd>${fmtBytes(data.storage.database)}</dd>
        <dt>Screenshots</dt><dd>${fmtBytes(data.storage.screenshots.bytes)} · ${data.storage.screenshots.files.toLocaleString()} files</dd>
        <dt>Discovery</dt><dd>${fmtBytes(data.storage.discovery.bytes)}</dd>
        <dt>Retention</dt><dd>${data.settings.retentionDays ? `Runs older than ${data.settings.retentionDays} days are deleted nightly` : 'Keep forever'}</dd>
      </dl></div></div>
      <div class="panel"><div class="panel-h"><h3>Security</h3></div><div class="panel-b"><dl class="kv">
        <dt>Session lifetime</dt><dd>Signed out after ${data.settings.sessionIdleHours}h idle; at most ${data.settings.sessionMaxDays} days</dd>
        <dt>Password policy</dt><dd>At least ${data.settings.passwordMinLength} characters, no common passwords; scrypt-hashed</dd>
        <dt>API_TOKEN</dt><dd>${data.settings.apiTokenSet ? 'Set: works as an admin Bearer token for scripts' : 'Not set'}</dd>
        <dt>Protection</dt><dd>HttpOnly SameSite cookies, origin checks on every change, sign-in throttling, full audit log</dd>
      </dl></div></div>
      <div class="panel"><div class="panel-h"><h3>AI analysis</h3>${data.ai.configured ? html`<span class="badge b-pass">Connected</span>` : html`<span class="badge b-skipped">Not configured</span>`}</div><div class="panel-b"><dl class="kv">
        <dt>Provider</dt><dd>${data.ai.provider || '—'}</dd>
        <dt>Text model</dt><dd class="mono">${data.ai.textModel}</dd>
        <dt>Vision model</dt><dd class="mono">${data.ai.visionModel}</dd>
        <dt>Screenshots to AI</dt><dd>${data.ai.imagesAllowed ? 'Allowed' : 'Never sent'}</dd>
      </dl>${!data.ai.configured && html`<p class="small muted">Add <code>NVIDIA_API_KEY</code> to <code>.env</code> and restart to enable.</p>`}</div></div>
    </div>
  </div>`;
}

// ===================================================================== page
export function Admin({ tab = 'users' }) {
  const s = useStore();
  const me = s.me.user;
  const active = TABS.some(([k]) => k === tab) ? tab : 'users';
  const sub = {
    users: 'Who can use the validator and what they can do.',
    'sign-in': 'How people sign in: Microsoft accounts, passwords, or both.',
    audit: 'Who signed in and who changed what, when, and from where.',
    system: 'Health, storage and configuration of this server.',
  }[active];
  return html`
    <${Topbar} title="Admin" sub=${sub} />
    <div class="content">
      <div class="tabs">${TABS.map(([k, l]) => html`<button class=${active === k ? 'on' : ''} onClick=${() => go(`/admin/${k}`)}>${l}</button>`)}</div>
      ${active === 'users' && html`<${Users} me=${me} roleInfo=${s.me.roleInfo} msEnabled=${s.authConfig?.microsoft?.enabled} />`}
      ${active === 'sign-in' && html`<${SignIn} />`}
      ${active === 'audit' && html`<${Audit} />`}
      ${active === 'system' && html`<${System} />`}
    </div>`;
}

