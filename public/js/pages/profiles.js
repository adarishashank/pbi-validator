import { html, useApi, useState, useEffect, useRef, setStore, fmtAgo, api, toast } from '../lib.js';
import { Badge, Modal, Field, act, confirmDialog, Empty, Spinner, Menu } from '../ui.js';
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

const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const STEP = { starting: 'Starting a browser…', waiting: 'Sign in below', saving: 'Signed in, saving the session…', done: 'Signed in', expired: 'Closed after inactivity' };

/**
 * Sign in from the website: shows the server's sign-in browser live and sends
 * clicks, scrolling and typing to it. Works with SSO and MFA, on any server.
 */
function RemoteLogin({ profile, onDone }) {
  const [st, setSt] = useState({ status: 'starting' });
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(null);
  const [focused, setFocused] = useState(false);
  const [typed, setTyped] = useState('');
  const view = useRef({ width: 1100, height: 760 });
  const alive = useRef(true);
  const done = useRef(false);
  const queue = useRef(Promise.resolve());
  const text = useRef('');
  const timer = useRef(null);
  const wheel = useRef({ dy: 0, x: 0, y: 0, t: null });
  const box = useRef(null);
  const base = `/profiles/${profile.id}/remote`;

  const send = (ev) => { queue.current = queue.current.then(() => api(`${base}/input`, { method: 'POST', body: ev })).catch((e) => setErr(e.message)); return queue.current; };
  const flushText = () => { clearTimeout(timer.current); if (text.current) { const t = text.current; text.current = ''; send({ type: 'text', text: t }); } };

  useEffect(() => {
    let last = null;
    (async () => {
      try {
        const r = await api(base, { method: 'POST' });
        view.current = r.view || view.current;
        setSt(r);
      } catch (e) { setErr(e.message); return; }
      let n = 0;
      while (alive.current) {
        try {
          const res = await api(`${base}/frame`, { raw: true });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            if (!done.current) setErr(j.error || 'The sign-in browser has closed');
            break;
          }
          const url = URL.createObjectURL(await res.blob());
          setSrc(url);
          if (last) URL.revokeObjectURL(last);
          last = url;
          if (n++ % 2 === 0) {
            const s = await api(base);
            setSt(s);
            if (s.status === 'done' && !done.current) {
              done.current = true;
              toast(`${profile.name}: signed in to Power BI`, 'ok');
              setStore({ modal: null });
              onDone();
              break;
            }
            if (s.status === 'none' || s.status === 'expired') { setErr('The sign-in window closed after 5 minutes without activity. Start again.'); break; }
          }
        } catch (e) { setErr(e.message); break; }
        await new Promise((r) => setTimeout(r, 350));
      }
    })();
    return () => {
      alive.current = false;
      if (last) URL.revokeObjectURL(last);
      if (!done.current) api(base, { method: 'DELETE' }).catch(() => {}).finally(onDone);
    };
  }, []);

  const point = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) * view.current.width) / r.width), y: Math.round(((e.clientY - r.top) * view.current.height) / r.height) };
  };
  const onClick = (e) => { box.current?.focus(); flushText(); send({ type: 'click', ...point(e) }); };
  const onWheel = (e) => {
    e.preventDefault();
    const w = wheel.current;
    Object.assign(w, point(e)); w.dy += e.deltaY;
    if (!w.t) w.t = setTimeout(() => { send({ type: 'scroll', x: w.x, y: w.y, dy: Math.round(w.dy) }); w.dy = 0; w.t = null; }, 120);
  };
  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // paste event follows
    e.stopPropagation(); // Escape goes to the sign-in page, not the dialog
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      text.current += e.key;
      clearTimeout(timer.current);
      timer.current = setTimeout(flushText, 120);
    } else if (KEYS.has(e.key)) {
      e.preventDefault();
      flushText();
      send({ type: 'key', key: e.key === 'Tab' && e.shiftKey ? 'Shift+Tab' : e.key });
    }
  };
  const onPaste = (e) => { e.preventDefault(); const t = e.clipboardData?.getData('text') || ''; if (t) { flushText(); send({ type: 'text', text: t }); } };
  const sendTyped = async (enter) => { if (typed) await send({ type: 'text', text: typed }); if (enter) await send({ type: 'key', key: 'Enter' }); setTyped(''); };

  return html`<${Modal} size="wide" title=${`Sign in to Power BI · ${profile.name}`} onClose=${() => setStore({ modal: null })}
    footer=${html`<span class="small muted" style="margin-right:auto">${STEP[st.status] || st.status}</span><button class="btn" onClick=${() => setStore({ modal: null })}>Cancel</button>`}>
    <div class="stack" style="gap:10px">
      <div class="small muted">This is a browser running on the PBI Report Test server. Click into it and sign in as usual, including MFA (for example approve the number in Microsoft Authenticator). What you type goes to that browser over an encrypted connection and is not stored or logged. When Power BI opens, the session is saved to this sign-in and the window closes.</div>
      ${err ? html`<div class="callout err">✖ <div>${err}</div></div>` : html`
      <div class="rb-bar"><span>🔒</span><span class="mono">${st.host || '…'}</span><span class="spacer"></span><span class="small ${focused ? '' : 'muted'}">${focused ? 'Keyboard connected: type here' : 'Click the page to type'}</span></div>
      <div class="rb-view ${focused ? 'on' : ''}" ref=${box} tabindex="0" onKeyDown=${onKeyDown} onPaste=${onPaste} onFocus=${() => setFocused(true)} onBlur=${() => setFocused(false)}
        style=${`aspect-ratio:${view.current.width}/${view.current.height}`}>
        ${src ? html`<img src=${src} alt="Power BI sign-in page" draggable="false" onClick=${onClick} onWheel=${onWheel} />` : html`<div class="rb-wait"><${Spinner} /> Starting a browser…</div>`}
      </div>
      <details class="small"><summary>Typing doesn't work (phone, password manager)?</summary>
        <div class="row" style="margin-top:6px;gap:6px"><input type="password" autocomplete="off" placeholder="Click a field in the page, then type here" value=${typed} onInput=${(e) => setTyped(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') sendTyped(true); }} style="max-width:360px" />
          <button class="btn sm" onClick=${() => sendTyped(false)}>Send</button><button class="btn sm" onClick=${() => sendTyped(true)}>Send + Enter</button></div></details>`}
    </div></${Modal}>`;
}

export function Profiles() {
  const { data, reload } = useApi('/profiles', { poll: (d) => (d && d.some((p) => p.status === 'signing_in') ? 2500 : 30000) });
  const list = data || [];
  const edit = (p) => setStore({ modal: html`<${ProfileForm} profile=${p} onDone=${reload} />` });
  const login = (p) => setStore({ modal: html`<${RemoteLogin} profile=${p} onDone=${reload} />` });
  const check = async (p) => { const r = await act(() => api(`/profiles/${p.id}/check`, { method: 'POST' })); if (r) toast(`${p.name}: ${r.detail || r.status}`, r.status === 'active' ? 'ok' : 'err'); reload(); };
  const del = async (p) => { if (await confirmDialog({ title: 'Delete profile?', message: `Delete "${p.name}" and its saved session? Reports using it will open anonymously.`, okLabel: 'Delete', danger: true })) { await act(() => api(`/profiles/${p.id}`, { method: 'DELETE' }), 'Profile deleted'); reload(); } };
  const forget = async (p) => { await act(() => api(`/profiles/${p.id}/session`, { method: 'DELETE' }), 'Session removed'); reload(); };

  return html`
    <${Topbar} title="Power BI sign-ins" sub="The Microsoft accounts the validator uses to open secured Power BI reports. Each report link can use a different one (e.g. different tenants for A and B). Not related to how people sign in to this website.">
      <button class="btn ed primary" onClick=${() => edit(null)}>+ New sign-in</button>
    </${Topbar}>
    <div class="content stack">
      <div class="callout info">ℹ <div><b>How it works:</b> “Sign in” shows a browser running on the server, right here in this page. Sign in with the Microsoft account (SSO and MFA work); once Power BI opens, the session is saved securely and used by test runs. Tick “Stay signed in” so it lasts longer; it is refreshed after every successful run. Public “publish to web” links need no sign-in.</div></div>
      ${list.length === 0 ? html`<div class="panel"><${Empty} title="No Power BI sign-ins yet">Create one for each Microsoft account or tenant your reports need. Public “publish to web” links need none.</${Empty}></div>` : html`
      <div class="panel"><table class="t"><thead><tr><th>Profile</th><th>Status</th><th>Last sign-in</th><th>Last checked</th><th></th></tr></thead><tbody>
        ${list.map((p) => html`<tr>
          <td><b>${p.name}</b>${p.description && html`<div class="small muted">${p.description}</div>`}</td>
          <td><div class="row"><${Badge} s=${p.status} />${p.status === 'signing_in' && html`<${Spinner} />`}</div><div class="small muted">${p.status_detail}</div></td>
          <td class="muted">${fmtAgo(p.last_login_at)}</td><td class="muted">${fmtAgo(p.last_checked_at)}</td>
          <td class="ed" style="text-align:right;white-space:nowrap"><div class="row" style="justify-content:flex-end;flex-wrap:nowrap;gap:6px">
            <button class="btn sm primary" onClick=${() => login(p)}>Sign in</button>
            <button class="btn sm" onClick=${() => check(p)} disabled=${!p.has_session}>Check</button>
            <${Menu} label="More" className="sm" items=${[
              { label: 'Import session', desc: 'Upload a session file made with npm run login', onClick: () => setStore({ modal: html`<${ImportForm} profile=${p} onDone=${reload} />` }) },
              { label: 'Edit', desc: 'Name, description, sign-in start URL', onClick: () => edit(p) },
              p.has_session && { label: 'Sign out', desc: 'Remove the saved session', onClick: () => forget(p) },
              'divider',
              { label: 'Delete', desc: 'Delete this sign-in and its session', onClick: () => del(p) },
            ]} /></div></td></tr>`)}
      </tbody></table></div>`}
    </div>`;
}
