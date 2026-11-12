import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import db, { q, insert, update, nowIso, transaction } from '../db.js';
import { createLogger } from '../logger.js';
import { executeRun, CancelledError } from '../engine/runner.js';
import { parseSuiteConfig } from '../engine/options.js';
import { profileStatePath, writeStateFile } from '../auth/profiles.js';
import { redact } from '../engine/pbi.js';
import { analyzeRun, setAiEmitter } from '../ai/analysis.js';
import { aiStatus } from '../ai/client.js';
import { loadAcceptances, applyAcceptances } from './acceptances.js';
import { writeThumbnail } from './thumbs.js';

const logger = createLogger('queue');
export const bus = new EventEmitter();
bus.setMaxListeners(500);
setAiEmitter((runId, payload) => bus.emit(`run:${runId}`, payload));

export const runDir = (runId) => path.join(config.runsDir, String(runId));

/** One readable sentence for the run banner; the full text stays in the log. */
export function shortError(msg) {
  const first = String(msg || '').split(/\n|Call log:/)[0].trim();
  const m = /^(locator\.\w+|page\.\w+|frame\.\w+): (Timeout \d+ms exceeded)/.exec(first);
  if (m) return `A step in the report timed out (${m[2].replace('Timeout ', '').replace(' exceeded', '')}): something on the page, such as an open dropdown or popup, blocked a click. See the Log tab for details.`;
  return first.length > 300 ? `${first.slice(0, 297)}…` : first;
}

// Buffered run logs of runs in progress; flushed on process exit so a shutdown loses nothing.
const logFlushers = new Set();
process.on('exit', () => { for (const f of logFlushers) { try { f(); } catch { /* db closing */ } } });

const FAIL_STATUSES = new Set(['fail', 'missing', 'error']);

/** Snapshot of everything a run needs, so later edits don't affect history. */
function buildSnapshot(suite) {
  const repA = q.get('SELECT * FROM reports WHERE id = ?', suite.report_a_id);
  const repB = suite.report_b_id ? q.get('SELECT * FROM reports WHERE id = ?', suite.report_b_id) : null;
  if (!repA) throw new Error('Report A no longer exists');
  if (suite.mode === 'compare' && !repB) throw new Error('Compare suites need a report B');
  const pick = (r) => r && ({ id: r.id, name: r.name, url: r.url, environment: r.environment, auth_profile_id: r.auth_profile_id });
  return {
    suite: { id: suite.id, name: suite.name, mode: suite.mode, description: suite.description },
    reports: { A: pick(repA), B: suite.mode === 'compare' ? pick(repB) : null },
    config: parseSuiteConfig(suite.config),
  };
}

class RunQueue {
  constructor() {
    this.pending = [];
    this.active = new Map(); // runId -> AbortController
  }

  enqueue(suiteId, trigger = 'manual', triggeredBy = null) {
    const suite = q.get('SELECT * FROM suites WHERE id = ?', suiteId);
    if (!suite) throw Object.assign(new Error('Suite not found'), { status: 404 });
    const snapshot = buildSnapshot(suite);
    const runId = insert('runs', { suite_id: suite.id, suite_name: suite.name, trigger, triggered_by: triggeredBy, status: 'queued', snapshot, queued_at: nowIso() });
    this.pending.push(runId);
    bus.emit('run', { runId, status: 'queued' });
    logger.info(`Run #${runId} queued for suite "${suite.name}" (${trigger})`);
    setImmediate(() => this.tick());
    return runId;
  }

