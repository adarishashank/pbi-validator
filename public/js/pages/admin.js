import { html, useState, useEffect, useStore, useApi, api, setStore, go, fmtAgo, fmtDate, toast, copyText } from '../lib.js';
import { Modal, Field, Check, act, confirmDialog, CopyBox, Empty, Spinner } from '../ui.js';
import { Topbar } from './common.js';
import { RoleBadge, SessionsTable } from './account.js';
import { ResultsSiteSettings } from './publish.js';

const TABS = [['users', 'Users'], ['settings', 'Settings'], ['audit', 'Audit log'], ['system', 'System']];
const fmtBytes = (b) => (b == null ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
const fmtUptime = (s) => (s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`);

// ===================================================================== users
function RolePicker({ value, onChange, roleInfo }) {
  return html`<div class="stack" style="gap:6px">${['viewer', 'editor', 'admin'].map((r) => html`
    <label class="check"><input type="radio" name="role" checked=${value === r} onChange=${() => onChange(r)} />
      <div><b style="text-transform:capitalize">${r}</b><span>${roleInfo?.[r]}</span></div></label>`)}</div>`;
}

/** Plain-text sign-in instructions an admin can paste into an email or chat. */
export function inviteText({ user, tempPassword, expiresAt, signInUrl }, reset = false) {
  return [
    `Hi${user.name ? ` ${user.name.split(' ')[0]}` : ''},`,
    '',
    reset ? 'Your PBI Report Test password has been reset.' : 'An account has been created for you on PBI Report Test (Power BI report testing).',
    '',
    `Sign in at:          ${signInUrl}`,
    `Email:               ${user.email}`,
    `Temporary password:  ${tempPassword}`,
    '',
    `The temporary password works until ${fmtDate(expiresAt)}. You'll be asked to choose your own password when you sign in.`,
  ].join('\n');
}

function TempPasswordModal({ result, reset }) {
  const close = () => setStore({ modal: null });
  const text = inviteText(result, reset);
  return html`<${Modal} title=${reset ? 'New temporary password' : 'User added'} onClose=${close}
    footer=${html`<button class="btn" onClick=${() => copyText(text, 'Sign-in instructions copied')}>Copy sign-in instructions</button><button class="btn primary" onClick=${close}>Done</button>`}>
    <div class="stack">
      <div class="callout ok">✔ <div>${reset ? html`A new temporary password was generated for <b>${result.user.email}</b>. Their old password no longer works and they were signed out everywhere.`
        : html`<b>${result.user.email}</b> can now sign in as ${result.user.role === 'admin' ? 'an' : 'a'} <b>${result.user.role}</b>.`}</div></div>
      <div><div class="small muted" style="margin-bottom:6px">Temporary password (generated automatically)</div><${CopyBox} value=${result.tempPassword} /></div>
      <dl class="kv">
        <dt>Sign-in page</dt><dd class="mono">${result.signInUrl}</dd>
        <dt>Expires</dt><dd>${fmtDate(result.expiresAt)} <span class="muted small">(${result.validHours} hours)</span></dd>
        <dt>First sign-in</dt><dd>They must choose their own password</dd>
      </dl>
      <details><summary class="small muted">Preview the sign-in instructions</summary><pre class="json" style="white-space:pre-wrap">${text}</pre></details>
      <div class="callout warn small">⚠ <div>Share it through a trusted channel (Teams chat, phone). It is shown only now; if it's lost, generate a new one from Users.</div></div>
    </div></${Modal}>`;
}

function NewUserModal({ onDone, roleInfo }) {
  const s = useStore();
  const [f, setF] = useState({ email: '', name: '', role: 'viewer' });
  const hours = s.authConfig?.tempPasswordHours || 72;
  const save = async () => {
    const r = await act(() => api('/admin/users', { method: 'POST', body: f }), `${f.email} added`);
    if (!r) return;
    onDone();
    setStore({ modal: html`<${TempPasswordModal} result=${r} />` });
  };
  return html`<${Modal} title="Add user" onClose=${() => setStore({ modal: null })}
    footer=${html`<button class="btn" onClick=${() => setStore({ modal: null })}>Cancel</button><button class="btn primary" disabled=${!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())} onClick=${save}>Add user and generate password</button>`}>
    <div class="form-grid">
      <${Field} label="Work email" hint="They sign in with this."><input type="email" autofocus value=${f.email} onInput=${(e) => setF({ ...f, email: e.target.value })} placeholder="name@company.com" /></${Field}>
      <${Field} label="Name" hint="Optional"><input type="text" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /></${Field}>
      <${Field} label="Role" full><${RolePicker} value=${f.role} onChange=${(role) => setF({ ...f, role })} roleInfo=${roleInfo} /></${Field}>
      <div class="full callout info">🔑 <div>A <b>temporary password is generated automatically</b> when you add the user. It's valid for ${hours} hours, and they choose their own password at first sign-in.</div></div>
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
        <dt>Password</dt><dd>${!user.has_password ? 'Not set: generate a temporary password from the Users list' : user.temp_password_expired ? 'Temporary password expired' : user.must_change_password ? `Temporary password, valid until ${fmtDate(user.temp_password_expires_at)}` : 'Chosen by the user'}</dd>
        <dt>Last sign-in</dt><dd>${user.last_login_at ? `${fmtDate(user.last_login_at)} (${fmtAgo(user.last_login_at)})` : 'Never'}</dd>
        <dt>Created</dt><dd>${fmtDate(user.created_at)}</dd>
        <dt>Runs started</dt><dd>${user.runs_started}</dd>
        <dt>API keys</dt><dd>${user.api_keys}</dd>
      </dl>
      <div><h3 style="margin-bottom:8px">Active sessions</h3><div class="panel"><${SessionsTable} sessions=${sessions.data} /></div></div>
    </div></${Modal}>`;
}

