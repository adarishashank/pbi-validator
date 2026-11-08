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
    return super.fetch(request);
  }

  /** Don't go to sleep in the middle of a validation run. */
  async onActivityExpired() {
    try {
      const r = await this.containerFetch('http://container/api/health', {}, APP_PORT);
      const h = await r.json();
      if (h.busy) { console.log('Run in progress: staying awake'); return; }
    } catch { /* not answering: fine to stop */ }
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
