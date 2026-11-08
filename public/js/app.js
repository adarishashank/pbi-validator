import { html, render, useRoute, useApi, useEffect, useStore, setStore, loadSession, signOut, can, go } from './lib.js';
import { Toasts, Lightbox, ModalHost, Spinner } from './ui.js';
import { Dashboard } from './pages/dashboard.js';
import { Reports } from './pages/reports.js';
import { Suites } from './pages/suites.js';
import { Runs } from './pages/runs.js';
import { RunDetail } from './pages/run.js';
import { Profiles } from './pages/profiles.js';
import { Login, Setup, ForcedPasswordChange } from './pages/login.js';
import { Account, RoleBadge } from './pages/account.js';
import { Admin } from './pages/admin.js';

const NAV = [
  ['', '◧', 'Dashboard'],
  ['reports', '⧉', 'Report links'],
  ['suites', '⇄', 'Test suites'],
  ['runs', '▶', 'Runs'],
  ['profiles', '⚿', 'Power BI sign-ins'],
];

function Health() {
  const { data, error } = useApi('/health', { poll: 10000 });
  if (error) return html`<span><span class="dot off"></span>Server unreachable</span>`;
  if (!data) return html`<span>…</span>`;
  return html`<span><span class="dot ${data.busy ? 'busy' : ''}"></span>${data.busy ? 'Validation running' : 'Idle · ready'}</span>`;
}

function AiBadge() {
  const { data } = useApi('/ai/status');
  if (!data) return null;
  return html`<div style="margin-top:6px" title=${data.configured ? `${data.textModel} · ${data.visionModel}` : 'Set NVIDIA_API_KEY to enable'}>🤖 AI: ${data.configured ? html`<span style="color:#a78bfa">NVIDIA ${data.textModel.split('/').pop()}</span>` : 'not configured'}</div>`;
}

function UserMenu({ user, top }) {
  const initials = (user.name || user.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');
  return html`<div class="side-user">
    <a href="#/account" class="who ${top === 'account' ? 'active' : ''}" title="My account">
      <span class="avatar">${initials}</span>
      <span class="truncate"><b class="truncate">${user.name || user.email}</b><small><${RoleBadge} role=${user.role} /></small></span></a>
    <button class="btn sm ghost signout" title="Sign out" onClick=${signOut}>⎋ Sign out</button>
  </div>`;
}

function Shell({ parts, query }) {
  const s = useStore();
  const top = parts[0] || '';
  const user = s.me.user;
  let page;
  if (top === 'reports') page = html`<${Reports} />`;
  else if (top === 'suites') page = html`<${Suites} editId=${parts[1]} />`;
  else if (top === 'runs' && parts[1]) page = html`<${RunDetail} id=${parts[1]} query=${query} />`;
  else if (top === 'runs') page = html`<${Runs} query=${query} />`;
  else if (top === 'profiles') page = html`<${Profiles} />`;
  else if (top === 'account') page = html`<${Account} />`;
  else if (top === 'admin' && can('admin')) page = html`<${Admin} tab=${parts[1]} />`;
  else page = html`<${Dashboard} />`;
  const nav = can('admin') ? [...NAV, ['admin', '⚙', 'Admin']] : NAV;
  return html`<div class="shell">
    <aside class="side">
      <div class="brand"><div class="brand-mark"><svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true"><rect x="7" y="16" width="4" height="9" fill="currentColor"/><rect x="14" y="10" width="4" height="15" fill="currentColor"/><rect x="21" y="6" width="4" height="19" fill="currentColor"/></svg></div><div>PBI Report Test<small>Report regression testing</small></div></div>
      <nav class="nav">${nav.map(([p, ico, label]) => html`<a href=${`#/${p}`} class=${top === p ? 'active' : ''}><span class="ico">${ico}</span>${label}</a>`)}</nav>
      ${!can('editor') && html`<div class="side-note">👁 Read-only access. Ask an admin for the editor role to change things or start runs.</div>`}
      <div class="side-foot"><${UserMenu} user=${user} top=${top} /><${Health} /><${AiBadge} /></div>
    </aside>
    <main class="main">${page}</main>
  </div>`;
}

function App() {
  const s = useStore();
  const { parts, query } = useRoute();
  const routeKey = parts.join('/');
  useEffect(() => { loadSession(); }, []);
  useEffect(() => { setStore({ modal: null, lightbox: null }); }, [routeKey]);
  useEffect(() => { document.body.dataset.role = s.me?.user?.role || ''; }, [s.me?.user?.role]);

  const signedIn = Boolean(s.me?.user);
  // Signed in but sitting on #/login (e.g. a bookmark): go home.
  useEffect(() => { if (signedIn && parts[0] === 'login' && !query.get('error')) go('/'); }, [signedIn, routeKey]);

  let body;
  if (s.me === undefined) body = html`<div class="auth-wrap"><${Spinner} /></div>`;
  else if (s.authConfig?.setupRequired && !signedIn) body = html`<${Setup} />`;
  else if (!signedIn) {
    const back = parts[0] === 'login' ? query.get('returnTo') || '/' : `/${routeKey}`;
    const q = new URLSearchParams(query);
    if (parts[0] !== 'login') q.set('returnTo', back);
    body = html`<${Login} query=${q} />`;
  } else if (s.me.user.must_change_password) body = html`<${ForcedPasswordChange} />`;
  else if (parts[0] === 'login') body = html`<${Login} query=${query} />`;
  else body = html`<${Shell} parts=${parts} query=${query} />`;
  return html`${body}<${ModalHost} /><${Lightbox} /><${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
