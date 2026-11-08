import fs from 'node:fs';
import express from 'express';
import { z } from 'zod';
import { q, insert, update, nowIso } from '../db.js';
import { config } from '../config.js';
import { runQueue, bus, deleteRun } from '../jobs/queue.js';
import { syncSchedules, validateCron, nextRunOf } from '../jobs/scheduler.js';
import { discoverReport } from '../jobs/discovery.js';
import { loadRunBundle, junitXml, streamHtmlZip } from '../jobs/export.js';
import { runSheets, runsListSheets, renderRunPdf } from '../jobs/report.js';
import { xlsxBuffer } from '../jobs/xlsx.js';
import { SuiteConfigSchema, DEFAULT_SUITE_CONFIG } from '../engine/options.js';
import { DEFAULT_SELECTORS } from '../engine/selectors.js';
import { aiStatus } from '../ai/client.js';
import { analyzeRun, explainResult, askRun, getRunAi } from '../ai/analysis.js';
import {
  interactiveLogin, checkProfile, profileStatePath, writeStateFile, validateStorageState, deleteProfileState,
} from '../auth/profiles.js';

const router = express.Router();

const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const idParam = (req) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) throw httpError(400, 'Invalid id');
  return id;
};
const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) throw httpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
};
const mustGet = (table, id) => {
  const row = q.get(`SELECT * FROM ${table} WHERE id = ?`, id);
  if (!row) throw httpError(404, `${table.slice(0, -1)} #${id} not found`);
  return row;
};

const urlSchema = z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');

// ------------------------------------------------------------------ meta
router.get('/health', (req, res) => res.json({ ok: true, busy: runQueue.isBusy(), time: nowIso() }));

router.get('/meta', (req, res) => res.json({
  defaults: DEFAULT_SUITE_CONFIG,
  selectors: DEFAULT_SELECTORS,
  headless: config.headless,
  maxParallelRuns: config.maxParallelRuns,
  retentionDays: config.runRetentionDays,
  ai: aiStatus(),
}));

// --------------------------------------------------------------------- AI
router.get('/ai/status', (req, res) => res.json(aiStatus()));
router.get('/runs/:id/ai', wrap((req, res) => { const id = idParam(req); mustGet('runs', id); res.json(getRunAi(id)); }));
router.post('/runs/:id/ai/analyze', wrap((req, res) => {
  const id = idParam(req); const run = mustGet('runs', id);
  if (['queued', 'running'].includes(run.status)) throw httpError(409, 'Wait for the run to finish');
  if (!aiStatus().configured) throw httpError(503, 'AI is not configured: set NVIDIA_API_KEY in .env (free key at build.nvidia.com) and restart');
  const vision = req.body?.vision !== false && run.snapshot?.config?.ai?.vision !== false;
  analyzeRun(id, { vision }).catch(() => {});
  res.status(202).json({ started: true });
}));
router.post('/results/:id/ai/explain', wrap(async (req, res) => {
  const id = idParam(req); mustGet('results', id);
  res.json(await explainResult(id));
}));
const AskSchema = z.object({
  question: z.string().trim().min(2).max(2000),
  history: z.array(z.object({ question: z.string().max(4000), answer: z.string().max(12000) })).max(20).optional().default([]),
});
router.post('/runs/:id/ai/ask', wrap(async (req, res) => {
  const id = idParam(req); mustGet('runs', id);
  const d = parse(AskSchema, req.body);
  res.json(await askRun(id, d.question, d.history));
}));

router.get('/stats', (req, res) => {
  const count = (sql, ...p) => q.get(sql, ...p).n;
  const recent = q.all("SELECT status FROM runs WHERE status NOT IN ('queued','running') ORDER BY id DESC LIMIT 50");
  res.json({
    reports: count('SELECT COUNT(*) n FROM reports'),
    suites: count('SELECT COUNT(*) n FROM suites'),
    runs: count('SELECT COUNT(*) n FROM runs'),
    active: count("SELECT COUNT(*) n FROM runs WHERE status IN ('queued','running')"),
    passRate: recent.length ? recent.filter((r) => r.status === 'passed').length / recent.length : null,
    profilesNeedingLogin: count("SELECT COUNT(*) n FROM auth_profiles WHERE status != 'active'"),
  });
});

