/**
 * PBI Report Test on Cloudflare: this Worker answers at
 * https://pbireporttest.<account>.workers.dev and forwards every request to a
 * single Cloudflare Container running the app (Node + headless Chromium).
 *
 * The container's disk is fresh on every start, so the container restores its
 * data from R2 when it boots and saves it back every minute and on shutdown
 * (see start.sh). It sleeps after SLEEP_AFTER of inactivity, but never while a
 * validation run is in progress.
 */
import { Container } from '@cloudflare/containers';

const APP_PORT = 4400;
const STARTUP_TIMEOUT_MS = 180_000; // restore from R2 + Node boot
const NEXT_KEY = 'pbirt:nextScheduledRun';   // when the next scheduled suite is due (ISO)
const WAKE_KEY = 'pbirt:lastScheduledWake';  // last time the timer woke the app
const REFRESH_EVERY_MS = 60_000;

export class PbiApp extends Container {
  defaultPort = APP_PORT;
  enableInternet = true; // Power BI, NVIDIA AI and R2 are on the internet

  constructor(ctx, env) {
    super(ctx, env);
    this.sleepAfter = env.SLEEP_AFTER || '30m';
    // Secrets and settings handed to the app (set with `wrangler secret put` / vars).
    const pick = (keys) => Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, String(env[k])]));
    this.envVars = {
      HOST: '0.0.0.0',
      PORT: String(APP_PORT),
      DATA_DIR: '/data',
      // Only this Worker can reach the container and it overwrites the
      // forwarding headers, so they can be trusted.
      TRUST_PROXY: 'true',
      ...pick([
        'API_TOKEN', 'NVIDIA_API_KEY', 'AI_TEXT_MODEL', 'AI_VISION_MODEL', 'AI_AUTO_ANALYZE', 'PUBLIC_URL',
        'TIMEZONE', 'SCHEDULE_CATCHUP_HOURS', 'PBI_TENANT_ID', 'PBI_CLIENT_ID', 'PBI_CLIENT_SECRET',
        'TEMP_PASSWORD_HOURS', 'RUN_RETENTION_DAYS', 'MAX_PARALLEL_RUNS', 'LOG_LEVEL',
        'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT', 'SYNC_INTERVAL_SECONDS',
      ]),
    };
  }

  async ensureStarted() {
    await this.startAndWaitForPorts({ ports: APP_PORT, cancellationOptions: { portReadyTimeoutMS: STARTUP_TIMEOUT_MS } });
  }

  async fetch(request) {
    const state = await this.getState();
    if (state.status !== 'healthy') {
      const wantsPage = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
      if (wantsPage) {
        // Browsers get a friendly page while the app wakes up (restoring data can take a little while).
        this.ctx.waitUntil(this.ensureStarted().catch((e) => console.error('start failed', e)));
        return wakingPage();
      }
      await this.ensureStarted();
    }
    const res = await super.fetch(request);
    // Keep the stored "next scheduled run" fresh while people use the app
    // (e.g. right after someone edits a suite's schedule).
    if (!this.lastRefresh || Date.now() - this.lastRefresh > REFRESH_EVERY_MS) {
      this.lastRefresh = Date.now();
      this.ctx.waitUntil(this.refreshSchedule());
    }
    return res;
  }

  /** Asks the app when the next scheduled run is due and remembers it here. */
  async refreshSchedule() {
    if (!this.env.API_TOKEN) return null;
    try {
      const r = await this.containerFetch('http://container/api/schedules/next', { headers: { Authorization: `Bearer ${this.env.API_TOKEN}` } }, APP_PORT);
      if (!r.ok) { console.warn(`schedule refresh: HTTP ${r.status}`); return null; }
      const { next } = await r.json();
      if (next) await this.ctx.storage.put(NEXT_KEY, next); else await this.ctx.storage.delete(NEXT_KEY);
      return next || null;
    } catch (e) {
      console.warn(`schedule refresh failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Called every minute by the Worker's cron trigger. Costs nothing unless a
   * scheduled run is due: then it wakes the app, whose scheduler starts the
   * due suites (and catches up any missed while it slept).
   */
  async checkSchedule() {
    const next = await this.ctx.storage.get(NEXT_KEY);
    if (!next) return 'nothing scheduled';
    if (Date.parse(next) > Date.now()) return `next run due ${next}`;
    const state = await this.getState();
    if (state.status === 'healthy') { await this.refreshSchedule(); return 'awake: the app starts it'; }
    const lastWake = await this.ctx.storage.get(WAKE_KEY);
    if (lastWake && Date.now() - lastWake < 10 * 60_000) return 'waking (retrying in a few minutes)';
    await this.ctx.storage.put(WAKE_KEY, Date.now());
    console.log(`Waking the app for a scheduled run due ${next}`);
    await this.ensureStarted();
    this.renewActivityTimeout();
    await new Promise((r) => setTimeout(r, 5000)); // the app's start-up tick queues due suites
    await this.refreshSchedule();
    return 'woke the app';
  }

  /** Don't go to sleep in the middle of a validation run. */
  async onActivityExpired() {
    try {
      const r = await this.containerFetch('http://container/api/health', {}, APP_PORT);
      const h = await r.json();
      if (h.busy) { console.log('Run in progress: staying awake'); return; }
    } catch { /* not answering: fine to stop */ }
    await this.refreshSchedule(); // remember the next scheduled run before sleeping
    await this.stop(); // SIGTERM → start.sh saves data to R2, then exits
  }

  onError(error) {
    console.error('Container error:', error);
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // The app trusts these (TRUST_PROXY): overwrite, never append client values.
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') || '');
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    headers.set('x-forwarded-host', url.host);
    const forwarded = new Request(request, { headers });
    return env.APP.getByName('main').fetch(forwarded);
  },

  /** Cron trigger (every minute): wake the app only when a scheduled run is due. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.APP.getByName('main').checkSchedule().then((r) => console.log(`schedule check: ${r}`)));
  },
};

function wakingPage() {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="4">
<title>PBI Report Test · starting…</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0}
.box{text-align:center;max-width:420px;padding:24px}.mark{width:48px;height:48px;border-radius:11px;background:#f2c811;display:inline-grid;place-items:center;margin-bottom:16px}
.spin{width:22px;height:22px;border:3px solid #334155;border-top-color:#f2c811;border-radius:50%;animation:s 1s linear infinite;margin:18px auto 0}@keyframes s{to{transform:rotate(360deg)}}
small{color:#94a3b8}</style></head><body><div class="box">
<div class="mark"><svg width="28" height="28" viewBox="0 0 32 32"><rect x="7" y="16" width="4" height="9" fill="#111"/><rect x="14" y="10" width="4" height="15" fill="#111"/><rect x="21" y="6" width="4" height="19" fill="#111"/></svg></div>
<h2 style="margin:0 0 6px;color:#fff">PBI Report Test is waking up</h2>
<div>It sleeps when nobody is using it. This takes up to a minute; the page refreshes by itself.</div>
<div class="spin"></div><p><small>If it doesn't load within 3 minutes, refresh or contact your administrator.</small></p></div></body></html>`,
  { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '4', 'Cache-Control': 'no-store' } });
}
