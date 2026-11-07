import express from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import {
  ROLES, ROLE_INFO, publicUser, userCount, getUser, findUserByEmail, createUser, updateUser, createSession, deleteSession,
  revokeUserSessions, listSessions, deleteSessionByPrefix, createApiKey, listApiKeys, audit, authSettings,
  loginBlocked, recordLoginFailure, clearLoginFailures, normEmail,
} from '../auth/users.js';
import { hashPassword, verifyPassword, passwordProblem } from '../auth/passwords.js';
import { microsoftProblem, beginLogin, completeLogin, claimsEmail } from '../auth/microsoft.js';
import {
  setSessionCookie, clearSessionCookie, isLocalRequest, isApiToken, publicOrigin, resolvePrincipal,
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
  const s = authSettings();
  const setupRequired = userCount() === 0;
  res.json({
    setupRequired,
    setupNeedsToken: setupRequired && !isLocalRequest(req),
    setupPossible: !setupRequired || isLocalRequest(req) || Boolean(config.apiToken),
    localLogin: s.localLogin,
    microsoft: { enabled: !microsoftProblem(s.microsoft), label: s.microsoft.buttonLabel || 'Sign in with Microsoft' },
    passwordMinLength: config.auth.passwordMinLength,
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

const LoginSchema = z.object({ email: z.string().trim().max(254), password: z.string().max(500) });
authApi.post('/auth/login', wrap(async (req, res) => {
  const d = parse(LoginSchema, req.body);
  if (!authSettings().localLogin) throw httpError(403, 'Password sign-in is turned off. Use Microsoft sign-in.');
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
  clearLoginFailures(req.ip, d.email);
  setSessionCookie(req, res, createSession(user, req, 'password'));
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
  if (!user.password_hash && user.provider === 'microsoft') throw httpError(400, 'This account signs in with Microsoft and has no password');
  const problem = passwordProblem(d.next, { email: user.email });
  if (problem) throw httpError(400, problem);
  if (user.password_hash && await verifyPassword(d.next, user.password_hash)) throw httpError(400, 'Choose a password different from the current one');
  updateUser(user.id, { password_hash: await hashPassword(d.next), must_change_password: 0 });
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

// ======================================================= /auth/microsoft (browser)
export const browserAuth = express.Router();

const safeReturnTo = (v) => (typeof v === 'string' && /^\/(?!\/)[\w\-./#?=&%]*$/.test(v) ? v : '/');
const loginErrorRedirect = (res, message) => res.redirect(302, `/#/login?error=${encodeURIComponent(message)}`);
export const redirectUri = (req) => `${publicOrigin(req)}/auth/microsoft/callback`;

browserAuth.get('/auth/microsoft/login', wrap(async (req, res) => {
  try {
    res.redirect(302, await beginLogin({ redirectUri: redirectUri(req), returnTo: safeReturnTo(req.query.returnTo) }));
  } catch (e) {
    loginErrorRedirect(res, e.message);
  }
}));

/** Finds or creates the local user for verified Microsoft claims. */
export function userForMicrosoft(claims, req) {
  const ms = authSettings().microsoft;
  const email = claimsEmail(claims);
  const tid = String(claims.tid).toLowerCase();
  if (!email.includes('@')) throw httpError(403, 'Your Microsoft account has no email address');
  const domain = email.split('@')[1];
  if (ms.allowedDomains.length && !ms.allowedDomains.includes(domain)) throw httpError(403, `Accounts from ${domain} are not allowed to sign in here`);

  let user = q.get('SELECT * FROM users WHERE ms_oid = ? AND ms_tid = ?', claims.oid, tid);
  if (!user) {
    const existing = findUserByEmail(email);
    if (existing) {
      if (existing.ms_oid) throw httpError(403, `${email} is already linked to a different Microsoft account`);
      // Safe to link by email: sign-in is restricted to a specific tenant (see microsoftProblem).
      user = updateUser(existing.id, { ms_oid: claims.oid, ms_tid: tid, name: existing.name || claims.name || '' });
      audit(user, 'user.link_microsoft', { target: email, ip: req.ip });
    } else if (ms.autoProvision) {
      user = createUser({ email, name: claims.name || '', role: ms.defaultRole, provider: 'microsoft', msOid: claims.oid, msTid: tid });
      audit(user, 'user.auto_provision', { target: email, ip: req.ip, detail: { role: user.role } });
    } else {
      throw httpError(403, `There's no account for ${email}. Ask an administrator to add you.`);
    }
  }
  if (user.disabled) throw httpError(403, 'Your account is disabled. Contact an administrator.');
  return user;
}

browserAuth.get('/auth/microsoft/callback', wrap(async (req, res) => {
  try {
    const { claims, returnTo } = await completeLogin(req.query);
    const user = userForMicrosoft(claims, req);
    setSessionCookie(req, res, createSession(user, req, 'microsoft'));
    audit(user, 'login.success', { ip: req.ip, detail: { method: 'microsoft', tenant: claims.tid } });
    res.redirect(302, returnTo);
  } catch (e) {
    audit(null, 'login.failed', { status: e.status || 401, ip: req.ip, detail: { method: 'microsoft', reason: e.message } });
    loginErrorRedirect(res, e.message);
  }
}));
