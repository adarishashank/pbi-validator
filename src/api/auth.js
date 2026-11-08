import express from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import {
  ROLES, ROLE_INFO, publicUser, userCount, getUser, findUserByEmail, createUser, updateUser, createSession, deleteSession,
  revokeUserSessions, listSessions, deleteSessionByPrefix, createApiKey, listApiKeys, audit,
  loginBlocked, recordLoginFailure, clearLoginFailures, normEmail, tempPasswordExpired,
} from '../auth/users.js';
import { hashPassword, verifyPassword, passwordProblem } from '../auth/passwords.js';
import {
  setSessionCookie, clearSessionCookie, isLocalRequest, isApiToken, resolvePrincipal,
} from '../auth/middleware.js';

const logger = createLogger('auth');
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const parse = (schema, body) => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw httpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
};
const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

export const meOut = (user, method) => ({
  user: user.system ? { id: null, email: 'API_TOKEN', name: 'API token', role: 'admin', system: true } : publicUser(user),
  method,
  roles: ROLES,
  roleInfo: ROLE_INFO,
});

// ===================================================================== /api/auth
export const authApi = express.Router();

authApi.get('/auth/config', (req, res) => {
  const setupRequired = userCount() === 0;
  res.json({
    setupRequired,
    setupNeedsToken: setupRequired && !isLocalRequest(req),
    setupPossible: !setupRequired || isLocalRequest(req) || Boolean(config.apiToken),
    passwordMinLength: config.auth.passwordMinLength,
    sessionIdleHours: config.auth.sessionIdleHours,
    tempPasswordHours: config.auth.tempPasswordHours,
    version: config.version,
  });
});

const SetupSchema = z.object({
  email: emailSchema,
  name: z.string().trim().max(120).optional().default(''),
  password: z.string(),
  setupToken: z.string().optional().default(''),
});
authApi.post('/auth/setup', wrap(async (req, res) => {
  if (userCount() > 0) throw httpError(409, 'Setup is already complete. Sign in instead.');
  const d = parse(SetupSchema, req.body);
  if (!isLocalRequest(req)) {
    if (!config.apiToken) throw httpError(403, 'Create the first administrator from the machine running the validator (http://127.0.0.1), or set API_TOKEN to allow remote setup.');
    if (!isApiToken(d.setupToken)) throw httpError(403, 'Invalid setup token (the API_TOKEN from .env)');
  }
  const problem = passwordProblem(d.password, { email: d.email });
  if (problem) throw httpError(400, problem);
  const passwordHash = await hashPassword(d.password);
  if (userCount() > 0) throw httpError(409, 'Setup is already complete. Sign in instead.');
  const user = createUser({ email: d.email, name: d.name, role: 'admin', provider: 'local', passwordHash });
  audit(user, 'setup.first_admin', { target: user.email, ip: req.ip });
  logger.info(`First administrator created: ${user.email}`);
  setSessionCookie(req, res, createSession(user, req, 'password'));
  res.status(201).json(meOut(getUser(user.id), 'session'));
}));

const LoginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address').max(254),
  password: z.string().min(1, 'Enter your password').max(500),
  remember: z.boolean().optional().default(true),
});
authApi.post('/auth/login', wrap(async (req, res) => {
  const d = parse(LoginSchema, req.body);
  const wait = loginBlocked(req.ip, d.email);
  if (wait) {
    audit(normEmail(d.email), 'login.blocked', { status: 429, ip: req.ip });
    throw httpError(429, `Too many failed attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
  }
  const user = findUserByEmail(d.email);
  const ok = await verifyPassword(d.password, user?.password_hash);
  if (!ok || !user) {
    recordLoginFailure(req.ip, d.email);
    audit(user || normEmail(d.email), 'login.failed', { status: 401, ip: req.ip, detail: { reason: user ? 'bad_password' : 'unknown_user' } });
    throw httpError(401, 'Incorrect email or password');
  }
  if (user.disabled) {
    audit(user, 'login.failed', { status: 403, ip: req.ip, detail: { reason: 'disabled' } });
    throw httpError(403, 'Your account is disabled. Contact an administrator.');
  }
  if (tempPasswordExpired(user)) {
    audit(user, 'login.failed', { status: 403, ip: req.ip, detail: { reason: 'temporary_password_expired' } });
    throw httpError(403, 'Your temporary password has expired. Ask an administrator to generate a new one (Admin → Users → New temporary password).', { tempPasswordExpired: true });
  }
  clearLoginFailures(req.ip, d.email);
  setSessionCookie(req, res, createSession(user, req, 'password'), { persistent: d.remember });
  audit(user, 'login.success', { ip: req.ip, detail: { method: 'password' } });
  res.json(meOut(getUser(user.id), 'session'));
}));

authApi.post('/auth/logout', (req, res) => {
  const p = resolvePrincipal(req);
  if (p?.sessionId) {
    deleteSession(p.sessionId);
    audit(p.user, 'logout', { ip: req.ip });
  }
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Public so the UI can ask "who am I?" without a 401: { user: null } when signed out.
authApi.get('/auth/me', (req, res) => res.json(req.user ? meOut(req.user, req.authMethod) : { user: null }));

const PasswordSchema = z.object({ current: z.string().max(500).optional().default(''), next: z.string() });
authApi.post('/auth/password', wrap(async (req, res) => {
  if (req.user.system) throw httpError(400, 'The API token has no password');
  const d = parse(PasswordSchema, req.body);
  const user = getUser(req.user.id);
  if (user.password_hash && !user.must_change_password && !(await verifyPassword(d.current, user.password_hash))) {
    throw httpError(400, 'Current password is incorrect');
  }
  const problem = passwordProblem(d.next, { email: user.email });
  if (problem) throw httpError(400, problem);
  if (user.password_hash && await verifyPassword(d.next, user.password_hash)) throw httpError(400, 'Choose a password different from the current one');
  updateUser(user.id, { password_hash: await hashPassword(d.next), must_change_password: 0, temp_password_expires_at: null });
  const revoked = revokeUserSessions(user.id, req.sessionId || '');
  res.json({ ok: true, otherSessionsSignedOut: revoked });
}));

const ProfileSchema = z.object({ name: z.string().trim().max(120) });
authApi.put('/auth/me', wrap((req, res) => {
  if (req.user.system) throw httpError(400, 'The API token has no profile');
  const d = parse(ProfileSchema, req.body);
  res.json(meOut(updateUser(req.user.id, { name: d.name }), req.authMethod));
}));

authApi.get('/auth/sessions', (req, res) => {
  if (req.user.system) return res.json([]);
  const current = req.sessionId?.slice(0, 16);
  res.json(listSessions(req.user.id).map((s) => ({ ...s, current: s.id === current })));
});
authApi.delete('/auth/sessions', (req, res) => {
  if (req.user.system) return res.json({ revoked: 0 });
  res.json({ revoked: revokeUserSessions(req.user.id, req.sessionId || '') });
});
authApi.delete('/auth/sessions/:id', (req, res) => {
  if (req.user.system) return res.json({ revoked: 0 });
  res.json({ revoked: deleteSessionByPrefix(req.user.id, req.params.id) });
});

const KeySchema = z.object({ name: z.string().trim().min(1).max(80), expiresDays: z.number().int().min(0).max(730).optional().default(90) });
authApi.get('/auth/api-keys', (req, res) => res.json(req.user.system ? [] : listApiKeys(req.user.id)));
authApi.post('/auth/api-keys', wrap((req, res) => {
  if (req.user.system) throw httpError(400, 'Sign in as a user to create personal API keys');
  const d = parse(KeySchema, req.body);
  if (listApiKeys(req.user.id).length >= 20) throw httpError(400, 'You already have 20 API keys; delete one first');
  const k = createApiKey(req.user.id, d.name, d.expiresDays);
  res.status(201).json({ ...k, name: d.name, note: 'Copy this key now; it will not be shown again.' });
}));
authApi.delete('/auth/api-keys/:id', wrap((req, res) => {
  const r = q.run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id ?? -1);
  if (!Number(r.changes)) throw httpError(404, 'API key not found');
  res.status(204).end();
}));