function UserStatus({ u }) {
  if (u.disabled) return html`<span class="badge b-error">Disabled</span>`;
  if (!u.has_password) return html`<span class="badge b-warn" title="Generate a temporary password so they can sign in">No password</span>`;
  if (u.temp_password_expired) return html`<span class="badge b-error" title="Generate a new temporary password">Temp password expired</span>`;
  if (u.must_change_password) {
    return html`<span class="badge b-warn" title=${u.temp_password_expires_at ? `Temporary password valid until ${fmtDate(u.temp_password_expires_at)}` : 'Must choose a new password at next sign-in'}>Invited</span>
      ${u.temp_password_expires_at && html`<div class="small muted">expires ${fmtIn(u.temp_password_expires_at)}</div>`}`;
  }
  return html`<span class="badge b-pass">Active</span>`;
}
const fmtIn = (iso) => {
  const h = Math.round((Date.parse(iso) - Date.now()) / 3600e3);
  return h <= 0 ? 'within the hour' : h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)} days`;
};

function Users({ me, roleInfo }) {
  const { data, reload } = useApi('/admin/users');
  const [filter, setFilter] = useState('');
  const [role, setRole] = useState('');
  const list = (data || []).filter((u) => (!role || u.role === role) && (!filter || `${u.email} ${u.name}`.toLowerCase().includes(filter.toLowerCase())));
  const open = (u) => setStore({ modal: html`<${EditUserModal} user=${u} me=${me} onDone=${reload} roleInfo=${roleInfo} />` });
  const reset = async (u) => {
    if (!await confirmDialog({ title: 'Generate a new temporary password?', message: `A new temporary password is generated for ${u.email}. Their current password stops working and they are signed out everywhere.`, okLabel: 'Generate password' })) return;
    const r = await act(() => api(`/admin/users/${u.id}/reset-password`, { method: 'POST' }));
    if (r) { setStore({ modal: html`<${TempPasswordModal} result=${r} reset />` }); reload(); }
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
      <button class="btn primary" onClick=${() => setStore({ modal: html`<${NewUserModal} onDone=${reload} roleInfo=${roleInfo} />` })}>+ Add user</button>
    </div>
    <div class="panel">${!data ? html`<div class="panel-b"><${Spinner} /></div>` : list.length === 0 ? html`<${Empty} title="No matching users" />` : html`
      <table class="t"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Sessions</th><th></th></tr></thead><tbody>
        ${list.map((u) => html`<tr class=${u.disabled ? 'dim' : ''}>
          <td><a href="#" onClick=${(e) => { e.preventDefault(); open(u); }}><b>${u.name || u.email}</b></a>${u.id === me.id && html` <span class="tag">you</span>`}
            ${u.name && html`<div class="small muted">${u.email}</div>`}</td>
          <td><${RoleBadge} role=${u.role} /></td>
          <td><${UserStatus} u=${u} /></td>
          <td class="muted">${u.last_login_at ? fmtAgo(u.last_login_at) : 'Never'}</td>
          <td class="muted">${u.active_sessions}</td>
          <td style="text-align:right"><div class="row" style="justify-content:flex-end">
            <button class="btn sm" onClick=${() => open(u)}>Edit</button>
            <button class="btn sm ${u.temp_password_expired || !u.has_password ? '' : 'ghost'}" onClick=${() => reset(u)}>${u.must_change_password || !u.has_password ? 'New temporary password' : 'Reset password'}</button>
            ${u.active_sessions > 0 && html`<button class="btn sm ghost" onClick=${() => signOutAll(u)}>Sign out</button>`}
            ${u.id !== me.id && html`<button class="btn sm ghost" onClick=${() => toggle(u)}>${u.disabled ? 'Enable' : 'Disable'}</button>
              <button class="btn sm ghost danger" onClick=${() => del(u)}>Delete</button>`}
          </div></td></tr>`)}
      </tbody></table>`}</div>
  </div>`;
}

