import crypto from 'node:crypto';
import { asList, joinSel } from './selectors.js';
import {
  extractVisualsInPage, renderSignatureInPage, headerButtonsInPage, navigatorItemsInPage,
  dataPointsInPage, tooltipInPage, contextMenuInPage, canvasBoxInPage,
} from './inpage.js';
import { quickRatio } from './compare.js';

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
    this.popups = [];
    // Only windows this tab opens (other tabs of the same browser context belong to other workers).
    page.on('popup', (p) => this.popups.push(p));
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
    if (!(await btn.isVisible().catch(() => false)) || !(await btn.isEnabled().catch(() => false))) return;
    this.log('info', 'Applying "Reset to default" to clear persistent filters');
    await btn.click({ timeout: 5000 }).catch(() => {});
    for (const s of asList(this.sel.resetConfirm)) {
      const c = this.page.locator(s).first();
      if (await c.isVisible().catch(() => false)) { await c.click({ timeout: 5000 }).catch(() => {}); break; }
    }
    await sleep(1000);
  }

  /** Waits until no spinners are visible and both DOM and pixels stop changing. */
  async waitStable({ timeout = this.cfg.timing.stableTimeoutMs } = {}) {
    const start = Date.now();
    await sleep(this.cfg.timing.settleMs);
    let last = null, same = 0;
    while (Date.now() - start < timeout) {
      const s = await this.frame.evaluate(renderSignatureInPage, { sel: this.sel }).catch(() => null);
      if (s && !s.busy && s.sig === last) {
        if (++same >= 2) {
          // DOM settled; confirm pixels are stable too (canvas/WebGL visuals, animations).
          const h1 = await this.canvasHash();
          await sleep(450);
          const h2 = await this.canvasHash();
          if (h1 && h1 === h2) return true;
          same = 0;
        }
      } else same = 0;
      last = s?.sig ?? null;
      await sleep(350);
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
  }

  /**
   * Returns the page to its baseline state. Tries the cheap path first; if the
   * canvas still differs from the baseline, reloads.
   */
  async restore(ref, baseline, softUndo) {
    const tol = Math.max(this.cfg.thresholds.maxDiffRatio, 0.0005);
    await this.closePopups();
    await this.dismissOverlays();
    if (softUndo) {
      try { await softUndo(); await this.waitStable(); } catch (e) { this.log('debug', `soft undo failed: ${e.message}`); }
    }
    if ((await this.currentPageIndex()) !== ref.index) await this.gotoPage(ref).catch(() => {});
    let shot = await this.screenshotCanvas();
    if (quickRatio(shot, baseline, this.cfg.thresholds.pixelThreshold) <= tol) return { reloaded: false };
    await this.reloadToPage(ref);
    shot = await this.screenshotCanvas();
    const r = quickRatio(shot, baseline, this.cfg.thresholds.pixelThreshold);
    if (r > tol) {
      this.log('warn', `Page "${ref.name}" differs from its initial state after reload (${(r * 100).toFixed(2)}%): using this state as the new starting point, so later checks don't reload again`);
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
    await sleep(500);
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
    await sleep(600);
    return this.frame.evaluate(contextMenuInPage, { selector: this.sel.contextMenuItem });
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

  async tooltip() {
    const t = await this.frame.evaluate(tooltipInPage, { selectors: asList(this.sel.tooltip) });
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
      await sleep(700);
      scope = this.frame.locator('body');
      items = this.frame.locator(`${this.sel.slicerItem}:visible`);
    }
    const labels = await items.evaluateAll((els) => els.map((e) => (e.getAttribute('title') || e.textContent || '').replace(/\s+/g, ' ').trim()));
    return { labels, scope };
  }

  async selectSlicerItem(v, label) {
    const { labels } = await this.slicerItems(v);
    const idx = labels.findIndex((l) => norm(l) === norm(label));
    if (idx < 0) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    const loc = v.slicer?.hasDropdown
      ? this.frame.locator(`${this.sel.slicerItem}:visible`).nth(idx)
      : this.frame.locator(this.sel.visualContainer).nth(v.domIndex).locator(this.sel.slicerItem).nth(idx);
    await loc.click({ timeout: this.cfg.timing.actionTimeoutMs });
    await sleep(300);
    if (v.slicer?.hasDropdown) await this.page.keyboard.press('Escape').catch(() => {});
    return true;
  }

  async clearSlicer(v) {
    const clr = this.frame.locator(this.sel.visualContainer).nth(v.domIndex).locator(this.sel.slicerClear).first();
    await this.hoverVisual(v);
    if (await clr.count()) await clr.click({ force: true, timeout: 5000 }).catch(() => clr.dispatchEvent('click'));
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

export function redact(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('r')) u.searchParams.set('r', u.searchParams.get('r').slice(0, 8) + '…');
    return u.toString();
  } catch { return url; }
}
