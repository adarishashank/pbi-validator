/**
 * Results site on Cloudflare Pages (https://<project>.pages.dev): a free,
 * static, optionally password-protected site with the runs you publish. Each
 * published run gets its interactive report with screenshots, the PDF report
 * and the Excel workbook. The full app keeps running where it is; the results
 * site is read-only.
 *
 * Publishing uses Wrangler (Cloudflare's CLI): it must be signed in on this
 * machine (`npx wrangler login`), or CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID)
 * must be set with the "Cloudflare Pages: Edit" permission.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { q, nowIso } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { runDir } from './queue.js';
import { loadRunBundle, renderHtml } from './export.js';
import { renderRunPdf, runSheets, STATUS_ORDER, STATUS_LABEL } from './report.js';
import { xlsxBuffer } from './xlsx.js';
import { getSetting, setSetting } from '../auth/users.js';

const logger = createLogger('pages');
export const PUBLISHED_DIR = () => path.join(config.dataDir, 'published');
const SITE_DIR = () => path.join(config.dataDir, 'pages-site');
const MAX_FILES = 18_000; // Cloudflare Pages allows 20,000 files per deployment
const RUN_STATUS_LABEL = { passed: 'Passed', failed: 'Failed', diffs: 'Differences found', error: 'Error', cancelled: 'Cancelled' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: config.timezone }) : '—');

// ------------------------------------------------------------------ state
const DEFAULTS = { project: 'pbireporttest', url: '', passwordSet: false, lastDeployAt: null, lastError: null };
export const pagesSettings = () => ({ ...DEFAULTS, ...(getSetting('pages', {}) || {}) });
const savePages = (patch) => { const next = { ...pagesSettings(), ...patch }; setSetting('pages', next); return next; };
const job = { running: false, step: '', startedAt: null, depth: 0 };
// job.running stays true from the first publish step until the last deploy has finished
// (nested/queued phases hold it via a depth counter), so a second publish can't slip into the gap.
const jobStart = (step) => { job.depth++; job.running = true; job.step = step; job.startedAt ??= nowIso(); };
const jobEnd = () => { if (--job.depth <= 0) { job.depth = 0; job.running = false; job.step = ''; job.startedAt = null; } };

export function pagesStatus() {
  const s = pagesSettings();
  const published = q.all('SELECT id, suite_name, status, published_at FROM runs WHERE published_at IS NOT NULL ORDER BY id DESC');
  return { ...s, deploying: job.running, step: job.step, published };
}

// ------------------------------------------------------------------ wrangler
/** Runs Wrangler; the command can be overridden (tests) with PAGES_WRANGLER. */
function wrangler(args, { input } = {}) {
  const cmd = process.env.PAGES_WRANGLER || 'npx';
  const full = process.env.PAGES_WRANGLER ? args : ['-y', 'wrangler@4', ...args];
  return new Promise((resolve, reject) => {
    // Run from an empty folder: Wrangler auto-detects projects in its working
    // directory and could otherwise deploy the app's own files.
    const cwd = path.join(os.tmpdir(), 'pbireporttest-wrangler');
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn(cmd, full, { cwd, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      // eslint-disable-next-line no-control-regex
      const clean = out.replace(/\u001b\[[0-9;]*m/g, '');
      if (code === 0) resolve(clean);
      else reject(Object.assign(new Error(wranglerError(clean)), { output: clean }));
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function wranglerError(out) {
  if (/not authenticated|wrangler login|CLOUDFLARE_API_TOKEN/i.test(out)) return 'Not signed in to Cloudflare. On the server run "npx wrangler login", or set CLOUDFLARE_API_TOKEN (Pages: Edit) and CLOUDFLARE_ACCOUNT_ID.';
  const line = out.split('\n').map((l) => l.trim()).find((l) => /^(✘|\[ERROR\]|ERROR)/.test(l));
  return (line || out.trim().split('\n').slice(-3).join(' ')).replace(/^✘\s*\[ERROR\]\s*/, '').slice(0, 400) || 'Wrangler failed';
}

async function ensureProject(project) {
  try {
    const out = await wrangler(['pages', 'project', 'create', project, '--production-branch', 'main']);
    if (/Delegating to the latest version|workers\.dev/i.test(out)) {
      throw Object.assign(new Error('Cloudflare created this as a Worker (workers.dev) instead of a Pages project (pages.dev). Nothing was published; see the results-site notes in README.'), { output: out });
    }
    logger.info(`Created Cloudflare Pages project ${project}`);
  } catch (e) {
    if (!/already exists|8000002/i.test(e.output || e.message)) throw e;
  }
}

// ------------------------------------------------------------------ build
const linkBar = (run) => `<div style="background:#0b1120;color:#cbd5e1;padding:10px 28px;display:flex;gap:16px;align-items:center;font:13px -apple-system,Segoe UI,Roboto,sans-serif">
  <a href="../../" style="color:#fff;text-decoration:none;font-weight:700">◂ All published runs</a><span style="flex:1"></span>
  <a href="report.pdf" style="color:#facc15;font-weight:700;text-decoration:none">⇩ PDF report</a>
  <a href="report.xlsx" style="color:#facc15;font-weight:700;text-decoration:none">⇩ Excel</a></div>`;

/** Writes data/published/<id>/: report page, screenshots, PDF, Excel and a summary. */
export async function buildPublishedRun(runId) {
  const bundle = loadRunBundle(runId);
  if (!bundle) throw Object.assign(new Error('Run not found'), { status: 404 });
  const { run } = bundle;
  const out = path.join(PUBLISHED_DIR(), String(run.id));
  const fsp = fs.promises;
  await fsp.rm(out, { recursive: true, force: true });
  await fsp.mkdir(path.join(out, 'images'), { recursive: true });
  const src = runDir(run.id);
  const used = new Set();
  const results = bundle.results.map((r) => ({
    ...r,
    images: Object.fromEntries(Object.entries(r.images || {}).filter(([, f]) => f && fs.existsSync(path.join(src, path.basename(f))))
      .map(([k, f]) => { used.add(path.basename(f)); return [k, `images/${path.basename(f)}`]; })),
  }));
  const files = [...used];
  for (let i = 0; i < files.length; i += 16) { // bounded parallelism
    await Promise.all(files.slice(i, i + 16).map((f) => fsp.copyFile(path.join(src, f), path.join(out, 'images', f))));
  }
  await fsp.writeFile(path.join(out, 'index.html'), renderHtml({ ...bundle, results }, { topBar: linkBar(run) }));
  await fsp.writeFile(path.join(out, 'report.pdf'), await renderRunPdf(bundle));
  await fsp.writeFile(path.join(out, 'report.xlsx'), await xlsxBuffer(runSheets(bundle)));
  const by = {};
  for (const r of bundle.results) by[r.status] = (by[r.status] || 0) + 1;
  const S = bundle.ai?.summary?.status === 'done' ? bundle.ai.summary.content : null;
  const reps = run.snapshot?.reports || {};
  await fsp.writeFile(path.join(out, 'meta.json'), JSON.stringify({
    id: run.id, suite: run.suite_name, status: run.status, startedAt: run.started_at || run.queued_at, finishedAt: run.finished_at,
    by, total: bundle.results.length, risk: S?.risk || null, headline: S?.headline || null,
    a: reps.A ? `${reps.A.name}${reps.A.environment ? ` · ${reps.A.environment}` : ''}` : null,
    b: reps.B ? `${reps.B.name}${reps.B.environment ? ` · ${reps.B.environment}` : ''}` : null,
    publishedAt: nowIso(),
  }, null, 2));
  return out;
}

const WORKER = `// Optional password protection for the results site (Cloudflare Pages advanced mode).
// Set it with: npx wrangler pages secret put SITE_PASSWORD --project-name <project>
export default {
  async fetch(request, env) {
    const pw = env.SITE_PASSWORD;
    if (pw) {
      const [scheme, b64] = (request.headers.get('Authorization') || '').split(' ');
      let ok = false;
      if (scheme === 'Basic' && b64) {
        try { const raw = atob(b64); ok = await same(raw.slice(raw.indexOf(':') + 1), pw); } catch { ok = false; }
      }
      if (!ok) {
        return new Response('This results site is password protected.', {
          status: 401, headers: { 'WWW-Authenticate': 'Basic realm="PBI Report Test results", charset="UTF-8"', 'Cache-Control': 'no-store' },
        });
      }
    }
    const res = await env.ASSETS.fetch(request);
    if (!pw) return res;
    const r = new Response(res.body, res);
    r.headers.set('Cache-Control', 'private, no-store');
    return r;
  },
};
async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
`;

const HEADERS = `/*
  X-Robots-Tag: noindex, nofollow
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
`;

function indexHtml(metas) {
  const chip = (s, n) => `<span class="pill s-${esc(s)}">${esc(STATUS_LABEL[s] || s)} ${n}</span>`;
  const cards = metas.map((m) => `<div class="card" data-q="${esc(`${m.suite} ${m.a || ''} ${m.b || ''} ${m.status}`.toLowerCase())}">
    <div class="row"><a class="title" href="runs/${m.id}/">${esc(m.suite)}</a><span class="pill r-${esc(m.status)}">${esc(RUN_STATUS_LABEL[m.status] || m.status)}</span>${m.risk ? `<span class="pill k-${esc(m.risk)}">${esc(m.risk)} risk</span>` : ''}</div>
    <div class="muted">Run #${m.id} · ${esc(fmtDate(m.startedAt))}${m.a ? ` · ${esc(m.a)}${m.b ? ` ⇄ ${esc(m.b)}` : ''}` : ''}</div>
    ${m.headline ? `<div class="headline">${esc(m.headline)}</div>` : ''}
    <div class="row chips">${STATUS_ORDER.filter((s) => m.by[s]).map((s) => chip(s, m.by[s])).join('')}<span class="muted">${m.total} checks</span></div>
    <div class="row links"><a href="runs/${m.id}/">Open report ▸</a><a href="runs/${m.id}/report.pdf">⇩ PDF</a><a href="runs/${m.id}/report.xlsx">⇩ Excel</a></div></div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>PBI Report Test · published results</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23f2c811'/%3E%3Crect x='7' y='16' width='4' height='9' fill='%23111'/%3E%3Crect x='14' y='10' width='4' height='15' fill='%23111'/%3E%3Crect x='21' y='6' width='4' height='19' fill='%23111'/%3E%3C/svg%3E">
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6f9;color:#18202b}
header{background:#0f172a;color:#fff;padding:26px 32px}header .brand{display:flex;gap:12px;align-items:center}
.mark{width:40px;height:40px;border-radius:9px;background:#f2c811;display:grid;place-items:center}
header h1{margin:0;font-size:20px}header p{margin:4px 0 0;color:#94a3b8}
main{max-width:1100px;margin:0 auto;padding:22px 20px 60px}
input{width:100%;max-width:420px;padding:10px 12px;border:1px solid #cfd5de;border-radius:8px;font:inherit;margin-bottom:16px}
.card{background:#fff;border:1px solid #e2e6ec;border-radius:12px;padding:16px 18px;margin-bottom:12px;box-shadow:0 1px 2px rgba(16,24,40,.05)}
.card:hover{border-color:#93b4f5}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.title{font-size:15.5px;font-weight:700;color:#18202b;text-decoration:none}.title:hover{color:#1d4ed8}
.muted{color:#6b7686;font-size:12.5px;margin-top:3px}.headline{margin-top:8px}.chips{margin-top:10px}
.links{margin-top:10px;font-weight:700;color:#1d4ed8;font-size:13px;gap:16px}.links a{color:#1d4ed8;text-decoration:none}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.s-pass,.r-passed,.k-none,.k-low{background:#e9f7ee;color:#15803d}.s-diff,.r-diffs,.k-medium{background:#fff4e0;color:#b45309}
.s-fail,.r-failed,.k-high,.k-critical{background:#fdecec;color:#c81e1e}.s-missing{background:#f2ecff;color:#7c3aed}
.s-error,.r-error{background:#ffe8ee;color:#be123c}.s-warn{background:#fef7d7;color:#a16207}.s-accepted{background:#e0f2fe;color:#0369a1}.s-skipped,.r-cancelled{background:#f0f1f3;color:#6b7280}
.empty{text-align:center;color:#6b7686;padding:60px 0}footer{color:#94a3b8;font-size:12px;text-align:center;margin-top:30px}
</style></head><body>
<header><div class="brand"><div class="mark"><svg width="24" height="24" viewBox="0 0 32 32"><rect x="7" y="16" width="4" height="9" fill="#111"/><rect x="14" y="10" width="4" height="15" fill="#111"/><rect x="21" y="6" width="4" height="19" fill="#111"/></svg></div>
<div><h1>PBI Report Test · results</h1><p>Power BI validation runs published by the team. Open a run for screenshots and details, or download the PDF / Excel.</p></div></div></header>
<main>${metas.length ? `<input type="search" id="q" placeholder="Filter by suite, report or result…">${cards}` : '<div class="empty"><h2>No runs published yet</h2>Publish a run from PBI Report Test (run page → Publish).</div>'}
<footer>Updated ${esc(fmtDate(new Date().toISOString()))} · ${metas.length} run${metas.length === 1 ? '' : 's'}</footer></main>
<script>const q=document.getElementById('q');if(q)q.addEventListener('input',()=>{const t=q.value.toLowerCase();document.querySelectorAll('.card').forEach(c=>{c.style.display=c.dataset.q.includes(t)?'':'none'})});</script>
</body></html>`;
}

const countFiles = async (dir) => {
  let n = 0;
  const walk = async (d) => { for (const e of await fs.promises.readdir(d, { withFileTypes: true })) { if (e.isDirectory()) await walk(path.join(d, e.name)); else n++; } };
  if (fs.existsSync(dir)) await walk(dir);
  return n;
};

/** Assembles data/pages-site from every published run. */
export async function buildSite() {
  const fsp = fs.promises;
  const site = SITE_DIR();
  await fsp.rm(site, { recursive: true, force: true });
  await fsp.mkdir(path.join(site, 'runs'), { recursive: true });
  const rows = q.all('SELECT id FROM runs WHERE published_at IS NOT NULL ORDER BY id DESC');
  const metas = [];
  for (const { id } of rows) {
    const from = path.join(PUBLISHED_DIR(), String(id));
    if (!fs.existsSync(path.join(from, 'meta.json'))) continue;
    await fsp.cp(from, path.join(site, 'runs', String(id)), { recursive: true });
    metas.push(JSON.parse(await fsp.readFile(path.join(from, 'meta.json'), 'utf8')));
  }
  await Promise.all([
    fsp.writeFile(path.join(site, 'index.html'), indexHtml(metas)),
    fsp.writeFile(path.join(site, '_worker.js'), WORKER),
    fsp.writeFile(path.join(site, '_headers'), HEADERS),
    fsp.writeFile(path.join(site, 'robots.txt'), 'User-agent: *\nDisallow: /\n'),
  ]);
  const files = await countFiles(site);
  if (files > MAX_FILES) throw Object.assign(new Error(`The results site would have ${files} files; Cloudflare Pages allows 20,000. Unpublish some runs first.`), { status: 413 });
  return { site, runs: metas.length, files };
}

// ------------------------------------------------------------------ deploy
const serialChain = { p: Promise.resolve() };
const serial = (fn) => { const p = serialChain.p.then(fn, fn); serialChain.p = p.catch(() => {}); return p; };

/** Rebuilds and deploys the whole site (Pages deployments replace the site). */
export function deploySite(reason = 'update') {
  jobStart(job.step || 'Waiting to deploy');
  return serial(async () => {
    try {
      const s = pagesSettings();
      job.step = 'Building the site';
      const built = await buildSite();
      job.step = 'Connecting to Cloudflare';
      await ensureProject(s.project);
      job.step = `Uploading ${built.runs} run(s) to Cloudflare Pages`;
      const out = await wrangler(['pages', 'deploy', built.site, '--project-name', s.project, '--branch', 'main', '--commit-dirty=true', '--commit-message', `PBI Report Test: ${reason}`]);
      const m = /https:\/\/[a-z0-9]+\.([a-z0-9-]+)\.pages\.dev/.exec(out);
      const url = m ? `https://${m[1]}.pages.dev` : (s.url || `https://${s.project}.pages.dev`);
      logger.info(`Published results site ${url} (${built.runs} runs, ${built.files} files)`);
      return savePages({ url, lastDeployAt: nowIso(), lastError: null });
    } catch (e) {
      logger.error(`Results site deploy failed: ${e.message}`);
      savePages({ lastError: e.message });
      throw e;
    } finally {
      jobEnd();
    }
  });
}

export async function publishRun(runId) {
  const run = q.get('SELECT id, status FROM runs WHERE id = ?', runId);
  if (!run) throw Object.assign(new Error('Run not found'), { status: 404 });
  if (['queued', 'running'].includes(run.status)) throw Object.assign(new Error('Wait for the run to finish before publishing it'), { status: 409 });
  jobStart(`Preparing run #${runId} (PDF, Excel, screenshots)`);
  let deploy;
  try {
    await buildPublishedRun(runId);
    q.run('UPDATE runs SET published_at = ? WHERE id = ?', nowIso(), runId);
    deploy = deploySite(`publish run #${runId}`); // takes its own hold on job.running before ours is released
  } finally { jobEnd(); }
  return deploy;
}

export async function unpublishRun(runId) {
  jobStart(`Removing run #${runId}`);
  let deploy;
  try {
    q.run('UPDATE runs SET published_at = NULL WHERE id = ?', runId);
    await fs.promises.rm(path.join(PUBLISHED_DIR(), String(runId)), { recursive: true, force: true });
    deploy = deploySite(`unpublish run #${runId}`);
  } finally { jobEnd(); }
  return deploy;
}

/** Sets (or removes, with an empty value) the site password, then redeploys so it applies. */
export async function setSitePassword(password) {
  const s = pagesSettings();
  jobStart(password ? 'Saving the site password' : 'Removing the site password');
  let deploy;
  try {
    await ensureProject(s.project);
    if (password) await wrangler(['pages', 'secret', 'put', 'SITE_PASSWORD', '--project-name', s.project], { input: password });
    else {
      try { await wrangler(['pages', 'secret', 'delete', 'SITE_PASSWORD', '--project-name', s.project], { input: 'y\n' }); } catch (e) {
        if (!/not found|does not exist/i.test(e.output || e.message)) throw e;
      }
    }
    savePages({ passwordSet: Boolean(password) });
    deploy = deploySite(password ? 'password set' : 'password removed');
  } catch (e) {
    savePages({ lastError: e.message });
    throw e;
  } finally { jobEnd(); }
  return deploy;
}

export const setPagesProject = (project) => savePages({ project, url: '' });