// ================================================================= settings
function Settings() {
  const { data, reload } = useApi('/admin/settings');
  const sys = useApi('/admin/system');
  const [publicUrl, setPublicUrl] = useState(null);
  useEffect(() => { if (data) setPublicUrl(data.publicUrl); }, [data]);
  if (!data || publicUrl === null) return html`<${Spinner} />`;
  const save = async () => {
    const r = await act(() => api('/admin/settings', { method: 'PUT', body: { publicUrl: publicUrl.trim() } }), 'Settings saved');
    if (r) reload();
  };
  const st = sys.data?.settings;
  return html`<div class="stack">
    <div class="panel"><div class="panel-h"><div><h3>Web address</h3><div class="small muted">Only needed when people reach the validator through a Cloudflare tunnel, reverse proxy or custom domain.</div></div></div>
      <div class="panel-b stack">
        <${Field} label="Public URL" hint=${data.locked.publicUrl ? 'Set by PUBLIC_URL in .env' : 'The address people type, e.g. https://pbi.contoso.com. Leave empty to accept whatever address the browser used.'}>
          <input type="url" disabled=${data.locked.publicUrl} value=${publicUrl} onInput=${(e) => setPublicUrl(e.target.value)} placeholder="https://pbi.contoso.com" /></${Field}>
        ${!data.locked.publicUrl && html`<div class="row"><span class="spacer"></span><button class="btn" disabled=${publicUrl === data.publicUrl} onClick=${() => setPublicUrl(data.publicUrl)}>Discard</button>
          <button class="btn primary" disabled=${publicUrl === data.publicUrl} onClick=${save}>Save</button></div>`}
      </div></div>
    <div class="panel"><div class="panel-h"><div><h3>Sign-in security</h3><div class="small muted">Everyone signs in with email and password. Change these in <code>.env</code> and restart.</div></div></div>
      <div class="panel-b">${!st ? html`<${Spinner} />` : html`<dl class="kv">
        <dt>Passwords</dt><dd>At least ${st.passwordMinLength} characters, common passwords refused, stored as scrypt hashes <span class="muted small">(PASSWORD_MIN_LENGTH)</span></dd>
        <dt>Sessions</dt><dd>Signed out after ${st.sessionIdleHours} hours of inactivity and after ${st.sessionMaxDays} days at most <span class="muted small">(SESSION_IDLE_HOURS, SESSION_MAX_DAYS)</span></dd>
        <dt>Lockout</dt><dd>Repeated wrong passwords block that email for 15 minutes <span class="muted small">(LOGIN_MAX_ATTEMPTS)</span></dd>
        <dt>New users</dt><dd>Added by an administrator in Users. A temporary password is generated automatically, valid for ${st.tempPasswordHours} hours, and replaced by the user at first sign-in <span class="muted small">(TEMP_PASSWORD_HOURS)</span></dd>
        <dt>Locked out?</dt><dd>On the server: <code>npm run cli -- reset-password you@company.com</code></dd>
      </dl>`}</div></div>
    <${ResultsSiteSettings} />
  </div>`;
}

// ==================================================================== audit
const ACTION_GROUPS = [['', 'All actions'], ['login', 'Sign-ins'], ['user', 'User management'], ['settings', 'Settings'], ['account', 'Own account'], ['suite', 'Suites'], ['report', 'Reports'], ['profile', 'Power BI sign-ins'], ['run', 'Runs'], ['ai', 'AI']];
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
        <dt>Version</dt><dd>PBI Report Test ${data.version}</dd>
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
    settings: 'Web address and sign-in security.',
    audit: 'Who signed in and who changed what, when, and from where.',
    system: 'Health, storage and configuration of this server.',
  }[active];
  return html`
    <${Topbar} title="Admin" sub=${sub} />
    <div class="content">
      <div class="tabs">${TABS.map(([k, l]) => html`<button class=${active === k ? 'on' : ''} onClick=${() => go(`/admin/${k}`)}>${l}</button>`)}</div>
      ${active === 'users' && html`<${Users} me=${me} roleInfo=${s.me.roleInfo} />`}
      ${active === 'settings' && html`<${Settings} />`}
      ${active === 'audit' && html`<${Audit} />`}
      ${active === 'system' && html`<${System} />`}
    </div>`;
}

