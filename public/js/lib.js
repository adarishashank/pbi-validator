import { h, render } from '/vendor/preact.mjs';
import { useState, useEffect, useRef, useCallback, useMemo } from '/vendor/hooks.mjs';
import htm from '/vendor/htm.mjs';

export const html = htm.bind(h);
export { h, render, useState, useEffect, useRef, useCallback, useMemo };

// ------------------------------------------------------------------ store
const listeners = new Set();
// me: undefined = still loading, null = signed out, else { user, method, roles, roleInfo }
export const store = { toasts: [], modal: null, lightbox: null, me: undefined, authConfig: null, sessionExpired: false };
export function setStore(patch) {
  Object.assign(store, typeof patch === 'function' ? patch(store) : patch);
  listeners.forEach((l) => l());
}
export function useStore() {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force((n) => n + 1); listeners.add(l); return () => listeners.delete(l); }, []);
  return store;
}

let toastId = 0;
export function toast(msg, kind = '') {
  const id = ++toastId;
  setStore((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
  setTimeout(() => setStore((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'err' ? 7000 : 3500);
}

// -------------------------------------------------------------------- api
export class ApiError extends Error {}
export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (raw) return res;
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && data?.loginRequired && store.me) setStore({ me: null, modal: null, sessionExpired: true });
  if (res.status === 403 && data?.passwordChangeRequired && store.me?.user) {
    setStore({ me: { ...store.me, user: { ...store.me.user, must_change_password: true } }, modal: null });
  }
  if (!res.ok) throw Object.assign(new ApiError(data?.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

/** Data hook with reload + optional polling. */
export function useApi(path, { poll = 0, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const reload = useCallback(async () => {
    if (!path) return;
    try { const data = await api(path); setState({ data, error: null, loading: false }); }
    catch (e) { setState((s) => ({ ...s, error: e.message, loading: false })); }
  }, [path]);
  useEffect(() => { reload(); }, [reload, ...deps]);
  useEffect(() => {
    if (!poll) return undefined;
    const t = setInterval(reload, poll);
    return () => clearInterval(t);
  }, [reload, poll]);
  return { ...state, reload };
}

// ------------------------------------------------------------------ auth
const RANK = { viewer: 0, editor: 1, admin: 2 };
/** True when the signed-in user has at least the given role. */
export const can = (role) => Boolean(store.me?.user) && RANK[store.me.user.role] >= RANK[role];

export async function loadSession() {
  const [cfg, me] = await Promise.all([
    api('/auth/config').catch(() => null),
    api('/auth/me').catch(() => null),
  ]);
  const signedIn = me?.user ? me : null;
  setStore({ authConfig: cfg, me: signedIn });
  return signedIn;
}

export async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  setStore({ me: null, modal: null, sessionExpired: false });
  go('/login');
}

/**
 * Downloads an API file (PDF, Excel, …) with progress and error toasts instead
 * of navigating away. The filename comes from the server's Content-Disposition.
 */
export async function downloadFile(path, { busy = 'Preparing download…', fallbackName = 'download' } = {}) {
  if (busy) toast(busy);
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (res.status === 401 && data?.loginRequired) setStore({ me: null, modal: null });
    toast(data?.error || `Download failed (${res.status})`, 'err');
    return false;
  }
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast(`Downloaded ${name}`, 'ok');
  return true;
}

export async function copyText(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label, 'ok'); } catch { toast('Copy failed: select the text and copy it manually', 'err'); }
}

// ---------------------------------------------------------------- router
export function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const [pathPart, query = ''] = hash.slice(1).split('?');
  return { parts: pathPart.split('/').filter(Boolean), query: new URLSearchParams(query) };
}
export const go = (path) => { location.hash = path; };

// --------------------------------------------------------------- formats
export const fmtDate = (s) => (s ? new Date(s.endsWith('Z') || s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export function fmtAgo(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  const sec = Math.round((Date.now() - d) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
export function fmtDur(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
export function runDuration(r) {
  if (r.summary?.durationMs) return fmtDur(r.summary.durationMs);
  if (r.started_at && !r.finished_at) return fmtDur(Date.now() - new Date(r.started_at));
  return '—';
}
export const pct = (r) => (r == null ? '' : r === 0 ? '0%' : r < 0.0001 ? '<0.01%' : `${(r * 100).toFixed(r < 0.01 ? 2 : 1)}%`);

export const STATUS_ORDER = ['fail', 'error', 'missing', 'diff', 'warn', 'accepted', 'pass', 'skipped'];
export const STATUS_LABEL = { pass: 'Pass', diff: 'Diff', fail: 'Fail', missing: 'Missing', error: 'Error', warn: 'Warn', accepted: 'Accepted', skipped: 'Skipped' };
export const SCENARIO_LABEL = {
  report_pages: 'Pages', health: 'Health', page_render: 'Page render', structure: 'Layout', visual: 'Visual',
  button: 'Button', slicer: 'Slicer', drill: 'Hierarchy drill', drill_through: 'Drill-through', model: 'Data model', budget: 'Time budget', matrix_expand: 'Matrix expand', cross_filter: 'Cross-filter', tooltip: 'Tooltip',
};
