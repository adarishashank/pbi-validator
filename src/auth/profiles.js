import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { q, update, nowIso } from '../db.js';
import { createLogger } from '../logger.js';
import { launchBrowser } from '../engine/runner.js';
import { DEFAULT_SELECTORS } from '../engine/selectors.js';

const logger = createLogger('auth');

export const profileStatePath = (id) => path.join(config.authDir, `profile-${id}.json`);

/** Atomic, owner-only write of a Playwright storage state. */
export async function writeStateFile(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await fs.promises.rename(tmp, file);
  await fs.promises.chmod(file, 0o600).catch(() => {});
}

export function validateStorageState(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.cookies)) {
    throw Object.assign(new Error('Not a Playwright storage state: expected { cookies: [...], origins: [...] }'), { status: 400 });
  }
  return { cookies: state.cookies, origins: Array.isArray(state.origins) ? state.origins : [] };
}

const loginRe = new RegExp(DEFAULT_SELECTORS.loginUrl, 'i');
const signedInRe = /app\.powerbi\.com\/(home|groups|reports|apps|links|view|reportEmbed|browse|singleSignOn\?.*ru=)|app\.(fabric\.microsoft|powerbigov\.us|powerbi\.cn)/i;

const activeLogins = new Map();

/**
 * Opens a visible Chromium window so a human can sign in (SSO, MFA, conditional
 * access). When the browser lands on Power BI, the session is captured.
 */
export async function interactiveLogin(profileId, { timeoutMs = 10 * 60 * 1000 } = {}) {
  if (activeLogins.has(profileId)) throw Object.assign(new Error('A sign-in window is already open for this profile'), { status: 409 });
  const profile = q.get('SELECT * FROM auth_profiles WHERE id = ?', profileId);
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });
  const url = profile.login_url || config.loginUrl;
  activeLogins.set(profileId, true);
  update('auth_profiles', profileId, { status: 'signing_in', status_detail: 'Waiting for sign-in in the browser window…' });
  let browser;
  try {
    browser = await launchBrowser({ headless: false });
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    let ok = false;
    while (Date.now() < deadline) {
      if (!browser.isConnected() || page.isClosed()) throw new Error('Sign-in window was closed before completing');
      const u = page.url();
      if (!loginRe.test(u) && (signedInRe.test(u) || (new URL(u).host === new URL(url).host && Date.now() - deadline + timeoutMs > 15000))) {
        // Let the post-login redirect chain settle and tokens land in storage.
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 3000));
        if (!loginRe.test(page.url())) { ok = true; break; }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ok) throw new Error('Timed out waiting for sign-in');
    const state = await context.storageState();
    await writeStateFile(profileStatePath(profileId), state);
    update('auth_profiles', profileId, { status: 'active', status_detail: `Signed in (${state.cookies.length} cookies captured)`, last_login_at: nowIso(), last_checked_at: nowIso() });
    logger.info(`Profile #${profileId} signed in`);
    return { ok: true };
  } catch (e) {
    update('auth_profiles', profileId, { status: fs.existsSync(profileStatePath(profileId)) ? 'expired' : 'not_signed_in', status_detail: e.message });
    throw e;
  } finally {
    activeLogins.delete(profileId);
    await browser?.close().catch(() => {});
  }
}

/** Headless probe: does the saved session still reach Power BI without a login redirect? */
export async function checkProfile(profileId) {
  const profile = q.get('SELECT * FROM auth_profiles WHERE id = ?', profileId);
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });
  const file = profileStatePath(profileId);
  if (!fs.existsSync(file)) {
    update('auth_profiles', profileId, { status: 'not_signed_in', status_detail: 'No saved session', last_checked_at: nowIso() });
    return { status: 'not_signed_in' };
  }
  const browser = await launchBrowser({ headless: true });
  try {
    const context = await browser.newContext({ storageState: file });
    const page = await context.newPage();
    await page.goto(profile.login_url || config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let status = 'active';
    // Redirects to the login page can come late, so keep watching, but stop early once the page
    // has fully loaded on a non-login URL and stayed there for 8 seconds (20 s is the upper bound).
    const t0 = Date.now(), end = t0 + 20000;
    let loadedAt = 0;
    while (Date.now() < end) {
      if (loginRe.test(page.url())) { status = 'expired'; break; }
      if (!loadedAt && await page.evaluate(() => document.readyState === 'complete').catch(() => false)) loadedAt = Date.now();
      if (loadedAt && Date.now() - loadedAt >= 8000) break; // Power BI redirects an expired session only after its app has started
      await new Promise((r) => setTimeout(r, 500));
    }
    if (status === 'active') await writeStateFile(file, await context.storageState());
    const detail = status === 'active' ? 'Session valid' : 'Session expired – sign in again';
    update('auth_profiles', profileId, { status, status_detail: detail, last_checked_at: nowIso() });
    return { status, detail };
  } finally {
    await browser.close().catch(() => {});
  }
}

export function deleteProfileState(profileId) {
  fs.rmSync(profileStatePath(profileId), { force: true });
  update('auth_profiles', profileId, { status: 'not_signed_in', status_detail: 'Session removed' });
}
