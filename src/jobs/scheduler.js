import { Cron } from 'croner';
import { q } from '../db.js';
import { createLogger } from '../logger.js';
import { runQueue, purgeOldRuns } from './queue.js';

const logger = createLogger('scheduler');
const jobs = new Map(); // suiteId -> Cron

export function validateCron(expr) {
  if (!expr) return null;
  try {
    const c = new Cron(expr, { paused: true });
    const next = c.nextRun();
    c.stop();
    return next ? next.toISOString() : null;
  } catch (e) {
    throw Object.assign(new Error(`Invalid cron expression: ${e.message}`), { status: 400 });
  }
}

export function nextRunOf(suiteId) {
  return jobs.get(suiteId)?.nextRun()?.toISOString() ?? null;
}

/** Re-syncs cron jobs with the suites table. Call after any suite change. */
export function syncSchedules() {
  const suites = q.all("SELECT id, name, schedule FROM suites WHERE schedule IS NOT NULL AND schedule != ''");
  const wanted = new Map(suites.map((s) => [s.id, s]));
  for (const [id, job] of jobs) {
    if (!wanted.has(id) || job.__expr !== wanted.get(id).schedule) { job.stop(); jobs.delete(id); }
  }
  for (const s of suites) {
    if (jobs.has(s.id)) continue;
    try {
      const job = new Cron(s.schedule, { protect: true }, () => {
        try {
          const busy = q.get("SELECT id FROM runs WHERE suite_id = ? AND status IN ('queued','running')", s.id);
          if (busy) { logger.warn(`Skipping scheduled run of "${s.name}": run #${busy.id} still active`); return; }
          runQueue.enqueue(s.id, 'schedule');
        } catch (e) { logger.error(`Scheduled run of "${s.name}" failed to queue: ${e.message}`); }
      });
      job.__expr = s.schedule;
      jobs.set(s.id, job);
      logger.info(`Scheduled "${s.name}" (${s.schedule}) — next ${job.nextRun()?.toISOString()}`);
    } catch (e) {
      logger.error(`Invalid schedule for "${s.name}": ${e.message}`);
    }
  }
}

let housekeeping;
export function startHousekeeping() {
  purgeOldRuns();
  housekeeping = new Cron('17 3 * * *', () => purgeOldRuns());
  return housekeeping;
}
