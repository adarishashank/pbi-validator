import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { q, insert, update, nowIso } from '../db.js';
import { createLogger } from '../logger.js';
import { executeRun, CancelledError } from '../engine/runner.js';
import { parseSuiteConfig } from '../engine/options.js';
import { profileStatePath, writeStateFile } from '../auth/profiles.js';
import { redact } from '../engine/pbi.js';
import { analyzeRun, setAiEmitter } from '../ai/analysis.js';
import { aiStatus } from '../ai/client.js';
import { loadAcceptances, applyAcceptances } from './acceptances.js';

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
        if (r && !['queued', 'running'].includes(r.status)) { bus.off('run', onRun); resolve(r.status); }
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

    const log = (level, message) => {
      const ts = nowIso();
      q.run('INSERT INTO run_logs (run_id, ts, level, message) VALUES (?,?,?,?)', runId, ts, level, String(message));
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
    const summary = { ...counts, ...engineSummary, durationMs: Date.now() - started };
    update('runs', runId, { status, error, summary, progress: 1, phase: 'Done', finished_at: nowIso() });
    log(status === 'error' ? 'error' : 'info', `Run finished: ${status.toUpperCase()} — ${counts.total} checks in ${(summary.durationMs / 1000).toFixed(0)}s`);
    bus.emit(`run:${runId}`, { type: 'done', status, summary });
    bus.emit('run', { runId, status });

    // AI triage runs after the run is final so it never delays or affects the verdict.
    const aiCfg = snap.config.ai || {};
    if (['passed', 'diffs', 'failed'].includes(status) && aiCfg.enabled !== false && config.ai.autoAnalyze && aiStatus().configured) {
      log('info', `AI analysis queued (${config.ai.textModel})`);
      analyzeRun(runId, { vision: aiCfg.vision !== false, maxVision: aiCfg.maxVisionItems ?? config.ai.maxVisionItems })
        .catch((e) => logger.warn(`AI analysis of run #${runId} failed: ${e.message}`));
    }
  }
}

function statusIcon(s) {
  return { pass: '✔', diff: '≠', fail: '✖', missing: '∅', error: '⚠', warn: '!', skipped: '–', accepted: '✓' }[s] || '•';
}

export const runQueue = new RunQueue();

/** Deletes runs (and artifacts) older than the retention window. */
export function purgeOldRuns(days = config.runRetentionDays) {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const old = q.all(`SELECT id FROM runs WHERE queued_at < ? AND status NOT IN ('queued','running')`, cutoff);
  for (const r of old) deleteRun(r.id);
  if (old.length) logger.info(`Purged ${old.length} run(s) older than ${days} days`);
  return old.length;
}

export function deleteRun(runId) {
  q.run('DELETE FROM runs WHERE id = ?', runId);
  fs.rmSync(runDir(runId), { recursive: true, force: true });
}