// --------------------------------------------------------- auth profiles
const ProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional().default(''),
  login_url: z.union([urlSchema, z.literal('')]).optional().default(''),
});

const profileOut = (p) => ({ ...p, has_session: fs.existsSync(profileStatePath(p.id)) });

router.get('/profiles', (req, res) => res.json(q.all('SELECT * FROM auth_profiles ORDER BY name').map(profileOut)));
router.post('/profiles', wrap((req, res) => {
  const d = parse(ProfileSchema, req.body);
  if (q.get('SELECT id FROM auth_profiles WHERE name = ?', d.name)) throw httpError(409, 'A profile with that name exists');
  const id = insert('auth_profiles', d);
  res.status(201).json(profileOut(mustGet('auth_profiles', id)));
}));
router.put('/profiles/:id', wrap((req, res) => {
  const id = idParam(req); mustGet('auth_profiles', id);
  update('auth_profiles', id, parse(ProfileSchema, req.body));
  res.json(profileOut(mustGet('auth_profiles', id)));
}));
router.delete('/profiles/:id', wrap((req, res) => {
  const id = idParam(req); mustGet('auth_profiles', id);
  deleteProfileState(id);
  q.run('DELETE FROM auth_profiles WHERE id = ?', id);
  res.status(204).end();
}));
router.post('/profiles/:id/login', wrap((req, res) => {
  const id = idParam(req); mustGet('auth_profiles', id);
  interactiveLogin(id).catch(() => {}); // status is tracked on the profile row
  res.status(202).json({ started: true, message: 'A browser window has opened on the machine running the validator. Sign in there (MFA supported); the session is captured automatically.' });
}));
router.post('/profiles/:id/check', wrap(async (req, res) => {
  const id = idParam(req); mustGet('auth_profiles', id);
  res.json(await checkProfile(id));
}));
router.post('/profiles/:id/import', wrap(async (req, res) => {
  const id = idParam(req); mustGet('auth_profiles', id);
  const state = validateStorageState(req.body?.state ?? req.body);
  await writeStateFile(profileStatePath(id), state);
  update('auth_profiles', id, { status: 'active', status_detail: `Imported session (${state.cookies.length} cookies)`, last_login_at: nowIso() });
  res.json(profileOut(mustGet('auth_profiles', id)));
}));
router.delete('/profiles/:id/session', wrap((req, res) => {
  const id = idParam(req); mustGet('auth_profiles', id);
  deleteProfileState(id);
  res.json(profileOut(mustGet('auth_profiles', id)));
}));

// ---------------------------------------------------------------- reports
const ReportSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: urlSchema,
  environment: z.string().trim().max(40).optional().default(''),
  auth_profile_id: z.number().int().positive().nullable().optional().default(null),
  tags: z.string().max(300).optional().default(''),
  notes: z.string().max(4000).optional().default(''),
});

router.get('/reports', (req, res) => {
  res.json(q.all(`SELECT r.*, p.name AS auth_profile_name, p.status AS auth_profile_status FROM reports r LEFT JOIN auth_profiles p ON p.id = r.auth_profile_id ORDER BY r.updated_at DESC`));
});
router.get('/reports/:id', wrap((req, res) => res.json(mustGet('reports', idParam(req)))));
router.post('/reports', wrap((req, res) => {
  const d = parse(ReportSchema, req.body);
  if (d.auth_profile_id) mustGet('auth_profiles', d.auth_profile_id);
  const id = insert('reports', d);
  res.status(201).json(mustGet('reports', id));
}));
router.put('/reports/:id', wrap((req, res) => {
  const id = idParam(req); mustGet('reports', id);
  const d = parse(ReportSchema, req.body);
  if (d.auth_profile_id) mustGet('auth_profiles', d.auth_profile_id);
  update('reports', id, { ...d, updated_at: nowIso() });
  res.json(mustGet('reports', id));
}));
router.delete('/reports/:id', wrap((req, res) => {
  const id = idParam(req); mustGet('reports', id);
  const used = q.all('SELECT name FROM suites WHERE report_a_id = ? OR report_b_id = ?', id, id);
  if (used.length && req.query.force !== '1') throw httpError(409, `Report is used by suite(s): ${used.map((s) => s.name).join(', ')}`);
  q.run('DELETE FROM reports WHERE id = ?', id);
  syncSchedules();
  res.status(204).end();
}));
router.post('/reports/:id/discover', wrap(async (req, res) => {
  const id = idParam(req); mustGet('reports', id);
  res.json(await discoverReport(id));
}));

