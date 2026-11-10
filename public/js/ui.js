import { html, useState, useEffect, useRef, useStore, setStore, api, toast, copyText, STATUS_LABEL } from './lib.js';

export const Badge = ({ s, label }) => html`<span class="badge b-${s}">${label || STATUS_LABEL[s] || String(s).replace(/_/g, ' ')}</span>`;

export const Progress = ({ value, sm }) => html`<div class="progress ${sm ? 'sm' : ''}"><div style=${`width:${Math.round((value || 0) * 100)}%`}></div></div>`;

/** Small notice while the host is starting the app and API calls are being retried. */
export function WakingNotice() {
  const s = useStore();
  return s.waking ? html`<div class="waking" role="status"><span class="spinner"></span>Waking up…</div>` : null;
}

/** Component loaded on first use with dynamic import(); shows the spinner while the module loads. */
export function lazy(load, name) {
  let mod = null;
  return function Lazy(props) {
    const [m, setM] = useState(mod);
    const [err, setErr] = useState(null);
    useEffect(() => { if (!m) load().then((x) => { mod = x; setM(x); }, (e) => setErr(e.message)); }, []);
    if (err) return html`<div class="content"><div class="callout err">Could not load this page (${err}). Reload to retry.</div></div>`;
    return m ? html`<${m[name]} ...${props} />` : html`<div class="content"><${Spinner} /></div>`;
  };
}

export const Spinner = () => html`<span class="spinner"></span>`;

export const Empty = ({ title, children }) => html`<div class="empty"><h3>${title}</h3>${children}</div>`;

export function Modal({ title, onClose, children, footer, size = '' }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose?.(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return html`<div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class="modal ${size}" role="dialog" aria-modal="true">
      <div class="modal-h"><h2>${title}</h2><button class="x" aria-label="Close" onClick=${onClose}>×</button></div>
      <div class="modal-b">${children}</div>
      ${footer && html`<div class="modal-f">${footer}</div>`}
    </div></div>`;
}

/** Imperative confirm dialog. */
export function confirmDialog({ title, message, okLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const close = (v) => { setStore({ modal: null }); resolve(v); };
    setStore({
      modal: html`<${Modal} title=${title} onClose=${() => close(false)} footer=${html`
        <button class="btn" onClick=${() => close(false)}>Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" onClick=${() => close(true)}>${okLabel}</button>`}>
        <p style="margin:0">${message}</p></${Modal}>`,
    });
  });
}

export function Toasts() {
  const s = useStore();
  return html`<div class="toasts">${s.toasts.map((t) => html`<div key=${t.id} class="toast ${t.kind}">${t.msg}</div>`)}</div>`;
}

export function Lightbox() {
  const s = useStore();
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && store_lb()) setStore({ lightbox: null }); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  if (!s.lightbox) return null;
  return html`<div class="lightbox" onClick=${() => setStore({ lightbox: null })}><img src=${s.lightbox} alt="Full-size screenshot" /></div>`;
}
const store_lb = () => document.querySelector('.lightbox');
export const zoom = (src) => setStore({ lightbox: src });

export function ModalHost() {
  const s = useStore();
  return s.modal || null;
}

/** Read-only value with a copy button (one-time passwords, keys, redirect URIs). */
export const CopyBox = ({ value, label = 'Copy' }) => html`<div class="copybox"><code>${value}</code>
  <button type="button" class="btn sm" onClick=${() => copyText(value)}>${label}</button></div>`;

/** Dropdown menu. items: [{ label, desc, icon, onClick }] or 'divider'. Closes on outside click / Escape. */
export function Menu({ label, items, className = '', align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !ref.current?.contains(e.target)) setOpen(false); };
    addEventListener('mousedown', close); addEventListener('keydown', close);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', close); };
  }, [open]);
  return html`<div class="menu" ref=${ref}>
    <button type="button" class="btn ${className}" aria-haspopup="menu" aria-expanded=${open} onClick=${() => setOpen(!open)}>${label} <span class="caret">▾</span></button>
    ${open && html`<div class="menu-pop ${align}" role="menu">${items.filter(Boolean).map((it) => (it === 'divider' ? html`<div class="menu-div"></div>` : html`
      <button type="button" role="menuitem" class="menu-item" onClick=${() => { setOpen(false); it.onClick(); }}>
        <span class="mi-ico">${it.icon || ''}</span><span><b>${it.label}</b>${it.desc && html`<small>${it.desc}</small>`}</span></button>`))}</div>`}
  </div>`;
}

/** Runs an async action with toast feedback; returns its result. */
export async function act(fn, ok) {
  try {
    const r = await fn();
    if (ok) toast(ok, 'ok');
    return r;
  } catch (e) {
    toast(e.message, 'err');
    return undefined;
  }
}

export const Field = ({ label, hint, children, full }) => html`<label class="f ${full ? 'full' : ''}">${label}${hint && html`<span class="hint">${hint}</span>`}${children}</label>`;

export const Check = ({ label, desc, checked, onChange }) => html`<label class="check">
  <input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)} />
  <div><b>${label}</b>${desc && html`<span>${desc}</span>`}</div></label>`;

export { api };
