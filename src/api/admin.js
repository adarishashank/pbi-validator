import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { z } from 'zod';
import { q, nowIso } from '../db.js';
import { config, ROOT } from '../config.js';
import { aiStatus } from '../ai/client.js';
import { runQueue } from '../jobs/queue.js';
import {
  ROLES, publicUser, getUser, findUserByEmail, createUser, updateUser, revokeUserSessions, listSessions,
  otherActiveAdmins, authSettings, saveAuthSettings,
} from '../auth/users.js';
import { hashPassword, passwordProblem, generatePassword } from '../auth/passwords.js';
import { microsoftProblem, discovery } from '../auth/microsoft.js';
import { redirectUri } from './auth.js';

const router = express.Router();
const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const parse = (schema, body) => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw httpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
};
const idParam = (req) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) throw httpError(400, 'Invalid id');
  return id;
};
const mustUser = (id) => {
  const u = getUser(id);
  if (!u) throw httpError(404, `User #${id} not found`);
  return u;
};
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ------------------------------------------------------------------ users
router.get('/admin/users', (req, res) => {
  const now = nowIso();
  const rows = q.all(`SELECT u.*,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions,
      (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS api_keys,
      (SELECT COUNT(*) FROM runs r WHERE r.triggered_by = u.email) AS runs_started
    FROM users u ORDER BY u.disabled, u.role = 'admin' DESC, u.email`, now);
  res.json(rows.map(publicUser));
});

const NewUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  name: z.string().trim().max(120).optional().default(''),
  role: z.enum(ROLES),
  provider: z.enum(['local', 'microsoft']).default('local'),
  password: z.string().max(200).optional().default(''),
});
router.post('/admin/users', wrap(async (req, res) => {
  const d = parse(NewUserSchema, req.body);
  if (findUserByEmail(d.email)) throw httpError(409, `${d.email} already has an account`);
  let tempPassword = null, passwordHash = null;
  if (d.provider === 'local') {
    if (d.password) {
      const problem = passwordProblem(d.password, { email: d.email });
      if (problem) throw httpError(400, problem);
    } else tempPassword = generatePassword();
    passwordHash = await hashPassword(d.password || tempPassword);
  }
  const user = createUser({ email: d.email, name: d.name, role: d.role, provider: d.provider, passwordHash, mustChange: d.provider === 'local' });
  res.locals.auditTarget = user.email;
  res.locals.auditDetail = { role: d.role, provider: d.provider };
  res.status(201).json({ user: publicUser(user), tempPassword });
}));

const EditUserSchema = z.object({
  name: z.string().trim().max(120).optional(),
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
});
router.put('/admin/users/:id', wrap((req, res) => {
  const id = idParam(req);
  const user = mustUser(id);
  const d = parse(EditUserSchema, req.body);
  const losesAdmin = user.role === 'admin' && !user.disabled && ((d.role && d.role !== 'admin') || d.disabled === true);
  if (losesAdmin && otherActiveAdmins(id) === 0) throw httpError(409, 'This is the last active administrator. Make someone else an admin first.');
  if (id === req.user.id && (d.disabled === true || (d.role && d.role !== req.user.role))) {
    throw httpError(409, 'You can\'t change your own role or disable yourself. Ask another administrator.');
  }
  const patch = {};
  if (d.name !== undefined) patch.name = d.name;
  if (d.role !== undefined) patch.role = d.role;
  if (d.disabled !== undefined) patch.disabled = d.disabled ? 1 : 0;
  const updated = updateUser(id, patch);
  res.locals.auditTarget = user.email;
  res.locals.auditDetail = { ...patch, ...(patch.role ? { previousRole: user.role } : {}) };
  if (d.disabled === true) {
    revokeUserSessions(id);
    q.run('DELETE FROM api_keys WHERE user_id = ?', id);
  }
  res.json(publicUser(updated));
}));

router.delete('/admin/users/:id', wrap((req, res) => {
  const id = idParam(req);
  const user = mustUser(id);
  if (id === req.user.id) throw httpError(409, 'You can\'t delete your own account');
  if (user.role === 'admin' && !user.disabled && otherActiveAdmins(id) === 0) throw httpError(409, 'This is the last active administrator');
  q.run('DELETE FROM users WHERE id = ?', id);
  res.locals.auditTarget = user.email;
  res.status(204).end();
}));

router.post('/admin/users/:id/reset-password', wrap(async (req, res) => {
  const id = idParam(req);
  const user = mustUser(id);
  const tempPassword = generatePassword();
  updateUser(id, { password_hash: await hashPassword(tempPassword), must_change_password: 1 });
  res.locals.auditTarget = user.email;
  const revoked = revokeUserSessions(id);
  res.json({ tempPassword, sessionsRevoked: revoked });
}));

router.get('/admin/users/:id/sessions', wrap((req, res) => {
  const id = idParam(req); mustUser(id);
  res.json(listSessions(id));
}));
router.delete('/admin/users/:id/sessions', wrap((req, res) => {
  const id = idParam(req); mustUser(id);
  res.json({ revoked: revokeUserSessions(id, id === req.user.id ? req.sessionId || '' : '') });
}));

// --------------------------------------------------------------- settings
const settingsOut = (req) => {
  const s = authSettings();
  const { clientSecret, ...ms } = s.microsoft;
  return {
    localLogin: s.localLogin,
    publicUrl: s.publicUrl,
    microsoft: { ...ms, hasSecret: Boolean(clientSecret), problem: microsoftProblem(s.microsoft) },
    locked: s.locked,
    redirectUri: redirectUri(req),
    authorityHost: config.auth.msAuthorityHost,
  };
};
router.get('/admin/settings', (req, res) => res.json(settingsOut(req)));

