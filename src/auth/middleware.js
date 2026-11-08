import crypto from 'node:crypto';
import { config } from '../config.js';
import { resolveSession, resolveApiKey, hasRole, audit, authSettings, sessionCookieMaxAge } from './users.js';

export const SESSION_COOKIE = 'pbiv_session';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_API = new Set(['/health', '/auth/config', '/auth/login', '/auth/setup', '/auth/logout', '/auth/me']);

// The legacy shared API_TOKEN still works as a Bearer token (CI, scripts) and
// acts as a built-in administrator.
const SYSTEM_USER = Object.freeze({ id: null, email: 'API_TOKEN', name: 'API token', role: 'admin', system: true });

const readCookie = (req, name) => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
};

const tokenEquals = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export const isApiToken = (t) => Boolean(config.apiToken) && tokenEquals(t, config.apiToken);

// req.host (Express 5) includes the port and honours X-Forwarded-Host only from trusted proxies.
export const requestOrigin = (req) => `${req.protocol}://${req.host}`;
export const publicOrigin = (req) => authSettings().publicUrl || requestOrigin(req);

/** A request made on this machine directly (not through a tunnel or proxy). */
export function isLocalRequest(req) {
  const ip = req.socket?.remoteAddress || '';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  return loopback && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers.forwarded;
}

/** persistent=false → a browser-session cookie, gone when the browser is closed ("Keep me signed in" unticked). */
export function setSessionCookie(req, res, token, { persistent = true } = {}) {
  const secure = req.secure ? '; Secure' : '';
  const maxAge = persistent ? `; Max-Age=${sessionCookieMaxAge()}` : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${maxAge}${secure}`);
}
export function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`);
  res.append('Set-Cookie', 'pbiv_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); // legacy cookie
}

export function resolvePrincipal(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer) {
    if (isApiToken(bearer)) return { user: SYSTEM_USER, method: 'api_token' };
    const k = resolveApiKey(bearer);
    if (k) return { user: k.user, method: 'api_key' };
    return null;
  }
  const s = resolveSession(readCookie(req, SESSION_COOKIE));
  if (s) return { user: s.user, method: 'session', sessionId: s.sessionId };
  return null;
}

/** Minimum role per endpoint: admin area → admin; reads and AI questions → viewer; other writes → editor. */
export function requiredRole(method, path) {
  if (path.startsWith('/admin/')) return 'admin';
  if (path.startsWith('/auth/')) return 'viewer';
  if (SAFE.has(method)) return 'viewer';
  if (method === 'POST' && /^\/runs\/\d+\/ai\/ask$/.test(path)) return 'viewer';
  return 'editor';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  return origin === requestOrigin(req) || origin === authSettings().publicUrl;
}

