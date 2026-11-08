import crypto from 'node:crypto';
import { q, insert, update, nowIso } from '../db.js';
import { config } from '../config.js';
import { hashPassword, generatePassword } from './passwords.js';

// ------------------------------------------------------------------ roles
export const ROLES = ['viewer', 'editor', 'admin'];
export const ROLE_INFO = {
  viewer: 'View reports, suites, runs and results; export; ask AI about runs',
  editor: 'Everything a viewer can, plus manage report links, suites and Power BI sign-ins, and run validations',
  admin: 'Everything an editor can, plus manage users, settings and the audit log',
};
export const hasRole = (user, role) => !!user && ROLES.indexOf(user.role) >= ROLES.indexOf(role);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const iso = (ms) => new Date(ms).toISOString();
export const normEmail = (e) => String(e || '').trim().toLowerCase();

// ------------------------------------------------------------------ users
export const tempPasswordExpired = (u) => Boolean(u?.must_change_password && u.temp_password_expires_at && u.temp_password_expires_at < new Date().toISOString());

export function publicUser(u) {
  if (!u) return null;
  const { password_hash: hash, ...rest } = u;
  return {
    ...rest, has_password: Boolean(hash), disabled: Boolean(u.disabled), must_change_password: Boolean(u.must_change_password),
    temp_password_expired: tempPasswordExpired(u),
  };
}

/**
 * Generates a temporary password for a user: replaces their password, forces a
 * change at next sign-in, sets the expiry and signs them out everywhere.
 * Returns the plain password (shown once, never stored) and when it expires.
 */
export async function issueTemporaryPassword(userId, { enable = false } = {}) {
  const password = generatePassword();
  const expiresAt = iso(Date.now() + config.auth.tempPasswordHours * 3600e3);
  updateUser(userId, {
    password_hash: await hashPassword(password), must_change_password: 1, temp_password_expires_at: expiresAt,
    ...(enable ? { disabled: 0 } : {}),
  });
  revokeUserSessions(userId);
  return { password, expiresAt, hours: config.auth.tempPasswordHours };
}

/** Creates an account with an automatically generated temporary password. */
export async function inviteUser({ email, name = '', role = 'viewer' }) {
  const user = createUser({ email, name, role, passwordHash: null, mustChange: true });
  const temp = await issueTemporaryPassword(user.id);
  return { user: getUser(user.id), ...temp };
}

export const userCount = () => q.get('SELECT COUNT(*) n FROM users').n;
export const getUser = (id) => q.get('SELECT * FROM users WHERE id = ?', id);
export const findUserByEmail = (email) => q.get('SELECT * FROM users WHERE email = ?', normEmail(email));
export const otherActiveAdmins = (userId) => q.get("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", userId).n;

export function createUser({ email, name = '', role = 'viewer', passwordHash = null, mustChange = false }) {
  const now = nowIso();
  const id = insert('users', {
    email: normEmail(email), name: String(name).trim(), role, provider: 'local', password_hash: passwordHash,
    must_change_password: mustChange ? 1 : 0, created_at: now, updated_at: now,
  });
  return getUser(id);
}

export function updateUser(id, patch) {
  update('users', id, { ...patch, updated_at: nowIso() });
  return getUser(id);
}

// --------------------------------------------------------------- sessions
const idleMs = () => config.auth.sessionIdleHours * 3600e3;
const maxMs = () => config.auth.sessionMaxDays * 86400e3;
export const sessionCookieMaxAge = () => Math.floor(maxMs() / 1000);

export function createSession(user, req, method) {
  const token = randomToken(32);
  const now = Date.now();
  q.run('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?', iso(now), iso(now));
  insert('sessions', {
    id: sha256(token), user_id: user.id, method, ip: req.ip || '', user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    created_at: iso(now), last_seen_at: iso(now), expires_at: iso(now + idleMs()), absolute_expires_at: iso(now + maxMs()),
  });
  q.run('UPDATE users SET last_login_at = ? WHERE id = ?', iso(now), user.id);
  return token;
}

/** Resolves a session cookie to { user, sessionId } and slides its idle expiry. */
export function resolveSession(token) {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const s = q.get('SELECT * FROM sessions WHERE id = ?', id);
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at < iso(now) || s.absolute_expires_at < iso(now)) {
    q.run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  const user = getUser(s.user_id);
  if (!user || user.disabled) return null;
  if (now - Date.parse(s.last_seen_at) > 60e3) {
    const exp = Math.min(now + idleMs(), Date.parse(s.absolute_expires_at));
    q.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', iso(now), iso(exp), id);
  }
  return { user, sessionId: id };
}

