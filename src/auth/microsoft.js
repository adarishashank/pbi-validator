/**
 * Microsoft Entra ID (Azure AD) sign-in: OpenID Connect authorization-code
 * flow with PKCE, state and nonce. The ID token's RS256 signature is verified
 * against the tenant's published JWKS, and issuer, audience, expiry, nonce and
 * tenant are all checked. No SDK dependency.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { authSettings } from './users.js';

const MULTI_TENANT = new Set(['common', 'organizations']);
const discoveryCache = new Map(); // tenant -> { at, doc }
const jwksCache = new Map(); // jwks_uri -> { at, keys }
const pending = new Map(); // state -> { nonce, verifier, redirectUri, returnTo, exp }
const HOUR = 3600e3;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const b64url = (bytes) => crypto.randomBytes(bytes).toString('base64url');

/** Why Microsoft sign-in can't be used right now, or null if it's ready. */
export function microsoftProblem(ms = authSettings().microsoft) {
  if (!ms.enabled) return 'Microsoft sign-in is turned off';
  if (!ms.clientId) return 'Application (client) ID is missing';
  if (!ms.clientSecret) return 'Client secret is missing';
  if (!ms.tenant) return 'Directory (tenant) ID is missing';
  if (ms.tenant === 'consumers') return 'Personal Microsoft accounts are not supported; use your organisation\'s tenant';
  if (MULTI_TENANT.has(ms.tenant) && !ms.allowedTenants.length) return 'Multi-tenant sign-in ("organizations"/"common") needs a list of allowed tenant IDs';
  return null;
}

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j };
}

export async function discovery(tenant) {
  const hit = discoveryCache.get(tenant);
  if (hit && Date.now() - hit.at < HOUR) return hit.doc;
  const url = `${config.auth.msAuthorityHost}/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`;
  let res;
  try { res = await getJson(url); } catch (e) { throw fail(`Couldn't reach Microsoft (${e.message})`, 502); }
  const d = res.json;
  if (!res.ok || !d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri || !d.issuer) {
    throw fail(`Tenant "${tenant}" not found. Check the Directory (tenant) ID.`, 400);
  }
  discoveryCache.set(tenant, { at: Date.now(), doc: d });
  return d;
}

async function signingKey(jwksUri, kid) {
  for (const force of [false, true]) {
    let hit = jwksCache.get(jwksUri);
    if (force || !hit || Date.now() - hit.at > HOUR) {
      const res = await getJson(jwksUri);
      if (!res.ok || !Array.isArray(res.json.keys)) throw fail('Couldn\'t load Microsoft signing keys', 502);
      hit = { at: Date.now(), keys: res.json.keys };
      jwksCache.set(jwksUri, hit);
    }
    const jwk = hit.keys.find((k) => k.kid === kid && k.kty === 'RSA');
    if (jwk) return crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  }
  throw fail('ID token was signed with an unknown key', 401);
}

/** Builds the Microsoft authorize URL and remembers the PKCE/nonce state. */
export async function beginLogin({ redirectUri, returnTo = '/' }) {
  const ms = authSettings().microsoft;
  const problem = microsoftProblem(ms);
  if (problem) throw fail(problem);
  const d = await discovery(ms.tenant);
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  if (pending.size > 5000) throw fail('Too many sign-ins in progress; try again shortly', 429);
  const state = b64url(24), nonce = b64url(24), verifier = b64url(48);
  pending.set(state, { nonce, verifier, redirectUri, returnTo, exp: now + 10 * 60e3 });
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    client_id: ms.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return u.toString();
}

/** Handles the redirect back from Microsoft. Returns verified ID-token claims. */
export async function completeLogin(query) {
  const st = pending.get(String(query.state || ''));
  if (st) pending.delete(String(query.state));
  if (query.error) {
    const desc = String(query.error_description || query.error).split(/\r?\n/)[0];
    throw fail(`Microsoft sign-in failed: ${desc}`, 401);
  }
  if (!st || st.exp < Date.now()) throw fail('Your sign-in attempt expired or was already used. Please try again.', 401);
  if (!query.code) throw fail('Microsoft did not return an authorization code', 401);

  const ms = authSettings().microsoft;
  const problem = microsoftProblem(ms);
  if (problem) throw fail(problem);
  const d = await discovery(ms.tenant);
  const res = await getJson(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ms.clientId,
      client_secret: ms.clientSecret,
      grant_type: 'authorization_code',
      code: String(query.code),
      redirect_uri: st.redirectUri,
      code_verifier: st.verifier,
      scope: 'openid profile email',
    }),
  });
  if (!res.ok || !res.json.id_token) {
    const why = String(res.json.error_description || res.json.error || `HTTP ${res.status}`).split(/\r?\n/)[0];
    throw fail(`Token exchange with Microsoft failed: ${why}`, 401);
  }
  const claims = await verifyIdToken(res.json.id_token, { ms, d, nonce: st.nonce });
  return { claims, returnTo: st.returnTo };
}

export async function verifyIdToken(idToken, { ms, d, nonce }) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw fail('Malformed ID token', 401);
  const [h, p, s] = parts;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString());
    claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch { throw fail('Malformed ID token', 401); }
  if (header.alg !== 'RS256') throw fail(`Unexpected ID token algorithm ${header.alg}`, 401);
  const key = await signingKey(d.jwks_uri, header.kid);
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw fail('ID token signature is invalid', 401);

  const now = Math.floor(Date.now() / 1000);
  const skew = 120;
  if (!claims.tid || !claims.oid) throw fail('ID token has no tenant/object id', 401);
  if (claims.iss !== d.issuer.replace('{tenantid}', claims.tid)) throw fail('ID token issuer mismatch', 401);
  if (claims.aud !== ms.clientId) throw fail('ID token audience mismatch', 401);
  if (typeof claims.exp !== 'number' || claims.exp < now - skew) throw fail('ID token expired', 401);
  if (claims.nbf && claims.nbf > now + skew) throw fail('ID token not yet valid', 401);
  if (claims.nonce !== nonce) throw fail('ID token nonce mismatch', 401);
  const tid = String(claims.tid).toLowerCase();
  if (ms.allowedTenants.length && !ms.allowedTenants.includes(tid)) throw fail('Your organisation is not allowed to sign in here', 403);
  return claims;
}

export function claimsEmail(claims) {
  const v = claims.email || claims.preferred_username || claims.upn || '';
  return String(v).trim().toLowerCase();
}