/** Authentication + authorisation + CSRF protection for /api and /artifacts. */
export function authenticate(req, res, next) {
  const path = req.baseUrl === '/api' ? req.path : null;
  const principal = resolvePrincipal(req);
  req.user = principal?.user || null;
  req.authMethod = principal?.method || null;
  req.sessionId = principal?.sessionId || null;

  // Browser-originated writes must come from this site (cookies are SameSite=Lax, this is defence in depth).
  if (!SAFE.has(req.method) && req.authMethod !== 'api_token' && req.authMethod !== 'api_key' && !sameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  if (path && PUBLIC_API.has(path)) return next();
  if (!req.user) return res.status(401).json({ error: 'Please sign in', loginRequired: true });
  if (req.user.must_change_password && (!path || !path.startsWith('/auth/'))) {
    return res.status(403).json({ error: 'Change your password to continue', passwordChangeRequired: true });
  }
  if (path) {
    const need = requiredRole(req.method, path);
    if (!hasRole(req.user, need)) {
      return res.status(403).json({ error: `This needs the ${need} role; you are a ${req.user.role}. Ask an administrator for access.`, forbidden: true });
    }
  }
  next();
}

// ---------------------------------------------------------------- auditing
const ACTIONS = [
  ['POST', /^\/suites\/(\d+)\/run$/, 'suite.run'],
  ['POST', /^\/suites$/, 'suite.create'], ['PUT', /^\/suites\/(\d+)$/, 'suite.update'], ['DELETE', /^\/suites\/(\d+)$/, 'suite.delete'],
  ['POST', /^\/reports$/, 'report.create'], ['PUT', /^\/reports\/(\d+)$/, 'report.update'], ['DELETE', /^\/reports\/(\d+)$/, 'report.delete'],
  ['POST', /^\/reports\/(\d+)\/discover$/, 'report.discover'],
  ['POST', /^\/profiles$/, 'profile.create'], ['PUT', /^\/profiles\/(\d+)$/, 'profile.update'], ['DELETE', /^\/profiles\/(\d+)$/, 'profile.delete'],
  ['POST', /^\/profiles\/(\d+)\/login$/, 'profile.sign_in'], ['POST', /^\/profiles\/(\d+)\/check$/, 'profile.check'],
  ['POST', /^\/profiles\/(\d+)\/import$/, 'profile.import_session'], ['DELETE', /^\/profiles\/(\d+)\/session$/, 'profile.sign_out'],
  ['POST', /^\/runs\/(\d+)\/cancel$/, 'run.cancel'], ['POST', /^\/runs\/(\d+)\/rerun$/, 'run.rerun'], ['DELETE', /^\/runs\/(\d+)$/, 'run.delete'],
  ['POST', /^\/runs\/(\d+)\/ai\/analyze$/, 'ai.analyze'], ['POST', /^\/results\/(\d+)\/ai\/explain$/, 'ai.explain'], ['POST', /^\/runs\/(\d+)\/ai\/ask$/, 'ai.ask'],
  ['POST', /^\/admin\/users$/, 'user.create'], ['PUT', /^\/admin\/users\/(\d+)$/, 'user.update'], ['DELETE', /^\/admin\/users\/(\d+)$/, 'user.delete'],
  ['POST', /^\/admin\/users\/(\d+)\/reset-password$/, 'user.reset_password'], ['DELETE', /^\/admin\/users\/(\d+)\/sessions$/, 'user.revoke_sessions'],
  ['PUT', /^\/admin\/settings$/, 'settings.update'],
  ['POST', /^\/runs\/(\d+)\/publish$/, 'run.publish'], ['DELETE', /^\/runs\/(\d+)\/publish$/, 'run.unpublish'],
  ['PUT', /^\/admin\/pages$/, 'pages.settings'], ['POST', /^\/admin\/pages\/deploy$/, 'pages.deploy'],
  ['POST', /^\/auth\/password$/, 'account.change_password'], ['POST', /^\/auth\/api-keys$/, 'account.create_api_key'],
  ['DELETE', /^\/auth\/api-keys\/(\d+)$/, 'account.delete_api_key'], ['DELETE', /^\/auth\/sessions(?:\/([\w-]+))?$/, 'account.revoke_sessions'],
];
const SELF_AUDITED = new Set(['/auth/login', '/auth/logout', '/auth/setup']);

export function describeAction(method, path) {
  for (const [m, re, action] of ACTIONS) {
    const hit = m === method && re.exec(path);
    if (hit) return { action, target: hit[1] ? `#${hit[1]}` : '' };
  }
  return { action: `${method.toLowerCase()} ${path}`, target: '' };
}

/** Writes an audit entry for every state-changing API call once it completes. */
export function auditTrail(req, res, next) {
  if (SAFE.has(req.method) || SELF_AUDITED.has(req.path)) return next();
  res.on('finish', () => {
    if (res.statusCode === 401 || (res.statusCode === 403 && !req.user)) return;
    const { action, target } = describeAction(req.method, req.path);
    const detail = { ...(res.locals.auditDetail || {}), ...(req.authMethod && req.authMethod !== 'session' ? { via: req.authMethod } : {}) };
    audit(req.user, action, { target: res.locals.auditTarget ? `${res.locals.auditTarget}${target ? ` (${target})` : ''}` : target, status: res.statusCode, ip: req.ip, detail });
  });
  next();
}
