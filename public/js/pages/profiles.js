import { html, useApi, useState, setStore, fmtAgo, api, toast } from '../lib.js';
import { Badge, Modal, Field, act, confirmDialog, Empty, Spinner } from '../ui.js';
import { Topbar } from './common.js';

function ProfileForm({ profile, onDone }) {
  const [f, setF] = useState({ name: profile?.name || '', description: profile?.description || '', login_url: profile?.login_url || '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const r = await act(() => api(profile ? `/profiles/${profile.id}` : '/profiles', { method: profile ? 'PUT' : 'POST', body: f }), 'Profile saved');
    if (r) { setStore({ modal: null }); onDone(); }
  };
  return html`<${Modal} title=${profile ? 'Edit Power BI sign-in' : 'New Power BI sign-in'} onClose=${() => setStore({ modal: null })}
    footer=${html`<button class="btn" onClick=${() => setStore({ modal: null })}>Cancel</button><button class="btn primary" onClick=${save}>Save</button>`}>
    <div class="form-grid">
      <${Field} label="Name" full><input type="text" value=${f.name} onInput=${set('name')} placeholder="e.g. Contoso tenant · QA account" /></${Field}>
      <${Field} label="Description" full><input type="text" value=${f.description} onInput=${set('description')} /></${Field}>
      <${Field} label="Sign-in start URL" hint="Optional. Defaults to https://app.powerbi.com/home. Use your sovereign-cloud or tenant-specific URL if needed." full>
        <input type="url" value=${f.login_url} onInput=${set('login_url')} placeholder="https://app.powerbi.com/home" /></${Field}>
    </div></${Modal}>`;
}

function ImportForm({ profile, onDone }) {
  const [text, setText] = useState('');
  const onFile = async (e) => { const file = e.target.files[0]; if (file) setText(await file.text()); };
  const save = async () => {
    let state;
    try { state = JSON.parse(text); } catch { return act(() => { throw new Error('Not valid JSON'); }); }
    const r = await act(() => api(`/profiles/${profile.id}/import`, { method: 'POST', body: { state } }), 'Session imported');
    if (r) { setStore({ modal: null }); onDone(); }
  };
  return html`<${Modal} title=${`Import session · ${profile.name}`} onClose=${() => setStore({ modal: null })}
    footer=${html`<button class="btn" onClick=${() => setStore({ modal: null })}>Cancel</button><button class="btn primary" onClick=${save} disabled=${!text}>Import</button>`}>
    <div class="stack">
      <div class="callout info">ℹ <div>For servers without a display: run <code>npm run login -- "${profile.name}"</code> on a workstation, then upload the produced <code>data/auth/profile-*.json</code> here. Any Playwright <code>storageState</code> JSON works.</div></div>
      <input type="file" accept="application/json,.json" onChange=${onFile} />
      <textarea style="min-height:180px" value=${text} onInput=${(e) => setText(e.target.value)} placeholder='{"cookies":[...],"origins":[...]}'></textarea>
    </div></${Modal}>`;
}

export function Profiles() {
  const { data, reload } = useApi('/profiles', { poll: 2500 });
  const list = data || [];
  const edit = (p) => setStore({ modal: html`<${ProfileForm} profile=${p} onDone=${reload} />` });
  const login = async (p) => {
    const r = await act(() => api(`/profiles/${p.id}/login`, { method: 'POST' }));
    if (r) setStore({ modal: html`<${Modal} title="Sign in to Power BI" onClose=${() => setStore({ modal: null })} footer=${html`<button class="btn primary" onClick=${() => setStore({ modal: null })}>OK</button>`}>
      <div class="stack"><p style="margin:0">${r.message}</p><p class="muted small" style="margin:0">Tip: tick “Stay signed in” so the session lasts longer. The validator refreshes the saved session after every successful run.</p></div></${Modal}>` });
    reload();
  };
  const check = async (p) => { const r = await act(() => api(`/profiles/${p.id}/check`, { method: 'POST' })); if (r) toast(`${p.name}: ${r.detail || r.status}`, r.status === 'active' ? 'ok' : 'err'); reload(); };
  const del = async (p) => { if (await confirmDialog({ title: 'Delete profile?', message: `Delete "${p.name}" and its saved session? Reports using it will open anonymously.`, okLabel: 'Delete', danger: true })) { await act(() => api(`/profiles/${p.id}`, { method: 'DELETE' }), 'Profile deleted'); reload(); } };
  const forget = async (p) => { await act(() => api(`/profiles/${p.id}/session`, { method: 'DELETE' }), 'Session removed'); reload(); };

  return html`
    <${Topbar} title="Power BI sign-ins" sub="The Microsoft accounts the validator uses to open secured Power BI reports. Each report link can use a different one (e.g. different tenants for A and B). Not related to how people sign in to this website.">
      <button class="btn ed primary" onClick=${() => edit(null)}>+ New sign-in</button>
    </${Topbar}>
    <div class="content stack">
      <div class="callout info">ℹ <div><b>How it works:</b> “Sign in” opens a real browser window on the machine running the validator. Complete SSO/MFA there; once Power BI loads, the session is captured to <code>data/auth</code> (owner-only file permissions) and the window closes. Public “publish to web” links need no profile.</div></div>
      ${list.length === 0 ? html`<div class="panel"><${Empty} title="No Power BI sign-ins yet">Create one for each Microsoft account or tenant your reports need. Public “publish to web” links need none.</${Empty}></div>` : html`
      <div class="panel"><table class="t"><thead><tr><th>Profile</th><th>Status</th><th>Last sign-in</th><th>Last checked</th><th></th></tr></thead><tbody>
        ${list.map((p) => html`<tr>
          <td><b>${p.name}</b>${p.description && html`<div class="small muted">${p.description}</div>`}</td>
          <td><div class="row"><${Badge} s=${p.status} />${p.status === 'signing_in' && html`<${Spinner} />`}</div><div class="small muted">${p.status_detail}</div></td>
          <td class="muted">${fmtAgo(p.last_login_at)}</td><td class="muted">${fmtAgo(p.last_checked_at)}</td>
          <td style="text-align:right"><div class="row" style="justify-content:flex-end">
            <button class="btn ed sm primary" onClick=${() => login(p)} disabled=${p.status === 'signing_in'}>Sign in</button>
            <button class="btn ed sm" onClick=${() => check(p)} disabled=${!p.has_session}>Check</button>
            <button class="btn ed sm" onClick=${() => setStore({ modal: html`<${ImportForm} profile=${p} onDone=${reload} />` })}>Import</button>
            <button class="btn ed sm ghost" onClick=${() => edit(p)}>Edit</button>
            ${p.has_session && html`<button class="btn ed sm ghost" onClick=${() => forget(p)}>Sign out</button>`}
            <button class="btn ed sm ghost danger" onClick=${() => del(p)}>Delete</button></div></td></tr>`)}
      </tbody></table></div>`}
    </div>`;
}
