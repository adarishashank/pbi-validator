import fs from 'node:fs';
import { config } from '../config.js';
import { q, update, nowIso } from '../db.js';
import { createLogger } from '../logger.js';
import { launchBrowser, browserUserAgent } from '../engine/runner.js';
import { DEFAULT_SELECTORS } from '../engine/selectors.js';
import { profileStatePath, writeStateFile } from './profiles.js';

// Sign in to Power BI from the website itself: a headless browser runs on the
// server, the user sees it as a live picture and clicks/types into it (works for
// SSO and MFA, and on servers without a display such as Cloudflare). When the
// browser reaches Power BI, the session is saved to the profile.

const logger = createLogger('remote-login');
export const VIEW = { width: 1100, height: 760 };
const IDLE_MS = 5 * 60 * 1000;     // closes after 5 minutes without input or viewing
const MAX_MS = 15 * 60 * 1000;     // and after 15 minutes in any case
const loginRe = new RegExp(DEFAULT_SELECTORS.loginUrl, 'i');
const signedInRe = process.env.PBI_SIGNED_IN_RE ? new RegExp(process.env.PBI_SIGNED_IN_RE, 'i') // tests
  : /app\.powerbi\.com\/(home|groups|reports|apps|links|view|reportEmbed|browse)|app\.(fabric\.microsoft|powerbigov\.us|powerbi\.cn)\//i;

const sessions = new Map(); // profileId → session

const err = (status, message) => Object.assign(new Error(message), { status });

function own(profileId, user) {
  const s = sessions.get(profileId);
  if (!s) throw err(404, 'No sign-in in progress for this profile');
  if (s.userId !== (user?.id ?? null)) throw err(403, 'Another person is signing in to this profile');
  s.touched = Date.now();
  return s;
}

export function remoteStatus(profileId, user) {
  const s = sessions.get(profileId);
  if (!s) return { status: 'none' };
  if (s.userId !== (user?.id ?? null)) return { status: 'busy', by: s.userName };
  const url = s.page && !s.page.isClosed() ? s.page.url() : '';
  let host = '';
  try { host = new URL(url).host; } catch { /* about:blank */ }
  return { status: s.status, host, error: s.error || null, startedAt: new Date(s.startedAt).toISOString() };
}

async function close(s) {
  sessions.delete(s.profileId);
  clearInterval(s.timer);
  await s.browser?.close().catch(() => {});
}

export async function startRemoteLogin(profileId, user) {
  const profile = q.get('SELECT * FROM auth_profiles WHERE id = ?', profileId);
  if (!profile) throw err(404, 'Profile not found');
  const existing = sessions.get(profileId);
  if (existing) {
    if (existing.userId !== (user?.id ?? null)) throw err(409, `${existing.userName || 'Someone'} is signing in to this profile right now`);
    await close(existing);
  }
  const s = { profileId, userId: user?.id ?? null, userName: user?.name || user?.email || '', status: 'starting', startedAt: Date.now(), touched: Date.now() };
  sessions.set(profileId, s);
  try {
    s.browser = await launchBrowser({ headless: true });
    s.context = await s.browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, userAgent: browserUserAgent(s.browser), locale: 'en-US' });
    s.page = await s.context.newPage();
    // Sign-in flows sometimes open a popup: follow the newest page.
    s.context.on('page', (p) => { s.page = p; p.on('close', () => { const pages = s.context.pages(); if (pages.length) s.page = pages.at(-1); }); });
    await s.page.goto(profile.login_url || config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    s.status = 'waiting';
    update('auth_profiles', profileId, { status: 'signing_in', status_detail: 'Signing in from the website…' });
    s.timer = setInterval(() => watch(s).catch((e) => logger.warn(e.message)), 1500);
    s.timer.unref?.();
    logger.info(`Remote sign-in started for profile #${profileId}`);
    return remoteStatus(profileId, user);
  } catch (e) {
    await close(s);
    update('auth_profiles', profileId, { status: 'not_signed_in', status_detail: `Could not start the sign-in browser: ${e.message.split('\n')[0]}` });
    throw e;
  }
}

async function watch(s) {
  if (s.checking || s.status !== 'waiting') return;
  s.checking = true;
  try {
    if (Date.now() - s.touched > IDLE_MS || Date.now() - s.startedAt > MAX_MS) {
      s.status = 'expired';
      update('auth_profiles', s.profileId, { status: profileHasState(s.profileId) ? 'expired' : 'not_signed_in', status_detail: 'Sign-in window closed after inactivity' });
      await close(s);
      return;
    }
    const url = s.page.url();
    if (!loginRe.test(url) && signedInRe.test(url)) {
      s.status = 'saving';
      await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      if (loginRe.test(s.page.url())) { s.status = 'waiting'; return; }
      const state = await s.context.storageState();
      await writeStateFile(profileStatePath(s.profileId), state);
      update('auth_profiles', s.profileId, { status: 'active', status_detail: `Signed in from the website (${state.cookies.length} cookies saved)`, last_login_at: nowIso(), last_checked_at: nowIso() });
      logger.info(`Profile #${s.profileId} signed in (remote)`);
      s.status = 'done';
      setTimeout(() => close(s), 10_000).unref?.(); // let the page pick up the final status
    }
  } finally {
    s.checking = false;
  }
}

const profileHasState = (id) => fs.existsSync(profileStatePath(id));

/** JPEG of what the sign-in browser shows. */
export async function remoteFrame(profileId, user) {
  const s = own(profileId, user);
  if (!s.page || s.page.isClosed()) throw err(410, 'The sign-in browser has closed');
  return s.page.screenshot({ type: 'jpeg', quality: 70, timeout: 10000 });
}

const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Shift+Tab']);

/** Forwards one input event. Coordinates are in VIEW pixels. Typed text is never logged. */
export async function remoteInput(profileId, user, ev) {
  const s = own(profileId, user);
  if (s.status !== 'waiting') return { status: s.status };
  const p = s.page;
  const x = Math.max(0, Math.min(VIEW.width, Number(ev.x) || 0));
  const y = Math.max(0, Math.min(VIEW.height, Number(ev.y) || 0));
  switch (ev.type) {
    case 'click': await p.mouse.click(x, y, { clickCount: ev.double ? 2 : 1 }); break;
    case 'scroll': await p.mouse.move(x, y); await p.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(ev.dy) || 0))); break;
    case 'text': await p.keyboard.type(String(ev.text || '').slice(0, 500)); break;
    case 'key': {
      const k = String(ev.key || '');
      if (!KEYS.has(k)) throw err(400, 'Unsupported key');
      await p.keyboard.press(k);
      break;
    }
    default: throw err(400, 'Unknown input');
  }
  return { status: s.status };
}

export async function cancelRemoteLogin(profileId, user) {
  const s = own(profileId, user);
  if (s.status !== 'done') {
    update('auth_profiles', profileId, { status: profileHasState(profileId) ? 'expired' : 'not_signed_in', status_detail: 'Sign-in cancelled' });
  }
  await close(s);
  return { status: 'cancelled' };
}

export const remoteLoginActive = () => sessions.size > 0;

/** Closes every sign-in browser (shutdown, tests). */
export async function closeAllRemoteLogins() {
  await Promise.all([...sessions.values()].map((s) => close(s)));
}