export const deleteSession = (sessionId) => q.run('DELETE FROM sessions WHERE id = ?', sessionId);
export const revokeUserSessions = (userId, exceptId = '') => Number(q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, exceptId).changes);
export const listSessions = (userId) => q.all(
  'SELECT id, method, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
  userId, nowIso(),
).map((s) => ({ ...s, id: s.id.slice(0, 16) }));
/** Session ids are exposed truncated (they are hashes, but there's no need to hand them out whole). */
export const deleteSessionByPrefix = (userId, prefix) => Number(q.run("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?", userId, String(prefix).slice(0, 16)).changes);

// --------------------------------------------------------------- API keys
export function createApiKey(userId, name, expiresDays) {
  const raw = `pbiv_${randomToken(30)}`;
  const id = insert('api_keys', {
    user_id: userId, name: String(name).trim(), prefix: raw.slice(0, 12), key_hash: sha256(raw),
    expires_at: expiresDays ? iso(Date.now() + expiresDays * 86400e3) : null, created_at: nowIso(),
  });
  return { id, key: raw };
}

export function resolveApiKey(raw) {
  if (!raw?.startsWith('pbiv_') || raw.length > 100) return null;
  const k = q.get('SELECT * FROM api_keys WHERE key_hash = ?', sha256(raw));
  if (!k || (k.expires_at && k.expires_at < nowIso())) return null;
  const user = getUser(k.user_id);
  if (!user || user.disabled) return null;
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60e3) q.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), k.id);
  return { user, keyId: k.id };
}

export const listApiKeys = (userId) => q.all('SELECT id, name, prefix, last_used_at, expires_at, created_at FROM api_keys WHERE user_id = ? ORDER BY id DESC', userId);

// ------------------------------------------------------------------ audit
export function audit(actor, action, { target = '', status = 200, ip = '', detail = {} } = {}) {
  insert('audit_log', {
    ts: nowIso(), user_id: actor?.id ?? null, user_email: actor?.email ?? (typeof actor === 'string' ? actor : null),
    action, target: String(target || ''), status, ip, detail,
  });
}

// --------------------------------------------------------------- settings
export function getSetting(key, fallback) {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

/** Effective site settings: stored values, overridden by environment variables. */
export function authSettings() {
  const stored = getSetting('auth', {}) || {};
  const env = config.auth;
  return {
    publicUrl: (env.publicUrl || stored.publicUrl || '').replace(/\/+$/, ''),
    locked: { publicUrl: Boolean(env.publicUrl) },
  };
}

export function saveAuthSettings(patch) {
  const stored = getSetting('auth', {}) || {};
  // Only keep known keys (older versions also stored Microsoft sign-in settings here).
  setSetting('auth', { publicUrl: patch.publicUrl ?? stored.publicUrl ?? '' });
  return authSettings();
}

// --------------------------------------------------------- login throttle
const failures = new Map(); // key -> [timestamps]
const WINDOW = 15 * 60e3;
const recent = (key) => (failures.get(key) || []).filter((t) => Date.now() - t < WINDOW);

export function loginBlocked(ip, email) {
  const max = config.auth.loginMaxAttempts;
  const a = recent(`${ip}|${normEmail(email)}`), b = recent(`${ip}|*`), c = recent(`*|${normEmail(email)}`);
  if (a.length >= max || b.length >= max * 5 || c.length >= max * 3) {
    const oldest = Math.min(...[a, b, c].filter((x) => x.length).map((x) => x[0]));
    return Math.max(1, Math.ceil((oldest + WINDOW - Date.now()) / 60e3));
  }
  return 0;
}
export function recordLoginFailure(ip, email) {
  for (const k of [`${ip}|${normEmail(email)}`, `${ip}|*`, `*|${normEmail(email)}`]) failures.set(k, [...recent(k), Date.now()]);
  if (failures.size > 10000) for (const [k] of failures) { if (!recent(k).length) failures.delete(k); }
}
export const clearLoginFailures = (ip, email) => failures.delete(`${ip}|${normEmail(email)}`);
