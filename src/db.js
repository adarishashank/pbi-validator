import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS auth_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  login_url TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_signed_in',
  status_detail TEXT DEFAULT '',
  last_login_at TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  environment TEXT DEFAULT '',
  auth_profile_id INTEGER REFERENCES auth_profiles(id) ON DELETE SET NULL,
  tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  last_discovery TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS suites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'compare',
  report_a_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  report_b_id INTEGER REFERENCES reports(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}',
  schedule TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id INTEGER REFERENCES suites(id) ON DELETE SET NULL,
  suite_name TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  phase TEXT DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_suite ON runs(suite_id, id DESC);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  page TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  diff_ratio REAL,
  diff_pixels INTEGER,
  images TEXT NOT NULL DEFAULT '{}',
  details TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id, seq);
CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON run_logs(run_id, id);
CREATE TABLE IF NOT EXISTS ai_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  result_id INTEGER REFERENCES results(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  model TEXT,
  content TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_run ON ai_analyses(run_id, kind, id);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'viewer',
  provider TEXT NOT NULL DEFAULT 'local',
  password_hash TEXT,
  ms_oid TEXT,
  ms_tid TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ms ON users(ms_tid, ms_oid) WHERE ms_oid IS NOT NULL;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id INTEGER,
  user_email TEXT,
  action TEXT NOT NULL,
  target TEXT,
  status INTEGER,
  ip TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(id DESC);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Additive migrations for databases created by earlier versions.
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasColumn('runs', 'triggered_by')) db.exec('ALTER TABLE runs ADD COLUMN triggered_by TEXT');
// When a one-time (temporary) password stops working; NULL once the user has chosen their own.
// When each scheduled suite is next due (persisted so a sleeping/restarted app can catch up).
if (!hasColumn('suites', 'next_scheduled_at')) db.exec('ALTER TABLE suites ADD COLUMN next_scheduled_at TEXT');
// Differences accepted as expected: matching checks in later runs become "accepted".
db.exec(`CREATE TABLE IF NOT EXISTS acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id INTEGER NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  match_key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'exact',
  fingerprint TEXT NOT NULL DEFAULT '',
  original_status TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  page TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  from_run_id INTEGER,
  last_matched_at TEXT,
  match_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_acceptances_suite ON acceptances(suite_id);`);
// When a run was published to the Cloudflare Pages results site (NULL = not published).
if (!hasColumn('runs', 'published_at')) db.exec('ALTER TABLE runs ADD COLUMN published_at TEXT');
if (!hasColumn('users', 'temp_password_expires_at')) db.exec('ALTER TABLE users ADD COLUMN temp_password_expires_at TEXT');

// The database holds password hashes and SSO settings: owner-only access.
for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
  try { fs.chmodSync(f, 0o600); } catch { /* not created yet */ }
}

const JSON_COLS = new Set(['config', 'snapshot', 'summary', 'images', 'details', 'last_discovery', 'content', 'detail', 'value']);

function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of Object.keys(out)) {
    if (JSON_COLS.has(k) && typeof out[k] === 'string') {
      try { out[k] = JSON.parse(out[k]); } catch { /* keep raw */ }
    }
  }
  return out;
}

const enc = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p.map(enc)).map(hydrate),
  get: (sql, ...p) => hydrate(db.prepare(sql).get(...p.map(enc))),
  run: (sql, ...p) => db.prepare(sql).run(...p.map(enc)),
};

/** Generic insert/update helpers driven by a whitelist of columns. */
export function insert(table, data) {
  const cols = Object.keys(data);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const r = q.run(sql, ...cols.map((c) => data[c] ?? null));
  return Number(r.lastInsertRowid);
}

export function update(table, id, data) {
  const cols = Object.keys(data);
  if (!cols.length) return;
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
  q.run(sql, ...cols.map((c) => data[c] ?? null), id);
}

export const nowIso = () => new Date().toISOString();

/** Mark runs that were interrupted by a crash/restart. */
export function recoverInterruptedRuns() {
  const r = q.run(
    `UPDATE runs SET status='error', error='Interrupted: server restarted while run was active', finished_at=? WHERE status IN ('running','queued')`,
    nowIso(),
  );
  return Number(r.changes);
}

export default db;