// ----------------------------------------------------------------- suites
const SuiteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  mode: z.enum(['compare', 'single']).default('compare'),
  report_a_id: z.number().int().positive(),
  report_b_id: z.number().int().positive().nullable().optional().default(null),
  config: z.any().optional().default({}),
  schedule: z.string().trim().max(120).optional().default(''),
}).superRefine((s, c) => {
  if (s.mode === 'compare' && !s.report_b_id) c.addIssue({ code: 'custom', path: ['report_b_id'], message: 'Compare mode needs report B' });
  if (s.mode === 'compare' && s.report_a_id === s.report_b_id) c.addIssue({ code: 'custom', path: ['report_b_id'], message: 'Report B must differ from report A' });
});

const suiteOut = (s) => {
  const last = q.get('SELECT id, status, progress, finished_at, summary FROM runs WHERE suite_id = ? ORDER BY id DESC LIMIT 1', s.id);
  return { ...s, last_run: last || null, next_run: nextRunOf(s.id) };
};

function normaliseSuite(body) {
  const d = parse(SuiteSchema, body);
  mustGet('reports', d.report_a_id);
  if (d.mode === 'compare') mustGet('reports', d.report_b_id); else d.report_b_id = null;
  const cfg = SuiteConfigSchema.safeParse(d.config ?? {});
  if (!cfg.success) throw httpError(400, `config: ${cfg.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  d.config = cfg.data;
  validateCron(d.schedule);
  return d;
}

router.get('/suites', (req, res) => res.json(q.all('SELECT * FROM suites ORDER BY name').map(suiteOut)));
router.get('/suites/:id', wrap((req, res) => res.json(suiteOut(mustGet('suites', idParam(req))))));
router.post('/suites', wrap((req, res) => {
  const d = normaliseSuite(req.body);
  if (q.get('SELECT id FROM suites WHERE name = ?', d.name)) throw httpError(409, 'A suite with that name exists');
  const id = insert('suites', d);
  syncSchedules();
  res.status(201).json(suiteOut(mustGet('suites', id)));
}));
router.put('/suites/:id', wrap((req, res) => {
  const id = idParam(req); mustGet('suites', id);
  const d = normaliseSuite(req.body);
  const clash = q.get('SELECT id FROM suites WHERE name = ? AND id != ?', d.name, id);
  if (clash) throw httpError(409, 'A suite with that name exists');
  update('suites', id, { ...d, updated_at: nowIso() });
  syncSchedules();
  res.json(suiteOut(mustGet('suites', id)));
}));
router.delete('/suites/:id', wrap((req, res) => {
  const id = idParam(req); mustGet('suites', id);
  q.run('DELETE FROM suites WHERE id = ?', id);
  syncSchedules();
  res.status(204).end();
}));
router.post('/suites/:id/run', wrap((req, res) => {
  const id = idParam(req); mustGet('suites', id);
  const runId = runQueue.enqueue(id, 'manual', req.user?.email || null);
  res.status(202).json({ runId });
}));

// ------------------------------------------------------------------- runs
const listRuns = (query, max = 500) => {
  const where = [], params = [];
  if (query.suite) { where.push('suite_id = ?'); params.push(Number(query.suite)); }
  if (query.status) { where.push('status = ?'); params.push(String(query.status)); }
  const limit = Math.min(Number(query.limit) || 100, max);
  return q.all(`SELECT id, suite_id, suite_name, trigger, triggered_by, status, progress, phase, summary, error, queued_at, started_at, finished_at FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`, ...params);
};
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const download = (res, type, filename) => res.type(type).setHeader('Content-Disposition', `attachment; filename="${filename}"`);
const stamp = () => new Date().toISOString().slice(0, 10);

router.get('/runs', (req, res) => res.json(listRuns(req.query)));
router.get('/runs/export.xlsx', wrap(async (req, res) => {
  const buf = await xlsxBuffer(runsListSheets(listRuns({ ...req.query, limit: req.query.limit || 5000 }, 5000)));
  download(res, XLSX_TYPE, `pbi-validation-runs-${stamp()}.xlsx`).send(buf);
}));
router.get('/runs/:id', wrap((req, res) => res.json(mustGet('runs', idParam(req)))));
router.delete('/runs/:id', wrap((req, res) => {
  const id = idParam(req); const run = mustGet('runs', id);
  if (['queued', 'running'].includes(run.status)) throw httpError(409, 'Cancel the run before deleting it');
  deleteRun(id);
  res.status(204).end();
}));
router.post('/runs/:id/cancel', wrap((req, res) => {
  const id = idParam(req); mustGet('runs', id);
  res.json({ cancelled: runQueue.cancel(id) });
}));
router.post('/runs/:id/rerun', wrap((req, res) => {
  const run = mustGet('runs', idParam(req));
  if (!run.suite_id) throw httpError(409, 'The suite for this run was deleted');
  res.status(202).json({ runId: runQueue.enqueue(run.suite_id, 'rerun', req.user?.email || null) });
}));
router.get('/runs/:id/results', wrap((req, res) => {
  const id = idParam(req);
  res.json(q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', id));
}));
router.get('/runs/:id/logs', wrap((req, res) => {
  const id = idParam(req);
  res.json(q.all('SELECT id, ts, level, message FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id LIMIT 5000', id, Number(req.query.after) || 0));
}));
router.get('/runs/:id/events', wrap((req, res) => {
  const id = idParam(req); mustGet('runs', id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const onEvt = (e) => send(e);
  bus.on(`run:${id}`, onEvt);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off(`run:${id}`, onEvt); });
}));
router.get('/runs/:id/export.json', wrap((req, res) => {
  const b = loadRunBundle(idParam(req));
  if (!b) throw httpError(404, 'Run not found');
  res.setHeader('Content-Disposition', `attachment; filename="pbi-validation-run-${b.run.id}.json"`);
  res.json(b);
}));
router.get('/runs/:id/junit.xml', wrap((req, res) => {
  const b = loadRunBundle(idParam(req));
  if (!b) throw httpError(404, 'Run not found');
  res.type('application/xml').setHeader('Content-Disposition', `attachment; filename="pbi-validation-run-${b.run.id}.junit.xml"`);
  res.send(junitXml(b));
}));
router.get('/runs/:id/export.xlsx', wrap(async (req, res) => {
  const b = loadRunBundle(idParam(req));
  if (!b) throw httpError(404, 'Run not found');
  download(res, XLSX_TYPE, `pbi-validation-run-${b.run.id}.xlsx`).send(await xlsxBuffer(runSheets(b)));
}));
router.get('/runs/:id/report.pdf', wrap(async (req, res) => {
  const b = loadRunBundle(idParam(req));
  if (!b) throw httpError(404, 'Run not found');
  if (['queued', 'running'].includes(b.run.status)) throw httpError(409, 'The run is still in progress; export it when it has finished');
  const pdf = await renderRunPdf(b);
  // inline: opens in the browser's PDF viewer; ?download=1 saves straight to disk.
  res.type('application/pdf').setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="pbi-validation-run-${b.run.id}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
}));
router.get('/runs/:id/export.zip', wrap((req, res) => {
  const b = loadRunBundle(idParam(req));
  if (!b) throw httpError(404, 'Run not found');
  streamHtmlZip(b, res);
}));

export default router;
