import { Cron } from 'croner';
import { q } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { runQueue, purgeOldRuns } from './queue.js';

// Due-time scheduling: each scheduled suite stores when it is next due
// (suites.next_scheduled_at). A tick every 30 s starts suites that are due.
// Because the due time is persisted, a schedule that came due while the app
// was asleep (Cloudflare) or restarting is caught up once on the next start,
// instead of being lost. Cron times are interpreted in config.timezone.

const logger = createLogger('scheduler');
const TICK_MS = 30_000;

const cronOf = (expr) => new Cron(expr, { paused: true, timezone: config.timezone });

/** Next occurrence of a cron expression after `from` (ISO string), or null. */
export function nextAfter(expr, from = new Date()) {
  if (!expr) return null;
  const c = cronOf(expr);
  try { return c.nextRun(from)?.toISOString() ?? null; } finally { c.stop(); }
}

export function validateCron(expr) {
  if (!expr) return null;
  try {
    return nextAfter(expr);
  } catch (e) {
    throw Object.assign(new Error(`Invalid cron expression: ${e.message}`), { status: 400 });
  }
}

export function nextRunOf(suiteId) {
  return q.get('SELECT next_scheduled_at FROM suites WHERE id = ?', suiteId)?.next_scheduled_at ?? null;
}

/** Earliest due time across all scheduled suites (used by the Cloudflare wake-up timer). */
export function nextScheduledAt() {
  return q.get("SELECT MIN(next_scheduled_at) AS n FROM suites WHERE schedule IS NOT NULL AND schedule != '' AND next_scheduled_at IS NOT NULL")?.n ?? null;
}

/**
 * Brings stored due times in line with the suites table. Call after any suite
 * change. A suite whose schedule changed (or is new) gets a fresh due time;
 * an existing past-due time is kept so the next tick can catch it up.
 */
export function syncSchedules({ resetSuiteId = null } = {}) {
  q.run("UPDATE suites SET next_scheduled_at = NULL WHERE (schedule IS NULL OR schedule = '') AND next_scheduled_at IS NOT NULL");
  const suites = q.all("SELECT id, name, schedule, next_scheduled_at FROM suites WHERE schedule IS NOT NULL AND schedule != ''");
  for (const s of suites) {
    if (s.next_scheduled_at && s.id !== resetSuiteId) continue;
    try {
      const next = nextAfter(s.schedule);
      q.run('UPDATE suites SET next_scheduled_at = ? WHERE id = ?', next, s.id);
      logger.info(`Scheduled "${s.name}" (${s.schedule}, ${config.timezone}): next ${next}`);
    } catch (e) {
      logger.error(`Invalid schedule for "${s.name}": ${e.message}`);
    }
  }
}

/** Starts every suite that is due. Returns the run ids queued (for tests). */
export function runDueSchedules(now = new Date()) {
  const queued = [];
  const due = q.all("SELECT id, name, schedule, next_scheduled_at FROM suites WHERE schedule IS NOT NULL AND schedule != '' AND next_scheduled_at IS NOT NULL AND next_scheduled_at <= ?", now.toISOString());
  for (const s of due) {
    let next = null;
    try { next = nextAfter(s.schedule, now); } catch (e) { logger.error(`Invalid schedule for "${s.name}": ${e.message}`); }
    // Advance first so a crash can't make the same occurrence fire twice.
    q.run('UPDATE suites SET next_scheduled_at = ? WHERE id = ?', next, s.id);
    const lateHours = (now - Date.parse(s.next_scheduled_at)) / 3600e3;
    if (lateHours > config.scheduleCatchUpHours) {
      logger.warn(`Skipping missed run of "${s.name}" due ${s.next_scheduled_at} (more than ${config.scheduleCatchUpHours} h ago)`);
      continue;
    }
    const busy = q.get("SELECT id FROM runs WHERE suite_id = ? AND status IN ('queued','running')", s.id);
    if (busy) { logger.warn(`Skipping scheduled run of "${s.name}": run #${busy.id} still active`); continue; }
    try {
      const runId = runQueue.enqueue(s.id, 'schedule');
      queued.push(runId);
      logger.info(`Scheduled run #${runId} of "${s.name}"${lateHours > 0.05 ? ` (catch-up, due ${s.next_scheduled_at})` : ''}; next ${next}`);
    } catch (e) { logger.error(`Scheduled run of "${s.name}" failed to queue: ${e.message}`); }
  }
  return queued;
}

let ticker;
export function startScheduler() {
  syncSchedules();
  runDueSchedules();
  ticker = setInterval(() => { try { runDueSchedules(); } catch (e) { logger.error(`Scheduler tick failed: ${e.message}`); } }, TICK_MS);
  ticker.unref?.();
  return ticker;
}

let housekeeping;
export function startHousekeeping() {
  purgeOldRuns();
  housekeeping = new Cron('17 3 * * *', { timezone: config.timezone }, () => purgeOldRuns());
  return housekeeping;
}
