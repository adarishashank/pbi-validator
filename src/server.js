import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { config, ROOT } from './config.js';
import { recoverInterruptedRuns } from './db.js';
import { createLogger } from './logger.js';
import api from './api/routes.js';
import adminApi from './api/admin.js';
import { authApi } from './api/auth.js';
import { authenticate, auditTrail } from './auth/middleware.js';
import { closeAllRemoteLogins } from './auth/remote.js';
import { userCount } from './auth/users.js';
import { startScheduler, startHousekeeping } from './jobs/scheduler.js';

const logger = createLogger('server');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Which reverse proxies may set X-Forwarded-For/-Proto (client IP, HTTPS).
  // 'loopback' for a tunnel on the same machine; the cloud setup behind Caddy
  // in Docker uses 'loopback, uniquelocal'.
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // Every API call and screenshot requires a signed-in user (or API key /
  // API_TOKEN). Roles are enforced per endpoint; writes are audited.
  app.use(['/api', '/artifacts'], express.json({ limit: '10mb' }), authenticate);
  app.use('/api', auditTrail, authApi, adminApi, api);

  // Run artifacts (screenshots) and discovery thumbnails.
  // Screenshots are behind sign-in, so browsers may cache them only privately.
  const artifactOpts = { immutable: true, maxAge: '7d', index: false, dotfiles: 'deny', setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=604800, immutable') };
  app.use('/artifacts/runs', express.static(config.runsDir, artifactOpts));
  app.use('/artifacts/discovery', express.static(config.discoveryDir, { ...artifactOpts, setHeaders: (res) => res.setHeader('Cache-Control', 'private, no-cache') }));

  // Front-end vendor modules (no build step). Bare "preact" imports are
  // rewritten so the browser can load them without an import map.
  const vendor = {
    'preact.mjs': 'node_modules/preact/dist/preact.mjs',
    'hooks.mjs': 'node_modules/preact/hooks/dist/hooks.mjs',
    'htm.mjs': 'node_modules/htm/dist/htm.mjs',
  };
  const vendorCache = new Map();
  app.get('/vendor/:file', (req, res, next) => {
    const rel = vendor[req.params.file];
    if (!rel) return next();
    if (!vendorCache.has(rel)) {
      vendorCache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/from\s*["']preact["']/g, 'from"/vendor/preact.mjs"'));
    }
    res.type('application/javascript').setHeader('Cache-Control', 'public, max-age=86400');
    res.send(vendorCache.get(rel));
  });

  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: 0 }));
  app.get(/^\/(?!api|artifacts|vendor).*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) logger.error(`${req.method} ${req.originalUrl}: ${err.stack || err}`);
    res.status(status).json({ error: err.message || 'Internal error' });
  });
  return app;
}

export function start() {
  const n = recoverInterruptedRuns();
  if (n) logger.warn(`Marked ${n} interrupted run(s) as errored`);
  startScheduler();
  startHousekeeping();
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info(`PBI Report Test listening on http://${config.host}:${config.port}  (data: ${config.dataDir})`);
    if (userCount() === 0) {
      logger.warn(`No users yet: open http://127.0.0.1:${config.port} on this machine to create the first administrator (or run: npm run cli -- create-admin you@company.com).`);
    }
  });
  const shutdown = (sig) => {
    logger.info(`${sig} received, shutting down`);
    closeAllRemoteLogins().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
