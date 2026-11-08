import { html, useState, useStore, api, setStore, loadSession, signOut, go } from '../lib.js';
import { Field } from '../ui.js';

const LOGO = html`<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="16" width="4" height="9" fill="currentColor"/><rect x="14" y="10" width="4" height="15" fill="currentColor"/><rect x="21" y="6" width="4" height="19" fill="currentColor"/></svg>`;

const FEATURES = [
  ['⇄', 'Compare PROD and DEV', 'Pages, visuals, numbers, slicers, buttons and drill-downs, checked automatically.'],
  ['🤖', 'AI explains what changed', 'A plain-English summary, likely root causes and the next steps to take.'],
  ['⇩', 'Share the results', 'Download any run as a PDF report or an Excel workbook.'],
];

/** Two-panel layout shared by sign-in, first-run setup and forced password change. */
function AuthLayout({ title, sub, children, footer, aside }) {
  const cfg = useStore().authConfig || {};
  return html`<div class="auth">
    <aside class="auth-side">
      <div class="auth-logo"><span class="brand-mark">${LOGO}</span><span><b>PBI Validator</b><small>Power BI regression testing</small></span></div>
      <div class="auth-pitch">
        <h2>${aside?.title || html`Catch report problems<br />before your users do.`}</h2>
        <ul>${(aside?.items || FEATURES).map(([ico, h, p]) => html`<li><span class="ai-ico">${ico}</span><div><b>${h}</b><span>${p}</span></div></li>`)}</ul>
      </div>
      <div class="auth-side-foot">${cfg.version ? `Version ${cfg.version}` : ''}</div>
    </aside>
    <main class="auth-main">
      <div class="auth-box">
        <div class="auth-logo compact"><span class="brand-mark">${LOGO}</span><b>PBI Validator</b></div>
        <h1>${title}</h1>${sub && html`<p class="auth-sub">${sub}</p>`}
        ${children}
      </div>
      ${footer && html`<div class="auth-foot">${footer}</div>`}
    </main>
  </div>`;
}

function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return { busy, error, setError, submit };
}

/** Password input with show/hide toggle and a Caps Lock warning. */
function PasswordInput({ value, onInput, autocomplete = 'current-password', autofocus, placeholder = '', id }) {
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const key = (e) => setCaps(Boolean(e.getModifierState?.('CapsLock')));
  return html`<div class="pw-wrap">
    <input id=${id} type=${show ? 'text' : 'password'} autocomplete=${autocomplete} required autofocus=${autofocus} placeholder=${placeholder}
      spellcheck="false" value=${value} onInput=${onInput} onKeyUp=${key} onKeyDown=${key} onBlur=${() => setCaps(false)} />
    <button type="button" class="pw-toggle" aria-label=${show ? 'Hide password' : 'Show password'} title=${show ? 'Hide password' : 'Show password'}
      onClick=${() => setShow(!show)}>${show ? 'Hide' : 'Show'}</button>
    ${caps && html`<div class="caps">⇪ Caps Lock is on</div>`}
  </div>`;
}

const ErrorBox = ({ msg }) => msg && html`<div class="callout err" role="alert">✖ <div>${msg}</div></div>`;
const Submit = ({ busy, label, busyLabel, disabled }) => html`<button class="btn primary block lg" disabled=${busy || disabled}>${busy ? html`<span class="spinner light"></span> ${busyLabel}` : label}</button>`;