  cancel(runId) {
    const idx = this.pending.indexOf(runId);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      update('runs', runId, { status: 'cancelled', finished_at: nowIso(), error: 'Cancelled before start' });
      bus.emit('run', { runId, status: 'cancelled' });
      return true;
    }
    const ac = this.active.get(runId);
    if (ac) { ac.abort(); return true; }
    return false;
  }

  isBusy() { return this.active.size > 0 || this.pending.length > 0; }

  tick() {
    while (this.active.size < config.maxParallelRuns && this.pending.length) {
      const runId = this.pending.shift();
      const ac = new AbortController();
      this.active.set(runId, ac);
      this.execute(runId, ac.signal)
        .catch((e) => logger.error(`Run #${runId} crashed: ${e.stack || e}`))
        .finally(() => { this.active.delete(runId); this.tick(); });
    }
  }

  /** Promise that resolves when the run reaches a terminal state. */
  waitFor(runId) {
    return new Promise((resolve) => {
      const check = () => {
        const r = q.get('SELECT status FROM runs WHERE id = ?', runId);
        // A deleted run (no row) must also settle, or this listener would stay on the bus forever.
        if (!r || !['queued', 'running'].includes(r.status)) { bus.off('run', onRun); resolve(r ? r.status : 'deleted'); }
      };
      const onRun = (e) => { if (e.runId === runId) check(); };
      bus.on('run', onRun);
      check();
    });
  }

  async execute(runId, signal) {
    const run = q.get('SELECT * FROM runs WHERE id = ?', runId);
    const snap = run.snapshot;
    const dir = runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const started = Date.now();
    update('runs', runId, { status: 'running', started_at: nowIso(), phase: 'Starting' });
    bus.emit('run', { runId, status: 'running' });

    let seq = 0;
    const counts = { total: 0, byStatus: {}, byScenario: {} };
    const acceptances = loadAcceptances(run.suite_id);
    let lastProgressWrite = 0;

    // Log lines are buffered and written in one transaction (live events still go out immediately).
    const logBuf = [];
    let logTimer = null;
    const flushLogs = () => {
      if (logTimer) { clearTimeout(logTimer); logTimer = null; }
      if (!logBuf.length) return;
      const rows = logBuf.splice(0);
      try {
        transaction(() => { for (const l of rows) q.run('INSERT INTO run_logs (run_id, ts, level, message) VALUES (?,?,?,?)', runId, l.ts, l.level, l.message); });
      } catch (e) { logger.debug(`log flush for run #${runId} failed (run deleted?): ${e.message}`); }
    };
    logFlushers.add(flushLogs);
    const thumbs = [];
    const log = (level, message) => {
      const ts = nowIso();
      logBuf.push({ ts, level, message: String(message) });
      if (logBuf.length >= 200) flushLogs();
      else logTimer ??= setTimeout(flushLogs, 300);
      bus.emit(`run:${runId}`, { type: 'log', ts, level, message });
      if (level !== 'debug') logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'debug'](`#${runId} ${message}`);
    };
    const progress = (fraction, phase) => {
      const now = Date.now();
      const p = Math.max(0, Math.min(1, fraction));
      if (now - lastProgressWrite > 750 || p >= 0.99) {
        lastProgressWrite = now;
        update('runs', runId, { progress: p, phase, summary: counts });
      }
      bus.emit(`run:${runId}`, { type: 'progress', progress: p, phase, counts });
    };
    const record = async (r) => {
      const id = ++seq;
      const images = {};
      for (const [k, buf] of Object.entries(r.images || {})) {
        if (!buf) continue;
        const file = `${String(id).padStart(4, '0')}-${k}.png`;
        await fs.promises.writeFile(path.join(dir, file), buf);
        thumbs.push(writeThumbnail(path.join(dir, file), buf, (m) => logger.debug(m))); // small copy for lists; failure is harmless
        images[k] = file;
      }
      const row = {
        run_id: runId, seq: id, page: r.page || '', scenario: r.scenario, target: r.target || '',
        title: r.title || r.scenario, status: r.status, diff_ratio: r.diffRatio ?? null, diff_pixels: r.diffPixels ?? null,
        images, details: r.details || {}, duration_ms: r.durationMs ?? null,
      };
      applyAcceptances(acceptances, row); // known, accepted differences → status "accepted"
      const rid = insert('results', row);
      counts.total++;
      counts.byStatus[row.status] = (counts.byStatus[row.status] || 0) + 1;
      counts.byScenario[r.scenario] ??= {};
      counts.byScenario[r.scenario][row.status] = (counts.byScenario[r.scenario][row.status] || 0) + 1;
      const level = FAIL_STATUSES.has(row.status) ? 'warn' : row.status === 'diff' ? 'warn' : 'info';
      log(level, `${statusIcon(row.status)} [${r.scenario}] ${row.title}${r.diffRatio ? ` (${(r.diffRatio * 100).toFixed(2)}% px)` : ''}${row.status === 'accepted' ? ` (accepted ${row.details.accepted.originalStatus})` : ''}`);
      bus.emit(`run:${runId}`, { type: 'result', result: { id: rid, ...row, details: undefined } });
    };
    const saveState = async (side, state) => {
      const pid = snap.reports[side]?.auth_profile_id;
      if (!pid) return;
      await writeStateFile(profileStatePath(pid), state);
    };

    const reports = {};
    for (const side of ['A', 'B']) {
      const r = snap.reports[side];
      if (!r) continue;
      const statePath = r.auth_profile_id ? profileStatePath(r.auth_profile_id) : null;
      if (statePath && !fs.existsSync(statePath)) log('warn', `Auth profile for report ${side} has no saved session – opening anonymously`);
      const modelPath = path.join(config.modelsDir, `report-${r.id}.json`);
      reports[side] = { name: r.name, url: r.url, statePath, modelPath: fs.existsSync(modelPath) ? modelPath : null };
    }

    let status = 'passed';
    let error = null;
    let engineSummary = {};
    try {
      log('info', `Run started: ${snap.suite.mode === 'compare' ? `A "${snap.reports.A.name}" ⇄ B "${snap.reports.B.name}"` : `single report "${snap.reports.A.name}"`}`);
      log('debug', `A: ${redact(snap.reports.A.url)}${snap.reports.B ? ` | B: ${redact(snap.reports.B.url)}` : ''}`);
      engineSummary = await executeRun({
        mode: snap.suite.mode, cfg: snap.config, signal, reports, log, progress, record, saveState,
        headless: config.headless, startedAt: Date.now(), parallelPages: config.parallelPages,
      });
      const s = counts.byStatus;
      if ((s.fail || 0) + (s.missing || 0) + (s.error || 0) > 0) status = 'failed';
      else if (s.diff) status = 'diffs';
      else status = 'passed';
    } catch (e) {
      if (e instanceof CancelledError || signal.aborted) {
        status = 'cancelled'; error = 'Cancelled by user';
      } else {
        status = 'error'; error = shortError(e.message);
        log('error', `Run aborted: ${e.message}`);
        if (e.code === 'AUTH_REQUIRED') {
          for (const side of ['A', 'B']) {
            const pid = snap.reports[side]?.auth_profile_id;
            if (pid) update('auth_profiles', pid, { status: 'expired', status_detail: e.message, last_checked_at: nowIso() });
          }
        }
      }
    }
    await Promise.allSettled(thumbs);
    const summary = { ...counts, ...engineSummary, durationMs: Date.now() - started };
    log(status === 'error' ? 'error' : 'info', `Run finished: ${status.toUpperCase()} — ${counts.total} checks in ${(summary.durationMs / 1000).toFixed(0)}s`);
    flushLogs(); // every line must be readable by the time the run is marked finished
    update('runs', runId, { status, error, summary, progress: 1, phase: 'Done', finished_at: nowIso() });
    bus.emit(`run:${runId}`, { type: 'done', status, summary });
    bus.emit('run', { runId, status });

    // AI triage runs after the run is final so it never delays or affects the verdict.
    const aiCfg = snap.config.ai || {};
    if (['passed', 'diffs', 'failed'].includes(status) && aiCfg.enabled !== false && config.ai.autoAnalyze && aiStatus().configured) {
      const s = counts.byStatus;
      // Two reports that match in every check leave nothing to explain. A single
      // report is still reviewed: there the review of its values is the point.
      if (snap.suite.mode === 'compare' && !['diff', 'fail', 'missing', 'error', 'warn'].some((k) => s[k])) {
        log('info', 'AI analysis skipped because every check passed');
      } else {
        log('info', `AI analysis queued (${config.ai.textModel})`);
        analyzeRun(runId, { screenshots: aiCfg.screenshots === true, maxVision: aiCfg.maxVisionItems ?? config.ai.maxVisionItems })
          .catch((e) => logger.warn(`AI analysis of run #${runId} failed: ${e.message}`));
      }
    }
    flushLogs();
    logFlushers.delete(flushLogs);
  }
}

