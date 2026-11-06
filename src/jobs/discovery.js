import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { q, update, nowIso } from '../db.js';
import { launchBrowser, newReportContext } from '../engine/runner.js';
import { PbiReport } from '../engine/pbi.js';
import { resolveSelectors } from '../engine/selectors.js';
import { DEFAULT_SUITE_CONFIG } from '../engine/options.js';
import { profileStatePath } from '../auth/profiles.js';
import { createLogger } from '../logger.js';

const logger = createLogger('discovery');
const running = new Map();

/**
 * Opens a report headlessly, walks every page and returns an inventory with
 * thumbnails. Used to verify a link + auth profile before building suites.
 */
export async function discoverReport(reportId) {
  if (running.has(reportId)) return running.get(reportId);
  const p = doDiscover(reportId).finally(() => running.delete(reportId));
  running.set(reportId, p);
  return p;
}

async function doDiscover(reportId) {
  const rep = q.get('SELECT * FROM reports WHERE id = ?', reportId);
  if (!rep) throw Object.assign(new Error('Report not found'), { status: 404 });
  const cfg = DEFAULT_SUITE_CONFIG;
  const dir = path.join(config.discoveryDir, String(reportId));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const logs = [];
  const log = (level, msg) => { logs.push({ level, msg }); logger.debug(msg); };
  const browser = await launchBrowser({ headless: config.headless });
  const started = Date.now();
  try {
    const context = await newReportContext(browser, cfg, rep.auth_profile_id ? profileStatePath(rep.auth_profile_id) : null);
    const page = await context.newPage();
    const r = new PbiReport(page, { url: rep.url, side: 'A', sel: resolveSelectors(), cfg, log });
    await r.open();
    const loadMs = Date.now() - started;
    const pages = await r.listPages();
    const out = [];
    for (const pg of pages.slice(0, 60)) {
      const t0 = Date.now();
      try {
        await r.gotoPage(pg);
        const ex = await r.extract();
        const types = {};
        for (const v of ex.visuals) types[v.type] = (types[v.type] || 0) + 1;
        const thumb = `page-${pg.index}.png`;
        fs.writeFileSync(path.join(dir, thumb), await r.screenshotCanvas());
        out.push({
          name: pg.name, index: pg.index, renderMs: Date.now() - t0, visuals: ex.total, types,
          errors: ex.visuals.filter((v) => v.error).map((v) => `${v.title || v.type}: ${v.error}`),
          interactive: {
            buttons: ex.visuals.filter((v) => /actionButton|pageNavigator|bookmarkNavigator/i.test(v.type) || v.actionable).length,
            slicers: ex.visuals.filter((v) => v.slicer).length,
            charts: ex.visuals.filter((v) => v.points.length).length,
            matrices: ex.visuals.filter((v) => /pivotTable|matrix/i.test(v.type)).length,
          },
          thumbnail: `/artifacts/discovery/${reportId}/${thumb}`,
        });
      } catch (e) {
        out.push({ name: pg.name, index: pg.index, error: e.message.split('\n')[0] });
      }
    }
    const result = { ok: true, at: nowIso(), loadMs, navigation: r.navStrategy, pages: out, logs: logs.slice(-50) };
    update('reports', reportId, { last_discovery: result });
    return result;
  } catch (e) {
    const result = { ok: false, at: nowIso(), error: e.message.split('\n')[0], code: e.code, logs: logs.slice(-50) };
    update('reports', reportId, { last_discovery: result });
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}