export function Login({ query }) {
  const s = useStore();
  const [f, setF] = useState({ email: localStorage.getItem('pbiv_last_email') || '', password: '', remember: true });
  const [help, setHelp] = useState(false);
  const returnTo = (query?.get('returnTo') || '/').replace(/^\/#?/, '/');
  const urlError = query?.get('error') || '';
  const expired = s.sessionExpired;
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/login', { method: 'POST', body: { email: f.email.trim(), password: f.password, remember: f.remember } });
    localStorage.setItem('pbiv_last_email', f.email.trim());
    setStore({ sessionExpired: false });
    await loadSession();
    go(returnTo === '/login' ? '/' : returnTo);
  });
  return html`<${AuthLayout} title="Sign in" sub="Welcome back. New here? Use the email and temporary password your administrator sent you."
    footer=${html`Don't have an account? Ask your administrator to add you.`}>
    ${expired && !error && html`<div class="callout info">ℹ <div>Your session ended. Sign in again to continue where you left off.</div></div>`}
    <${ErrorBox} msg=${error || urlError} />
    <form class="stack auth-form" onSubmit=${submit}>
      <${Field} label="Email"><input type="email" autocomplete="username" required autofocus=${!f.email} placeholder="name@company.com"
        value=${f.email} onInput=${(e) => setF({ ...f, email: e.target.value })} /></${Field}>
      <label class="f"><span class="row" style="justify-content:space-between">Password
        <a href="#" class="small" style="font-weight:500" onClick=${(e) => { e.preventDefault(); setHelp(!help); }}>Forgot password?</a></span>
        <${PasswordInput} autofocus=${Boolean(f.email)} value=${f.password} onInput=${(e) => setF({ ...f, password: e.target.value })} /></label>
      ${help && html`<div class="callout info small">ℹ <div>Ask an administrator to generate a new temporary password for you (<b>Admin → Users → Reset password</b>). Sign in with it and choose your own.
        <div style="margin-top:4px">Administrator locked out? On the server run <code>npm run cli -- reset-password you@company.com</code>.</div></div></div>`}
      <label class="row small remember"><input type="checkbox" checked=${f.remember} onChange=${(e) => setF({ ...f, remember: e.target.checked })} />
        Keep me signed in <span class="muted">(untick on shared computers)</span></label>
      <${Submit} busy=${busy} label="Sign in" busyLabel="Signing in…" />
    </form>
  </${AuthLayout}>`;
}

// --------------------------------------------------------- new passwords

/** Requirement checklist + strength meter for a new password. */
export function PasswordRules({ password, confirm, email, minLength }) {
  const local = (email || '').split('@')[0].toLowerCase();
  const rules = [
    [password.length >= minLength, `At least ${minLength} characters`],
    [!(local.length >= 4 && password.toLowerCase().includes(local)), 'Doesn\'t contain your email name'],
    [Boolean(confirm) && password === confirm, 'Both passwords match'],
  ];
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const score = !password ? 0 : Math.min(4, Math.floor(password.length / minLength * 2) + (classes >= 3 ? 1 : 0) + (password.length >= 16 ? 1 : 0));
  const label = ['', 'Weak', 'Fair', 'Good', 'Strong'][score];
  return html`<div class="pw-rules">
    <div class="meter"><span class=${`m${score}`} style=${`width:${score * 25}%`}></span></div>
    ${password && html`<div class="small muted" style="margin-bottom:4px">Strength: <b>${label}</b></div>`}
    ${rules.map(([ok, text]) => html`<div class=${ok ? 'ok' : ''}>${ok ? '✓' : '○'} ${text}</div>`)}
  </div>`;
}

export function Setup() {
  const s = useStore();
  const cfg = s.authConfig || {};
  const min = cfg.passwordMinLength || 10;
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '', setupToken: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { busy, error, setError, submit } = useSubmit(async () => {
    if (f.password !== f.confirm) { setError('The passwords don\'t match'); return; }
    await api('/auth/setup', { method: 'POST', body: { name: f.name, email: f.email.trim(), password: f.password, setupToken: f.setupToken } });
    localStorage.setItem('pbiv_last_email', f.email.trim());
    await loadSession();
    go('/admin/users');
  });
  return html`<${AuthLayout} title="Create the administrator account"
    sub="This is a new installation. The first account becomes the administrator; you can add everyone else afterwards in Admin → Users."
    aside=${{ title: html`Welcome to<br />PBI Validator.`, items: [['1', 'Create your admin account', 'You\'re doing this now.'], ['2', 'Add your report links', 'Paste the Power BI URLs to test.'], ['3', 'Create a suite and run it', 'Then download the results as PDF or Excel.']] }}>
    <${ErrorBox} msg=${error} />
    ${!cfg.setupPossible && html`<div class="callout warn">⚠ <div>For safety, create the first administrator on the machine running the validator (open <code>http://127.0.0.1:4400</code> there), or set <code>API_TOKEN</code> in <code>.env</code> to allow remote setup.</div></div>`}
    <form class="stack auth-form" onSubmit=${submit}>
      <${Field} label="Your name"><input type="text" autocomplete="name" autofocus value=${f.name} onInput=${set('name')} /></${Field}>
      <${Field} label="Work email" hint="You'll sign in with this."><input type="email" autocomplete="username" required value=${f.email} onInput=${set('email')} placeholder="name@company.com" /></${Field}>
      <${Field} label="Password"><${PasswordInput} autocomplete="new-password" value=${f.password} onInput=${set('password')} /></${Field}>
      <${Field} label="Confirm password"><${PasswordInput} autocomplete="new-password" value=${f.confirm} onInput=${set('confirm')} /></${Field}>
      <${PasswordRules} password=${f.password} confirm=${f.confirm} email=${f.email} minLength=${min} />
      ${cfg.setupNeedsToken && html`<${Field} label="Setup token" hint="You're connecting remotely, so enter the API_TOKEN value from the server's .env file."><input type="password" required value=${f.setupToken} onInput=${set('setupToken')} /></${Field}>`}
      <${Submit} busy=${busy} label="Create administrator" busyLabel="Creating…" disabled=${!cfg.setupPossible} />
    </form>
  </${AuthLayout}>`;
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
  return html`<form class="stack auth-form" onSubmit=${submit}>
    <${ErrorBox} msg=${error} />
    <input type="email" autocomplete="username" value=${email} hidden readonly />
    ${!forced && html`<${Field} label="Current password"><${PasswordInput} value=${f.current} onInput=${set('current')} /></${Field}>`}
    <${Field} label="New password"><${PasswordInput} autocomplete="new-password" autofocus=${forced} value=${f.next} onInput=${set('next')} /></${Field}>
    <${Field} label="Confirm new password"><${PasswordInput} autocomplete="new-password" value=${f.confirm} onInput=${set('confirm')} /></${Field}>
    <${PasswordRules} password=${f.next} confirm=${f.confirm} email=${email} minLength=${minLength} />
    ${forced ? html`<${Submit} busy=${busy} label="Save password and continue" busyLabel="Saving…" />`
      : html`<div class="row"><span class="spacer"></span><button class="btn primary" disabled=${busy}>${busy ? 'Saving…' : 'Change password'}</button></div>`}
  </form>`;
}

export function ForcedPasswordChange() {
  const s = useStore();
  const u = s.me.user;
  return html`<${AuthLayout} title="Choose your own password" sub=${html`You signed in as <b>${u.email}</b> with a temporary password. Pick a new one that only you know.`}
    footer=${html`Not you? <a href="#/login" onClick=${(e) => { e.preventDefault(); signOut(); }}>Sign out</a>`}>
    <${PasswordForm} forced email=${u.email} minLength=${s.authConfig?.passwordMinLength || 10}
      onDone=${() => { setStore({ me: { ...s.me, user: { ...u, must_change_password: false } } }); go('/'); }} />
  </${AuthLayout}>`;
}
