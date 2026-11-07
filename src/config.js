import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (no dependency). Real env vars take precedence.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: int(process.env.PORT, 4400),
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'pbi-validator.db'),
  runsDir: path.join(DATA_DIR, 'runs'),
  authDir: path.join(DATA_DIR, 'auth'),
  discoveryDir: path.join(DATA_DIR, 'discovery'),
  maxParallelRuns: int(process.env.MAX_PARALLEL_RUNS, 1),
  headless: bool(process.env.HEADLESS, true),
  // Optional shared secret. When set, every /api request must send it as
  // "Authorization: Bearer <token>" (the UI prompts for it once).
  apiToken: process.env.API_TOKEN || '',
  runRetentionDays: int(process.env.RUN_RETENTION_DAYS, 30),
  loginUrl: process.env.PBI_LOGIN_URL || 'https://app.powerbi.com/home',
  logLevel: process.env.LOG_LEVEL || 'info',
  // User accounts and sign-in. Microsoft Entra ID settings can also be set in
  // Admin → Sign-in; environment variables take precedence and lock the field.
  auth: {
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
    sessionIdleHours: int(process.env.SESSION_IDLE_HOURS, 72),
    sessionMaxDays: int(process.env.SESSION_MAX_DAYS, 30),
    passwordMinLength: Math.max(8, int(process.env.PASSWORD_MIN_LENGTH, 10)),
    loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 8),
    msTenant: process.env.MS_TENANT_ID || '',
    msClientId: process.env.MS_CLIENT_ID || '',
    msClientSecret: process.env.MS_CLIENT_SECRET || '',
    // Change for sovereign clouds, e.g. https://login.microsoftonline.us
    msAuthorityHost: (process.env.MS_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
  },
  // AI analysis via any OpenAI-compatible endpoint. Defaults to NVIDIA's
  // hosted API catalog (build.nvidia.com) with open-weight models; point
  // AI_BASE_URL at a self-hosted NIM to keep screenshots/data in-house.
  ai: {
    apiKey: process.env.NVIDIA_API_KEY || process.env.AI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    textModel: process.env.AI_TEXT_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b',
    visionModel: process.env.AI_VISION_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    allowNoKey: bool(process.env.AI_ALLOW_NO_KEY, false), // self-hosted NIM without auth
    allowImages: bool(process.env.AI_ALLOW_IMAGES, true),
    autoAnalyze: bool(process.env.AI_AUTO_ANALYZE, true),
    maxVisionItems: int(process.env.AI_MAX_VISION_ITEMS, 8),
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 180000),
  },
};

for (const dir of [config.dataDir, config.runsDir, config.authDir, config.discoveryDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