const list = z.union([z.array(z.string()), z.string()]).optional().transform((v) => (
  v === undefined ? undefined : (Array.isArray(v) ? v : v.split(/[\s,;]+/)).map((x) => x.trim().toLowerCase()).filter(Boolean)
));
const SettingsSchema = z.object({
  localLogin: z.boolean().optional(),
  publicUrl: z.union([z.string().trim().url().refine((u) => /^https?:\/\//.test(u), 'Must start with http(s)://'), z.literal('')]).optional(),
  microsoft: z.object({
    enabled: z.boolean().optional(),
    tenant: z.string().trim().max(100).optional(),
    clientId: z.string().trim().max(100).optional(),
    clientSecret: z.string().trim().max(500).optional(),
    clearSecret: z.boolean().optional(),
    buttonLabel: z.string().trim().max(60).optional(),
    allowedDomains: list,
    allowedTenants: list,
    autoProvision: z.boolean().optional(),
    defaultRole: z.enum(['viewer', 'editor']).optional(),
  }).optional(),
});
router.put('/admin/settings', wrap((req, res) => {
  const d = parse(SettingsSchema, req.body);
  const before = authSettings();
  const after = { ...before, ...d, microsoft: { ...before.microsoft, ...(d.microsoft || {}) } };
  if (d.microsoft?.clearSecret) after.microsoft.clientSecret = '';
  else if (d.microsoft?.clientSecret) after.microsoft.clientSecret = d.microsoft.clientSecret;
  const msReady = !microsoftProblem(after.microsoft);
  if (after.localLogin === false && !msReady) throw httpError(400, 'Finish setting up Microsoft sign-in before turning off password sign-in, or you could lock everyone out.');
  if (after.localLogin === false && !q.get("SELECT id FROM users WHERE role='admin' AND disabled=0 AND ms_oid IS NOT NULL")) {
    throw httpError(400, 'Sign in with Microsoft as an administrator at least once before turning off password sign-in.');
  }
  if (d.publicUrl !== undefined) d.publicUrl = d.publicUrl.replace(/\/+$/, '');
  saveAuthSettings(d);
  const changed = [...Object.keys(d).filter((k) => k !== 'microsoft'), ...Object.keys(d.microsoft || {}).map((k) => `microsoft.${k}`)];
  res.locals.auditDetail = { changed };
  res.json(settingsOut(req));
}));

router.post('/admin/settings/microsoft/test', wrap(async (req, res) => {
  const ms = authSettings().microsoft;
  const tenant = String(req.body?.tenant || ms.tenant || '').trim().toLowerCase();
  if (!tenant) throw httpError(400, 'Enter the Directory (tenant) ID first');
  const d = await discovery(tenant);
  res.json({ ok: true, issuer: d.issuer, authorizationEndpoint: d.authorization_endpoint, problem: microsoftProblem(authSettings().microsoft) });
}));

// ------------------------------------------------------------------ audit
router.get('/admin/audit', (req, res) => {
  const where = [], params = [];
  if (req.query.before) { where.push('id < ?'); params.push(Number(req.query.before)); }
  if (req.query.user) { where.push('user_email LIKE ?'); params.push(`%${String(req.query.user)}%`); }
  if (req.query.action) { where.push('action LIKE ?'); params.push(`${String(req.query.action)}%`); }
  if (req.query.failed === '1') { where.push('(status >= 400 OR action LIKE \'%failed%\' OR action LIKE \'%blocked%\')'); }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = q.all(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`, ...params);
  res.json({ rows, next: rows.length === limit ? rows[rows.length - 1].id : null });
});

// ----------------------------------------------------------------- system
function dirSize(dir) {
  let total = 0, files = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; files += 1; } catch { /* vanished */ } }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

router.get('/admin/system', (req, res) => {
  const count = (sql, ...p) => q.get(sql, ...p).n;
  const now = nowIso();
  res.json({
    version: pkg.version,
    node: process.version,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    uptimeSec: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    dataDir: config.dataDir,
    storage: {
      database: (() => { try { return fs.statSync(config.dbPath).size; } catch { return 0; } })(),
      screenshots: dirSize(config.runsDir),
      discovery: dirSize(config.discoveryDir),
    },
    counts: {
      users: count('SELECT COUNT(*) n FROM users'),
      admins: count("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0"),
      activeSessions: count('SELECT COUNT(*) n FROM sessions WHERE expires_at > ?', now),
      reports: count('SELECT COUNT(*) n FROM reports'),
      suites: count('SELECT COUNT(*) n FROM suites'),
      runs: count('SELECT COUNT(*) n FROM runs'),
      failedLogins24h: count("SELECT COUNT(*) n FROM audit_log WHERE action IN ('login.failed','login.blocked') AND ts > ?", new Date(Date.now() - 86400e3).toISOString()),
    },
    queue: { busy: runQueue.isBusy(), maxParallelRuns: config.maxParallelRuns },
    settings: {
      host: config.host, port: config.port, headless: config.headless, retentionDays: config.runRetentionDays,
      sessionIdleHours: config.auth.sessionIdleHours, sessionMaxDays: config.auth.sessionMaxDays,
      passwordMinLength: config.auth.passwordMinLength, apiTokenSet: Boolean(config.apiToken),
    },
    ai: aiStatus(),
  });
});

export default router;
