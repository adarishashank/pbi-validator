import crypto from 'node:crypto';
import { asList, joinSel } from './selectors.js';
import {
  extractVisualsInPage, renderSignatureInPage, headerButtonsInPage, navigatorItemsInPage,
  dataPointsInPage, tooltipInPage, contextMenuInPage, canvasBoxInPage, canvasOverflowInPage,
} from './inpage.js';
import { quickRatio } from './compare.js';
import { parseQueryExchange } from './querydata.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export class ReportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Drives one Power BI report inside one Playwright page. All DOM access goes
 * through `this.frame` so reports embedded in a host page's iframe work too.
 */
export class PbiReport {
  constructor(page, { url, side, sel, cfg, log, signedIn = null }) {
    this.page = page;
    this.signedIn = signedIn; // true: a saved Power BI session was loaded; false: opened anonymously
    this.frame = page.mainFrame();
    this.url = url;
    this.side = side;
    this.sel = sel;
    this.cfg = cfg;
    this.log = (lvl, msg) => log(lvl, `[${side}] ${msg}`);
    this.offset = { x: 0, y: 0 };
    this.pages = [];
    this.navStrategy = 'single';
    this.pageItemSelector = null;
    this.reloads = 0;
    this.afterReload = null; // set by the runner while a page has deliberate slicer selections
    this.resets = 0; // restores done with "Reset to default" instead of a reload
    this.popups = [];
    // Only windows this tab opens (other tabs of the same browser context belong to other workers).
    page.on('popup', (p) => this.popups.push(p));

    // Data requests of this tab. Knowing when they are in flight makes waiting
    // exact (no fixed pauses), and their answers are the data behind each visual.
    this.net = { open: new Set(), last: 0, seen: 0, parsing: new Set() };
    this.queries = new Map(); // visual ID → { seq, lines, rows, complete, error }
    this.querySeq = 0;
    let queryRe = null;
    try { queryRe = new RegExp(sel.queryDataUrl, 'i'); } catch { /* bad override: no tracking */ }
    const isQuery = (req) => !!queryRe && req.method() === 'POST' && queryRe.test(req.url());
    page.on('request', (req) => { if (isQuery(req)) { this.net.open.add(req); this.net.seen++; this.net.last = Date.now(); } });
    const ended = (req) => { if (this.net.open.delete(req)) this.net.last = Date.now(); };
    page.on('requestfinished', ended);
    page.on('requestfailed', ended);
    // A new document (reload, redirect) ends whatever the old one was waiting for.
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) this.net.open.clear(); });
    page.on('response', (resp) => {
      const req = resp.request();
      if (!isQuery(req) || resp.status() !== 200) return;
      const job = resp.text().then((body) => {
        for (const r of parseQueryExchange(req.postData() || '', body)) this.queries.set(r.visualId, { ...r, seq: ++this.querySeq });
      }).catch(() => {}).finally(() => this.net.parsing.delete(job));
      this.net.parsing.add(job);
    });
  }

  /** True while Power BI is fetching data for this tab (or has only just finished). */
  netBusy() {
    return this.net.open.size > 0 || Date.now() - this.net.last < 200;
  }

  /**
   * The data Power BI last downloaded for a visual, or null. Power BI answers
   * from its own memory when it returns to a state it has shown before, so this
   * is only what the visual shows now when nothing has been undone since: the
   * runner uses it for the first look at each page, not after interactions.
   */
  async queryData(v) {
    if (!v?.visualId) return null;
    await Promise.all([...this.net.parsing]);
    return this.queries.get(v.visualId) || null;
  }

  // ------------------------------------------------------------------ load
  async open() {
    const { loadTimeoutMs } = this.cfg.timing;
    this.log('info', `Opening ${redact(this.url)}`);
    const resp = await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: loadTimeoutMs });
    if (resp && resp.status() >= 400) this.log('warn', `HTTP ${resp.status()} on initial navigation`);
    await this.waitForReport();
    if (this.cfg.resetToDefaultOnLoad) await this.resetToDefault();
    await this.waitStable();
    await this.fitViewport();
  }

  /**
   * Makes the window as large as the report page when the page is larger
   * (pages that scroll), so screenshots show all of it. Starts from the
   * suite's window size on every page.
   */
  async fitViewport() {
    if (this.frame !== this.page.mainFrame()) return false; // embedded: the host page decides the size
    const base = this.cfg.viewport;
    const cur = this.page.viewportSize();
    if (cur && (cur.width !== base.width || cur.height !== base.height)) {
      await this.page.setViewportSize({ width: base.width, height: base.height });
      await this.waitStable({ timeout: 15000 });
    }
    const o = await this.frame.evaluate(canvasOverflowInPage, { sel: this.sel }).catch(() => null);
    if (!o || (o.extraW < 8 && o.extraH < 8)) return false;
    const next = { width: Math.min(base.width + o.extraW, 3840), height: Math.min(base.height + o.extraH, 8000) };
    this.log('info', `Page is larger than the ${base.width}×${base.height} window: capturing it at ${next.width}×${next.height}`);
    await this.page.setViewportSize(next);
    await this.waitStable({ timeout: 15000 });
    return true;
  }

  async waitForReport() {
    const { loadTimeoutMs } = this.cfg.timing;
    const loginRe = new RegExp(this.sel.loginUrl, 'i');
    const errRe = new RegExp(this.sel.reportErrorText, 'i');
    const deadline = Date.now() + loadTimeoutMs;
    while (Date.now() < deadline) {
      if (loginRe.test(this.page.url())) {
        const host = new URL(this.page.url()).host;
        throw new ReportError('AUTH_REQUIRED', this.signedIn === false
          ? `Report ${this.side} needs a Microsoft sign-in, but its report link has no Power BI sign-in selected, so it was opened anonymously (redirected to ${host}). Edit the report link and choose a Power BI sign-in.`
          : `Redirected to sign-in (${host}). The saved Power BI session has expired: sign in again from "Power BI sign-ins".`);
      }
      for (const f of this.page.frames()) {
        const n = await f.locator(this.sel.visualContainer).count().catch(() => 0);
        if (n > 0) {
          if (f !== this.frame) {
            this.frame = f;
            const fe = await f.frameElement().catch(() => null);
            const bb = fe ? await fe.boundingBox() : null;
            this.offset = bb ? { x: bb.x, y: bb.y } : { x: 0, y: 0 };
            this.log('info', 'Report is rendered inside an iframe; driving the embedded frame');
          }
          return;
        }
      }
      const body = await this.page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
      const m = body.match(errRe);
      if (m && Date.now() > deadline - loadTimeoutMs + 8000) {
        throw new ReportError('REPORT_ERROR', `Power BI reported: "${m[0]}"`);
      }
      await sleep(500);
    }
    throw new ReportError('LOAD_TIMEOUT', `No visuals rendered within ${Math.round(loadTimeoutMs / 1000)}s`);
  }

  /** Service only: undo persistent filters so both sides start from the published state. */
  async resetToDefault() {
    const btn = this.frame.locator(joinSel(this.sel.resetToDefault)).first();
    if (!(await btn.isVisible().catch(() => false)) || !(await btn.isEnabled().catch(() => false))) return false;
    this.log('info', 'Applying "Reset to default" to clear persistent filters');
    await btn.click({ timeout: 5000 }).catch(() => {});
    for (const s of asList(this.sel.resetConfirm)) {
      const c = this.page.locator(s).first();
      if (await c.isVisible().catch(() => false)) { await c.click({ timeout: 5000 }).catch(() => {}); break; }
    }
    await sleep(1000);
    return true;
  }

  /**
   * Waits until nothing is loading (no spinners, no data requests in flight)
   * and both DOM and pixels have stopped changing. When this tab's data
   * requests can be seen, the pauses are short because a request that is still
   * running is known; otherwise it waits the longer, fixed times.
   */
  async waitStable({ timeout = this.cfg.timing.stableTimeoutMs } = {}) {
    const start = Date.now();
    const tracked = this.net.seen > 0;
    // Time for an action to start its requests (measured: ~130 ms after a click).
    await sleep(tracked ? Math.min(this.cfg.timing.settleMs, 500) : this.cfg.timing.settleMs);
    const poll = tracked ? 150 : 350, gap = tracked ? 250 : 450;
    let last = null, same = 0, quiet = 0;
    while (Date.now() - start < timeout) {
      const s = await this.frame.evaluate(renderSignatureInPage, { sel: this.sel }).catch(() => null);
      // A request that never reports back must not hold every later wait: when
      // the page has shown no spinner and no change for 6 s, nothing is loading.
      if (s && !s.busy && s.sig === last && this.net.open.size) {
        quiet ||= Date.now();
        if (Date.now() - quiet > 6000 && Date.now() - this.net.last > 6000) {
          this.log('debug', `${this.net.open.size} data request(s) never finished; no longer waiting for them`);
          this.net.open.clear();
        }
      } else quiet = 0;
      if (s && !s.busy && !this.netBusy() && s.sig === last) {
        if (++same >= 2) {
          // DOM settled; confirm pixels are stable too (canvas/WebGL visuals, animations).
          const h1 = await this.canvasHash();
          await sleep(gap);
          const h2 = await this.canvasHash();
          if (h1 && h1 === h2 && !this.netBusy()) return true;
          same = 0;
        }
      } else same = 0;
      last = s?.sig ?? null;
      await sleep(poll);
    }
    this.log('warn', `Render did not fully settle within ${Math.round(timeout / 1000)}s; continuing`);
    return false;
  }

  async canvasHash() {
    const buf = await this.screenshotCanvas({ hover: false }).catch(() => null);
    return buf ? crypto.createHash('sha1').update(buf).digest('hex') : null;
  }

  // ------------------------------------------------------------- capture
  async canvasClip() {
    const c = await this.frame.evaluate(canvasBoxInPage, { sel: this.sel });
    if (!c || c.w < 2) return null;
    const vp = this.page.viewportSize();
    const x = Math.max(0, c.x + this.offset.x), y = Math.max(0, c.y + this.offset.y);
    return { x, y, width: Math.min(c.w, vp.width - x), height: Math.min(c.h, vp.height - y) };
  }

  async parkMouse() {
    await this.page.mouse.move(1, 1).catch(() => {});
  }

  async screenshotCanvas({ hover = true } = {}) {
    if (hover) await this.parkMouse();
    const clip = await this.canvasClip();
    const mask = this.cfg.ignore.maskSelectors.map((s) => this.frame.locator(s));
    return this.page.screenshot({ clip: clip || undefined, animations: 'disabled', caret: 'hide', mask, maskColor: '#FF00FF', timeout: 30000 });
  }

  async screenshotBox(box, pad = 6) {
    const vp = this.page.viewportSize();
    const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    const clip = { x, y, width: Math.min(box.w + pad * 2, vp.width - x), height: Math.min(box.h + pad * 2, vp.height - y) };
    if (clip.width < 2 || clip.height < 2) return null;
    return this.page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  }

  async extract({ onlyIndex } = {}) {
    const ex = await this.frame.evaluate(extractVisualsInPage, { sel: this.sel, maxVisuals: this.cfg.limits.maxVisualsPerPage, onlyIndex });
    for (const v of ex.visuals) {
      v.pageBox = { x: v.pageBox.x + this.offset.x, y: v.pageBox.y + this.offset.y, w: v.pageBox.w, h: v.pageBox.h };
    }
    return ex;
  }

  // ---------------------------------------------------------- navigation
  async listPages() {
    for (const s of asList(this.sel.pageItems)) {
      const loc = this.frame.locator(s);
      const n = await loc.count().catch(() => 0);
      if (!n) continue;
      const names = await loc.evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim()));
      this.navStrategy = 'items';
      this.pageItemSelector = s;
      this.pages = names.map((name, index) => ({ index, name: name || `Page ${index + 1}` }));
      break;
    }
    if (!this.pages.length) {
      const total = await this.pageCounter();
      if (total && total.total > 1) {
        this.navStrategy = 'stepper';
        this.pages = Array.from({ length: total.total }, (_, i) => ({ index: i, name: `Page ${i + 1}` }));
      } else {
        this.navStrategy = 'single';
        this.pages = [{ index: 0, name: 'Page 1' }];
      }
    }
    const cur = await this.currentPageIndex();
    for (const p of this.pages) p.url = p.index === cur ? this.page.url() : null;
    this.log('info', `Found ${this.pages.length} page(s) via "${this.navStrategy}" navigation: ${this.pages.map((p) => p.name).join(', ')}`);
    return this.pages;
  }

  async pageCounter() {
    const txt = await this.frame.locator(this.sel.pageCounter).first().innerText({ timeout: 1500 }).catch(() => '');
    const m = txt.replace(/\s+/g, ' ').match(/(\d+)\s*(?:of|\/|von|de|sur|di)\s*(\d+)/i);
    return m ? { current: Number(m[1]) - 1, total: Number(m[2]) } : null;
  }

  async currentPageIndex() {
    if (this.navStrategy === 'items') {
      const idx = await this.frame.locator(this.pageItemSelector).evaluateAll((els, active) => els.findIndex((e) => e.matches(active) || !!e.querySelector(active)), this.sel.pageItemActive).catch(() => -1);
      if (idx >= 0) return idx;
    }
    const c = await this.pageCounter();
    return c ? c.current : 0;
  }

  async currentPageName() {
    const i = await this.currentPageIndex();
    return this.pages[i]?.name ?? null;
  }

  async gotoPage(ref, { force = false } = {}) {
    const target = this.pages.find((p) => p.index === ref.index) || ref;
    if (!force && (await this.currentPageIndex()) === target.index) return;
    if (this.navStrategy === 'items') {
      const item = this.frame.locator(this.pageItemSelector).nth(target.index);
      if (!(await item.isVisible().catch(() => false))) {
        for (const t of asList(this.sel.pageListToggle)) {
          const tog = this.frame.locator(t).first();
          if (await tog.isVisible().catch(() => false)) { await tog.click({ timeout: 5000 }).catch(() => {}); await sleep(400); break; }
        }
      }
      if (force) { await item.dispatchEvent('click').catch(() => {}); await sleep(300); }
      else if (await item.isVisible().catch(() => false)) await item.click({ timeout: this.cfg.timing.actionTimeoutMs }).catch(() => item.dispatchEvent('click'));
      else await item.dispatchEvent('click');
      await this.waitForPageIndex(target.index, 8000);
      if ((await this.currentPageIndex()) !== target.index) {
        await this.page.keyboard.press('Escape').catch(() => {});
        await item.dispatchEvent('click').catch(() => {});
        await this.waitForPageIndex(target.index, 8000);
      }
    }
    if ((await this.currentPageIndex()) !== target.index) await this.stepTo(target.index);
    await this.waitStable();
    const now = await this.currentPageIndex();
    if (now !== target.index) throw new ReportError('NAVIGATION', `Could not navigate to page "${target.name}" (still on #${now + 1})`);
    if (!target.url) target.url = this.page.url();
    await this.fitViewport();
  }

  async waitForPageIndex(index, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if ((await this.currentPageIndex()) === index) return true;
      await sleep(250);
    }
    return false;
  }

  async stepTo(index) {
    for (let guard = 0; guard < 200; guard++) {
      const cur = await this.currentPageIndex();
      if (cur === index) return;
      const btn = this.frame.locator(joinSel(cur < index ? this.sel.nextPage : this.sel.prevPage)).first();
      if (!(await btn.count())) return;
      try {
        await btn.click({ timeout: 8000 });
      } catch {
        await btn.dispatchEvent('click').catch(() => {});
      }
      const expected = cur < index ? cur + 1 : cur - 1;
      if (!(await this.waitForPageIndex(expected, 8000))) return;
    }
  }

  /** Hard reset: reload the report and return to a page. */
  async reloadToPage(ref) {
    this.reloads++;
    this.log('info', `Reloading report to restore "${ref.name}"`);
    const url = this.navStrategy === 'items' && ref.url && ref.url !== this.url && /reportsection|pagename=|\/reports\//i.test(ref.url) ? ref.url : this.url;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.cfg.timing.loadTimeoutMs });
    this.frame = this.page.mainFrame();
    this.offset = { x: 0, y: 0 };
    await this.waitForReport();
    if (this.cfg.resetToDefaultOnLoad) await this.resetToDefault();
    await this.waitStable();
    await this.gotoPage(ref);
    await this.fitViewport(); // gotoPage returns early when the report reopened on this page
    // Puts back slicer selections the run set on purpose (aligned / fixed parameters).
    if (this.afterReload) await this.afterReload().catch((e) => this.log('warn', `Could not re-apply slicer selections after reload: ${e.message.split('\n')[0]}`));
  }

  /**
   * Returns the page to its baseline state. Tries the cheap path first; if the
   * page still differs from the baseline, resets or reloads.
   *
   * "Same as the baseline" means the screenshot matches AND, when `sameState`
   * is given, the page's values do (sameState(extraction) → boolean). Pixels
   * alone are not enough: a slicer value left selected can change one card and
   * a few numbers, well under the pixel tolerance, and would then leak into
   * the next check as a false difference.
   */
  async restore(ref, baseline, softUndo, sameState = null) {
    const tol = Math.max(this.cfg.thresholds.maxDiffRatio, 0.0005);
    // Pixel-identical is the baseline, whatever the DOM says (Power BI can leave
    // a chart's accessibility labels stale after a highlight is cleared).
    const atBaseline = async (shot) => {
      const r = quickRatio(shot, baseline, this.cfg.thresholds.pixelThreshold);
      return r === 0 || (r <= tol && (!sameState || sameState(await this.extract())));
    };
    await this.closePopups();
    await this.dismissOverlays();
    if (softUndo) {
      try { await softUndo(); await this.waitStable(); } catch (e) { this.log('debug', `soft undo failed: ${e.message}`); }
    }
    if ((await this.currentPageIndex()) !== ref.index) await this.gotoPage(ref).catch(() => {});
    let shot = await this.screenshotCanvas();
    if (await atBaseline(shot)) return { reloaded: false };
    // "Reset to default" puts slicers, filters, drill and sort back in a few
    // seconds; a reload opens the whole report again (often well over a minute).
    if (this.cfg.resetToDefaultOnLoad && await this.resetToDefault()) {
      await this.waitStable();
      if ((await this.currentPageIndex()) !== ref.index) await this.gotoPage(ref).catch(() => {});
      if (this.afterReload) await this.afterReload().catch((e) => this.log('warn', `Could not re-apply slicer selections after reset: ${e.message.split('\n')[0]}`));
      shot = await this.screenshotCanvas();
      if (await atBaseline(shot)) { this.resets++; return { reloaded: false, reset: true }; }
    }
    await this.reloadToPage(ref);
    shot = await this.screenshotCanvas();
    const r = quickRatio(shot, baseline, this.cfg.thresholds.pixelThreshold);
    if (r > tol || (r > 0 && sameState && !sameState(await this.extract()))) {
      this.log('warn', `Page "${ref.name}" differs from its initial state after reload (${(r * 100).toFixed(2)}% of pixels): using this state as the new starting point, so later checks don't reload again`);
      return { reloaded: true, drifted: true, shot };
    }
    return { reloaded: true };
  }

  async closePopups() {
    const out = [];
    for (const p of this.popups.splice(0)) {
      out.push(p.url());
      await p.close().catch(() => {});
    }
    return out;
  }

  // -------------------------------------------------------- interactions
  async clickAt(x, y, opts = {}) {
    await this.page.mouse.move(x, y);
    await this.page.mouse.click(x, y, opts);
  }

  async clickVisual(v) {
    await this.clickAt(v.pageBox.x + v.pageBox.w / 2, v.pageBox.y + v.pageBox.h / 2);
  }

  async hoverVisual(v) {
    await this.page.mouse.move(v.pageBox.x + v.pageBox.w / 2, v.pageBox.y + Math.min(v.pageBox.h / 2, 40));
    await sleep(350);
  }

  /** Polls `read` until it returns the same non-empty answer twice in a row, or time runs out. */
  async untilSteady(read, { timeout = 1500, every = 120, empty = (x) => !x } = {}) {
    const end = Date.now() + timeout;
    let prev = null, cur = null;
    for (;;) {
      cur = await read();
      if (!empty(cur) && prev !== null && JSON.stringify(cur) === JSON.stringify(prev)) return cur;
      prev = empty(cur) ? null : cur;
      if (Date.now() >= end) return cur;
      await sleep(every);
    }
  }

  async headerButtons(v) {
    await this.hoverVisual(v);
    const r = await this.frame.evaluate(headerButtonsInPage, { domIndex: v.domIndex, sel: this.sel, labels: this.sel.headerButtonLabels });
    for (const b of Object.values(r)) { b.x += this.offset.x; b.y += this.offset.y; }
    return r;
  }

  async clickHeader(v, key) {
    const btns = await this.headerButtons(v);
    const b = btns[key];
    if (!b || b.disabled) return false;
    await this.clickAt(b.x, b.y);
    return true;
  }

  async navigatorItems(v) {
    const items = await this.frame.evaluate(navigatorItemsInPage, { domIndex: v.domIndex, sel: this.sel });
    return items.map((i) => ({ ...i, x: i.x + this.offset.x, y: i.y + this.offset.y }));
  }

  async dataPoints(v, max = 50) {
    const pts = await this.frame.evaluate(dataPointsInPage, { domIndex: v.domIndex, sel: this.sel, max });
    return pts.map((p) => ({ ...p, x: p.x + this.offset.x, y: p.y + this.offset.y }));
  }

  async contextMenuAt(x, y) {
    await this.page.mouse.move(x, y);
    await this.page.mouse.click(x, y, { button: 'right' });
    // The menu opens within a moment; wait for its items rather than a fixed pause.
    return this.untilSteady(() => this.frame.evaluate(contextMenuInPage, { selector: this.sel.contextMenuItem }), { timeout: 1200, empty: (m) => !m.length });
  }

  async clickMenuItem(pattern) {
    const re = new RegExp(pattern, 'i');
    const items = this.frame.locator(this.sel.contextMenuItem);
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const it = items.nth(i);
      const label = ((await it.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (re.test(label) && (await it.isVisible().catch(() => false))) {
        await it.click({ timeout: this.cfg.timing.actionTimeoutMs });
        return label;
      }
    }
    await this.page.keyboard.press('Escape').catch(() => {});
    return null;
  }

  /** Hovers (then, if nothing opened, clicks) a context-menu item; returns the items of the submenu it opened. */
  async openSubmenu(pattern) {
    const re = new RegExp(pattern, 'i');
    const before = await this.frame.evaluate(contextMenuInPage, { selector: this.sel.contextMenuItem });
    const items = this.frame.locator(this.sel.contextMenuItem);
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const it = items.nth(i);
      const label = ((await it.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!re.test(label) || !(await it.isVisible().catch(() => false))) continue;
      const known = new Set(before.map((b) => b.label));
      await it.hover({ timeout: this.cfg.timing.actionTimeoutMs }).catch(() => {});
      await sleep(500);
      let after = await this.frame.evaluate(contextMenuInPage, { selector: this.sel.contextMenuItem });
      if (!after.some((a) => !known.has(a.label))) {
        await it.click({ timeout: this.cfg.timing.actionTimeoutMs }).catch(() => {});
        await sleep(500);
        after = await this.frame.evaluate(contextMenuInPage, { selector: this.sel.contextMenuItem });
      }
      return after.filter((a) => !known.has(a.label));
    }
    return null;
  }

  /** The tooltip on screen, once it has appeared and stopped changing (null if none shows up). */
  async tooltip({ timeout = 1800 } = {}) {
    const t = await this.untilSteady(() => this.frame.evaluate(tooltipInPage, { selectors: asList(this.sel.tooltip) }), { timeout, every: 150 });
    if (t) t.box = { x: t.box.x + this.offset.x, y: t.box.y + this.offset.y, w: t.box.w, h: t.box.h };
    return t;
  }

  /** Opens a dropdown slicer if needed and returns the selectable item labels. */
  /**
   * Closes leftover dropdowns, menus and their invisible backdrops (Power BI's
   * cdk overlays), which otherwise swallow the next click.
   */
  async dismissOverlays() {
    await this.page.keyboard.press('Escape').catch(() => {});
    const backdrop = this.frame.locator('.cdk-overlay-backdrop-showing');
    for (let i = 0; i < 3 && (await backdrop.count().catch(() => 0)); i++) {
      await backdrop.last().click({ force: true, timeout: 2000 }).catch(() => {});
      await sleep(200);
    }
    // A dropdown slicer ignores Escape once the keyboard focus has left its list
    // (after scrolling it): it says it is still open, so close it at its own toggle.
    const open = this.frame.locator(`:is(${this.sel.slicerDropdown})[aria-expanded="true"]`);
    for (let i = 0; i < 3 && (await open.count().catch(() => 0)); i++) {
      await open.first().click({ timeout: 2000 }).catch(() => {});
      await sleep(250);
    }
  }

  async slicerItems(v) {
    const vc = this.frame.locator(this.sel.visualContainer).nth(v.domIndex);
    let scope = vc;
    let items = vc.locator(this.sel.slicerItem);
    if (v.slicer?.hasDropdown) {
      await this.dismissOverlays();
      const dd = vc.locator(this.sel.slicerDropdown).first();
      await dd.click({ timeout: this.cfg.timing.actionTimeoutMs }).catch(async () => {
        await this.dismissOverlays();
        await dd.click({ timeout: this.cfg.timing.actionTimeoutMs, force: true });
      });
      scope = this.frame.locator('body');
      items = this.popupItems();
      if (!(await this.waitForItems(items)) && !this.popupInside && await this.frame.locator(`${this.sel.slicerItem}:visible`).count().catch(() => 0)) {
        this.popupInside = true; // this report draws the list inside the visual
        items = this.popupItems();
      }
    }
    const labels = await items.evaluateAll((els) => els.map((e) => (e.getAttribute('title') || e.textContent || '').replace(/\s+/g, ' ').trim()));
    return { labels, scope };
  }

  async selectSlicerItem(v, label) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const hit = await this.findSlicerItem(v, label);
      if (!hit) {
        await this.dismissOverlays();
        return false;
      }
      if (!(await this.clickSlicerHit(hit))) { await sleep(300); continue; } // the list redrew: look again
      await sleep(300);
      if (v.slicer?.hasDropdown) await this.dismissOverlays();
      return true;
    }
    await this.dismissOverlays();
    throw new Error(`The list of slicer "${v.title || ''}" kept changing while selecting "${label}"`);
  }

  /**
   * Clicks the row found by findSlicerItem, but only if it still holds that
   * value. Long lists reuse their rows as they scroll, so "the 4th row" can be
   * a different value a moment later; clicking it would select the wrong one.
   */
  async clickSlicerHit(hit, opts = {}) {
    const now = await hit.el.evaluate((e) => (e.getAttribute('title') || e.textContent || '').replace(/\s+/g, ' ').trim(), null, { timeout: 2000 }).catch(() => null);
    if (now === null || norm(now) !== norm(hit.label)) return false;
    await hit.el.click({ timeout: this.cfg.timing.actionTimeoutMs, ...opts });
    return true;
  }

  /**
   * Items of an open dropdown slicer. Power BI draws the list outside the
   * visual, so items inside visuals (list slicers on the same page) are left out.
   */
  popupItems() {
    if (this.popupInside) return this.frame.locator(`${this.sel.slicerItem}:visible`);
    return this.frame.locator(`${this.sel.slicerItem}:not(:is(${this.sel.visualContainer}) *):visible`);
  }

  /** Waits until a slicer list has rendered its items (they load after the list opens). */
  async waitForItems(items, timeout = 6000) {
    const end = Date.now() + timeout;
    let last = -1;
    while (Date.now() < end) {
      const n = await items.count().catch(() => 0);
      if (n > 0 && n === last) return n;
      last = n;
      await sleep(350);
    }
    return Math.max(0, last);
  }

  /**
   * The values selected in a slicer ([] = nothing selected / all). List slicers
   * are read from their ticks; a dropdown from the text it shows ("CFI", "All"),
   * and only opened when it says "Multiple selections".
   */
  async slicerSelection(v) {
    const pick = (items) => {
      if (items.some((i) => i.checked && /^select all$/i.test(i.label))) return [];
      return items.filter((i) => i.checked && i.label && !/^select all$/i.test(i.label)).map((i) => i.label);
    };
    if (!v.slicer?.hasDropdown) return pick(v.slicer?.items || []);
    const shown = dropdownText(v);
    if (shown !== null) return shown;
    await this.openSlicerList(v);
    const items = await this.popupItems().evaluateAll((els) => els.map((e) => ({
      label: (e.getAttribute('title') || e.textContent || '').replace(/\s+/g, ' ').trim(),
      checked: e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true' || !!e.querySelector('[aria-checked="true"], [aria-selected="true"], .selected'),
    })));
    await this.dismissOverlays();
    return pick(items);
  }

  /** Opens a dropdown slicer's list unless it is already open. */
  async openSlicerList(v) {
    if (!v.slicer?.hasDropdown) return;
    if (await this.popupItems().count().catch(() => 0)) return;
    await this.slicerItems(v);
  }

  /**
   * Finds a value in a slicer's list. Long lists only render the rows in view,
   * so it uses the slicer's search box when there is one, otherwise scrolls.
   * Returns { scope, idx, checked } or null.
   */
  async findSlicerItem(v, label) {
    await this.openSlicerList(v);
    const scope = v.slicer?.hasDropdown
      ? this.popupItems()
      : this.frame.locator(this.sel.visualContainer).nth(v.domIndex).locator(this.sel.slicerItem);
    await this.waitForItems(scope, 4000);
    const look = async () => {
      // The matching row is marked in the page so the click goes to that element, not to a position in the list.
      const token = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const info = await scope.evaluateAll((els, { want, mark }) => {
        const text = (e) => (e.getAttribute('title') || e.textContent || '').replace(/\s+/g, ' ').trim();
        const labels = els.map(text);
        const idx = labels.findIndex((l) => l.toLowerCase() === want);
        if (idx < 0) return { idx, labels };
        for (const old of document.querySelectorAll('[data-pbiv-hit]')) old.removeAttribute('data-pbiv-hit');
        els[idx].setAttribute('data-pbiv-hit', mark);
        return { idx, labels, checked: els[idx].getAttribute('aria-checked') === 'true' || els[idx].getAttribute('aria-selected') === 'true' };
      }, { want: norm(label), mark: token });
      return info.idx < 0 ? null : { scope, idx: info.idx, checked: info.checked, labels: info.labels, label, el: this.frame.locator(`[data-pbiv-hit="${token}"]`) };
    };
    let hit = await look();
    if (hit) return hit;
    const search = (v.slicer?.hasDropdown ? this.frame.locator(this.sel.slicerSearch).filter({ visible: true })
      : this.frame.locator(this.sel.visualContainer).nth(v.domIndex).locator(this.sel.slicerSearch)).first();
    if (await search.count().catch(() => 0)) {
      await search.fill(label, { timeout: 5000 }).catch(() => {});
      await sleep(900);
      await this.waitForItems(scope, 3000);
      hit = await look();
      if (hit) return hit;
      await search.fill('', { timeout: 5000 }).catch(() => {});
      await sleep(600);
    }
    // Scroll through the list, looking at each screenful: from the top, since a
    // list that was scrolled before reopens where it was left.
    const toTop = await scope.last().evaluate((e) => {
      let depth = 0;
      for (let n = e.parentElement; n && depth < 12; n = n.parentElement, depth++) {
        if (n.scrollHeight <= n.clientHeight + 4 || !/auto|scroll|overlay/.test(getComputedStyle(n).overflowY)) continue;
        if (n.scrollTop > 0) { n.scrollTop = 0; return true; }
      }
      return false;
    }).catch(() => false);
    if (toTop) {
      await sleep(350);
      hit = await look();
      if (hit) return hit;
    }
    let prev = '';
    for (let i = 0; i < 60; i++) {
      // Scroll the list itself (its own scroll container); the mouse wheel is the
      // fallback, over a row in the middle (the last rendered row can be out of view).
      const moved = await scope.last().evaluate((e) => {
        let depth = 0;
        for (let n = e.parentElement; n && depth < 12; n = n.parentElement, depth++) {
          if (n.scrollHeight <= n.clientHeight + 4 || !/auto|scroll|overlay/.test(getComputedStyle(n).overflowY)) continue;
          const before = n.scrollTop;
          n.scrollTop = before + Math.max(60, n.clientHeight * 0.8);
          if (n.scrollTop !== before) return true;
        }
        return false;
      }).catch(() => false);
      if (!moved) {
        const count = await scope.count().catch(() => 0);
        const box = count ? await scope.nth(Math.floor(count / 2)).boundingBox().catch(() => null) : null;
        if (!box) break;
        await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await this.page.mouse.wheel(0, Math.max(120, box.height * 4));
      }
      await sleep(350);
      hit = await look();
      if (hit) return hit;
      const now = (await scope.evaluateAll((els) => els.map((e) => e.getAttribute('title') || e.textContent).join('|')).catch(() => ''));
      if (now === prev) break; // end of the list
      prev = now;
    }
    return null;
  }

  /**
   * Sets a slicer to exactly these values ([] = clear). Returns the values that
   * do not exist in this report's slicer.
   */
  async setSlicerSelection(v, labels) {
    await this.clearSlicer(v);
    await this.waitStable({ timeout: 15000 });
    if (!labels.length) return { missing: [] };
    const missing = [];
    let clicked = 0;
    for (const want of labels) {
      const hit = await this.findSlicerItem(v, want);
      if (!hit) { missing.push(want); continue; }
      if (hit.checked) { clicked++; continue; } // single-select slicers keep one value
      let done = await this.clickSlicerHit(hit, { modifiers: clicked ? ['ControlOrMeta'] : [] });
      for (let again = 0; !done && again < 2; again++) { // the list redrew between finding and clicking
        await sleep(300);
        const h2 = await this.findSlicerItem(v, want);
        if (!h2) break;
        done = h2.checked || await this.clickSlicerHit(h2, { modifiers: clicked ? ['ControlOrMeta'] : [] });
      }
      if (!done) { missing.push(want); continue; }
      clicked++;
      await sleep(300);
    }
    if (v.slicer?.hasDropdown) await this.dismissOverlays();
    await this.waitStable({ timeout: 20000 });
    return { missing };
  }

  /**
   * Types values into a range/date slicer's boxes (from, to). The runner reads
   * the slicer again afterwards to see whether Power BI accepted them.
   */
  async setSlicerRange(v, values) {
    const inputs = this.frame.locator(this.sel.visualContainer).nth(v.domIndex).locator(this.sel.slicerRangeInputs);
    const n = Math.min(await inputs.count(), values.length);
    for (let i = 0; i < n; i++) {
      const input = inputs.nth(i);
      if (((await input.inputValue().catch(() => '')) || '').trim() === values[i]) continue;
      await input.fill(values[i], { timeout: this.cfg.timing.actionTimeoutMs });
      await input.press('Enter').catch(() => {});
      await this.waitStable({ timeout: 20000 });
    }
    await this.parkMouse();
  }

  /**
   * Clears a slicer with its eraser button and checks that it took: the button
   * only shows while the mouse is over the slicer, and a click that misses it
   * leaves the selection in place. Returns false when the slicer still shows
   * a selection (some slicers must always have one).
   */
  async clearSlicer(v) {
    const clr = this.frame.locator(this.sel.visualContainer).nth(v.domIndex).locator(this.sel.slicerClear).first();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) { await this.parkMouse(); await sleep(200); }
      await this.hoverVisual(v);
      if (!(await clr.count())) return false;
      if (attempt) await clr.click({ timeout: 3000 }).catch(() => clr.dispatchEvent('click').catch(() => {}));
      else await clr.click({ force: true, timeout: 5000 }).catch(() => clr.dispatchEvent('click'));
      await sleep(400);
      const now = (await this.extract({ onlyIndex: v.domIndex }).catch(() => null))?.visuals[0];
      if (!now?.slicer) return true; // can't read it: as before
      const cleared = now.slicer.hasDropdown ? dropdownText(now)?.length === 0 : !now.slicer.items.some((i) => i.checked && !/^select all$/i.test(i.label));
      if (cleared) return true;
    }
    return false;
  }

  async expandMatrixRows(v, n) {
    const vc = this.frame.locator(this.sel.visualContainer).nth(v.domIndex);
    let done = 0;
    for (let i = 0; i < n; i++) {
      const exp = vc.locator(this.sel.matrixExpander).first();
      if (!(await exp.count())) break;
      await exp.click({ timeout: this.cfg.timing.actionTimeoutMs, force: true });
      done++;
      await this.waitStable({ timeout: 15000 });
    }
    return done;
  }
}

/**
 * What a dropdown slicer shows when closed: [] for "All", [value] for one value,
 * null when it can't tell ("Multiple selections", nothing shown).
 */
export function dropdownText(v) {
  const t = norm(v.title);
  const shown = (v.lines || []).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && norm(l) !== t);
  if (shown.length !== 1) return null;
  if (/^(all|select all|\(all\)|tout|alle|todos)$/i.test(shown[0])) return [];
  if (/multiple selections|^\(?blank\)?$|selections?$/i.test(shown[0])) return null;
  return [shown[0]];
}

export function redact(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('r')) u.searchParams.set('r', u.searchParams.get('r').slice(0, 8) + '…');
    return u.toString();
  } catch { return url; }
}
