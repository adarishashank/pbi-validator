import { html, useState, useStore, api, setStore, loadSession, signOut, go } from '../lib.js';
import { Field } from '../ui.js';

const MsLogo = () => html`<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
  <rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
  <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>`;

const AuthCard = ({ title, sub, children, footer }) => html`<div class="auth-wrap">
  <div class="auth-card">
    <div class="auth-brand"><div class="brand-mark">▮</div><div><b>PBI Validator</b><small>Power BI regression testing</small></div></div>
    <h1>${title}</h1>${sub && html`<p class="muted auth-sub">${sub}</p>`}
    ${children}
  </div>
  ${footer && html`<div class="auth-foot">${footer}</div>`}
</div>`;

function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return { busy, error, setError, submit };
}

export function Login({ query }) {
  const s = useStore();
  const cfg = s.authConfig || {};
  const [f, setF] = useState({ email: '', password: '' });
  const returnTo = query?.get('returnTo') || '/';
  const urlError = query?.get('error') || '';
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/login', { method: 'POST', body: f });
    await loadSession();
    go(returnTo.replace(/^\/#?/, '/'));
  });
  const msHref = `/auth/microsoft/login?returnTo=${encodeURIComponent(`/#${returnTo.replace(/^\/#?/, '/')}`)}`;
  const shown = error || urlError;
  return html`<${AuthCard} title="Sign in" sub="Use your work account to continue." footer=${html`Trouble signing in? Ask an administrator to reset your access.`}>
    ${shown && html`<div class="callout err" role="alert">✖ <div>${shown}</div></div>`}
    ${cfg.microsoft?.enabled && html`<a class="btn ms-btn" href=${msHref}><${MsLogo} /> ${cfg.microsoft.label}</a>`}
    ${cfg.microsoft?.enabled && cfg.localLogin && html`<div class="divider"><span>or sign in with email</span></div>`}
    ${cfg.localLogin !== false ? html`<form class="stack" style="gap:12px" onSubmit=${submit}>
      <${Field} label="Email"><input type="email" autocomplete="username" required autofocus value=${f.email} onInput=${(e) => setF({ ...f, email: e.target.value })} /></${Field}>
      <${Field} label="Password"><input type="password" autocomplete="current-password" required value=${f.password} onInput=${(e) => setF({ ...f, password: e.target.value })} /></${Field}>
      <button class="btn primary block" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
    </form>` : !cfg.microsoft?.enabled && html`<div class="callout warn">No sign-in method is enabled. An administrator can run <code>npm run cli -- create-admin you@company.com</code> on the server.</div>`}
  </${AuthCard}>`;
}

export function Setup() {
  const s = useStore();
  const cfg = s.authConfig || {};
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '', setupToken: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { busy, error, setError, submit } = useSubmit(async () => {
    if (f.password !== f.confirm) { setError('The passwords don\'t match'); return; }
    await api('/auth/setup', { method: 'POST', body: { name: f.name, email: f.email, password: f.password, setupToken: f.setupToken } });
    await loadSession();
    go('/admin/users');
  });
  return html`<${AuthCard} title="Create the administrator account" sub="This is a new installation. The first account becomes an administrator; you can add other people (or Microsoft sign-in) afterwards in Admin.">
    ${error && html`<div class="callout err" role="alert">✖ <div>${error}</div></div>`}
    ${!cfg.setupPossible && html`<div class="callout warn">⚠ <div>For safety, create the first administrator on the machine running the validator (open <code>http://127.0.0.1:4400</code> there), or set <code>API_TOKEN</code> in <code>.env</code> to allow remote setup.</div></div>`}
    <form class="stack" style="gap:12px" onSubmit=${submit}>
      <${Field} label="Your name"><input type="text" autocomplete="name" value=${f.name} onInput=${set('name')} /></${Field}>
      <${Field} label="Work email"><input type="email" autocomplete="username" required value=${f.email} onInput=${set('email')} /></${Field}>
      <${Field} label="Password" hint=${`At least ${cfg.passwordMinLength || 10} characters.`}><input type="password" autocomplete="new-password" required value=${f.password} onInput=${set('password')} /></${Field}>
      <${Field} label="Confirm password"><input type="password" autocomplete="new-password" required value=${f.confirm} onInput=${set('confirm')} /></${Field}>
      ${cfg.setupNeedsToken && html`<${Field} label="Setup token" hint="You're connecting remotely, so enter the API_TOKEN value from the server's .env file."><input type="password" required value=${f.setupToken} onInput=${set('setupToken')} /></${Field}>`}
      <button class="btn primary block" disabled=${busy || !cfg.setupPossible}>${busy ? 'Creating…' : 'Create administrator'}</button>
    </form>
  </${AuthCard}>`;
}

export function PasswordForm({ forced, email, onDone, minLength = 10 }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { busy, error, setError, submit } = useSubmit(async () => {
    if (f.next !== f.confirm) { setError('The new passwords don\'t match'); return; }
    const r = await api('/auth/password', { method: 'POST', body: { current: f.current, next: f.next } });
    setF({ current: '', next: '', confirm: '' });
    onDone?.(r);
  });
  return html`<form class="stack" style="gap:12px" onSubmit=${submit}>
    ${error && html`<div class="callout err" role="alert">✖ <div>${error}</div></div>`}
    <input type="email" autocomplete="username" value=${email} hidden readonly />
    ${!forced && html`<${Field} label="Current password"><input type="password" autocomplete="current-password" required value=${f.current} onInput=${set('current')} /></${Field}>`}
    <${Field} label="New password" hint=${`At least ${minLength} characters. Not a common password, and not your email name.`}><input type="password" autocomplete="new-password" required value=${f.next} onInput=${set('next')} /></${Field}>
    <${Field} label="Confirm new password"><input type="password" autocomplete="new-password" required value=${f.confirm} onInput=${set('confirm')} /></${Field}>
    <div class="row"><span class="spacer"></span><button class="btn primary ${forced ? 'block' : ''}" disabled=${busy}>${busy ? 'Saving…' : 'Change password'}</button></div>
  </form>`;
}

export function ForcedPasswordChange() {
  const s = useStore();
  const u = s.me.user;
  return html`<${AuthCard} title="Choose a new password" sub=${html`You signed in as <b>${u.email}</b> with a one-time password. Choose your own to continue.`}
    footer=${html`<a href="#/login" onClick=${(e) => { e.preventDefault(); signOut(); }}>Sign out</a>`}>
    <${PasswordForm} forced email=${u.email} minLength=${s.authConfig?.passwordMinLength || 10}
      onDone=${() => { setStore({ me: { ...s.me, user: { ...u, must_change_password: false } } }); go('/'); }} />
  </${AuthCard}>`;
}
