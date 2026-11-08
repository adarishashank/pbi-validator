import { config } from '../config.js';
import { fromInfoView } from './snapshot.js';

// Reads a report's semantic model through the Power BI REST API:
//   GET  /groups/{ws}/reports/{id}                 → datasetId, datasetWorkspaceId
//   POST /groups/{ws}/datasets/{id}/executeQueries  EVALUATE INFO.VIEW.TABLES() … (one query per call)
//   GET  /groups/{ws}/datasets/{id}/refreshes?$top=1 → last refresh
// Needs Build (or higher) permission on the semantic model. Publish-to-web
// links carry no workspace/report IDs, so they can't be read this way.

const apiBase = () => (process.env.PBI_API_BASE || 'https://api.powerbi.com/v1.0/myorg').replace(/\/$/, '');
const loginBase = () => (process.env.PBI_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, '');

/** Workspace and report IDs from an app.powerbi.com report URL. */
export function parseReportUrl(url) {
  try {
    const u = new URL(url);
    const m = /\/groups\/([\w-]+)\/reports\/([0-9a-f-]{36})/i.exec(u.pathname);
    if (m) return { groupId: m[1], reportId: m[2] };
    const embed = /reportEmbed|\/embed/i.test(u.pathname) && u.searchParams.get('reportId');
    if (embed) return { groupId: u.searchParams.get('groupId') || 'me', reportId: embed };
  } catch { /* not a URL */ }
  return null;
}

export const servicePrincipalConfigured = () => !!(config.powerbi.tenantId && config.powerbi.clientId && config.powerbi.clientSecret);

let cached = null;
/** App-only token for the configured service principal (client credentials). */
export async function servicePrincipalToken() {
  if (!servicePrincipalConfigured()) return null;
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const { tenantId, clientId, clientSecret } = config.powerbi;
  const r = await fetch(`${loginBase()}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://analysis.windows.net/powerbi/api/.default' }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Service principal sign-in failed: ${j.error_description?.split('\n')[0] || j.error || `HTTP ${r.status}`}`);
  cached = { token: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

async function call(token, pathPart, opts = {}) {
  const r = await fetch(`${apiBase()}${pathPart}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 60_000),
  });
  const body = await r.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    const msg = json?.error?.pbi?.error?.details?.[0]?.detail?.value || json?.error?.message || json?.error?.code || body.slice(0, 200) || `HTTP ${r.status}`;
    throw Object.assign(new Error(`Power BI API ${r.status}: ${msg}`), { status: r.status });
  }
  return json;
}

const group = (g) => (!g || g === 'me' ? '' : `/groups/${g}`);

async function dax(token, ws, datasetId, query) {
  const j = await call(token, `${group(ws)}/datasets/${datasetId}/executeQueries`, {
    method: 'POST',
    body: JSON.stringify({ queries: [{ query }], serializerSettings: { includeNulls: true } }),
  });
  const err = j?.results?.[0]?.error || j?.error;
  if (err) throw new Error(err.message || JSON.stringify(err).slice(0, 200));
  return j?.results?.[0]?.tables?.[0]?.rows || [];
}

/**
 * Reads the model behind a report. `token` is a service principal token or the
 * signed-in user's Power BI token. Returns a canonical snapshot.
 */
export async function fetchModel({ url, token, via }) {
  const ids = parseReportUrl(url);
  if (!ids) throw Object.assign(new Error('The report link has no workspace/report ID (e.g. a publish-to-web link), so the model can\'t be read through the API. Upload a model file for this report link instead.'), { code: 'NO_IDS' });
  const rep = await call(token, `${group(ids.groupId)}/reports/${ids.reportId}`);
  const ws = rep.datasetWorkspaceId || (ids.groupId === 'me' ? null : ids.groupId);
  const ds = rep.datasetId;
  if (!ds) throw new Error('The report has no semantic model ID');
  const q = (name) => dax(token, ws, ds, `EVALUATE ${name}()`);
  const [tables, columns, measures, relationships] = [await q('INFO.VIEW.TABLES'), await q('INFO.VIEW.COLUMNS'), await q('INFO.VIEW.MEASURES'), await q('INFO.VIEW.RELATIONSHIPS')];
  // Roles need admin rights on the model: best effort.
  let roles = null, tablePermissions = null;
  try { roles = await q('INFO.ROLES'); tablePermissions = await q('INFO.TABLEPERMISSIONS'); } catch { roles = null; }
  const snap = fromInfoView({ tables, columns, measures, relationships, roles, tablePermissions }, `Power BI API (${via})`);
  const meta = await call(token, `${group(ws)}/datasets/${ds}`).catch(() => null);
  const refresh = await call(token, `${group(ws)}/datasets/${ds}/refreshes?$top=1`).catch(() => null);
  snap.name = meta?.name || rep.name || '';
  snap.meta = { ...snap.meta, datasetId: ds, workspaceId: ws, lastRefresh: refresh?.value?.[0]?.endTime || null, lastRefreshStatus: refresh?.value?.[0]?.status || null, rolesRead: !!roles };
  return snap;
}