function statusIcon(s) {
  return { pass: '✔', diff: '≠', fail: '✖', missing: '∅', error: '⚠', warn: '!', skipped: '–', accepted: '✓' }[s] || '•';
}

export const runQueue = new RunQueue();

const PURGE_BATCH = 20;
const isoNow = () => new Date().toISOString();

/**
 * Housekeeping: deletes runs (and artifacts) older than the retention window, old audit-log rows
 * (AUDIT_RETENTION_DAYS, default 180), expired sessions and published-site folders of runs that no
 * longer exist. Files are removed asynchronously. Returns how many runs were deleted.
 */
export async function purgeOldRuns(days = config.runRetentionDays) {
  let removed = 0, did = false;
  if (days && days > 0) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const old = q.all(`SELECT id FROM runs WHERE queued_at < ? AND status NOT IN ('queued','running')`, cutoff);
    for (let i = 0; i < old.length; i += PURGE_BATCH) {
      await Promise.all(old.slice(i, i + PURGE_BATCH).map((r) => deleteRunAsync(r.id)));
    }
    removed = old.length;
    if (removed) { did = true; logger.info(`Purged ${removed} run(s) older than ${days} days`); }
  }
  try {
    const auditDays = Number(process.env.AUDIT_RETENTION_DAYS ?? 180);
    if (auditDays > 0) {
      const n = Number(q.run('DELETE FROM audit_log WHERE ts < ?', new Date(Date.now() - auditDays * 86400000).toISOString()).changes);
      if (n) { did = true; logger.info(`Purged ${n} audit-log row(s) older than ${auditDays} days`); }
    }
    const t = isoNow();
    if (Number(q.run('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?', t, t).changes)) did = true;
    // Published-site folders (data/published/<runId>) whose run is gone. Only purely numeric names are touched.
    const pubDir = path.join(config.dataDir, 'published');
    for (const e of await fs.promises.readdir(pubDir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !/^\d+$/.test(e.name) || q.get('SELECT 1 AS x FROM runs WHERE id = ?', Number(e.name))) continue;
      await fs.promises.rm(path.join(pubDir, e.name), { recursive: true, force: true });
      did = true;
      logger.info(`Removed orphaned published run folder ${e.name}`);
    }
    if (did) db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // give the WAL space back after bulk deletes; no VACUUM on the hot path
  } catch (e) { logger.warn(`Housekeeping failed: ${e.message}`); }
  return removed;
}

export function deleteRun(runId) {
  q.run('DELETE FROM runs WHERE id = ?', runId);
  fs.rmSync(runDir(runId), { recursive: true, force: true });
  bus.emit('run', { runId, status: 'deleted' });
}

export async function deleteRunAsync(runId) {
  q.run('DELETE FROM runs WHERE id = ?', runId);
  await fs.promises.rm(runDir(runId), { recursive: true, force: true });
  bus.emit('run', { runId, status: 'deleted' });
}
