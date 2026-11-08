import fs from 'node:fs';
import { chromium } from 'playwright';
import { PbiReport, ReportError } from './pbi.js';
import { resolveSelectors } from './selectors.js';
import { anyMatch } from './options.js';
import { runModelChecks } from '../model/checks.js';
import { matchPages, matchVisuals, structuralDiff, visualLabel } from './matcher.js';
import {
  diffImages, cropBuffer, diffLines, makeNormalizer, visualDataLines, quickRatio, annotateBoxes,
} from './compare.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fraction of canvas pixels that must change (after jitter filtering) for an
// interaction to count as having had a visible effect.
const CHANGE_EPS = 0.00002;

export class CancelledError extends Error {
  constructor() { super('Run cancelled'); this.code = 'CANCELLED'; }
}

const STABILISE_CSS = `
*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; caret-color: transparent !important; }
::-webkit-scrollbar { display: none !important; }
`;

export async function launchBrowser({ headless = true } = {}) {
  return chromium.launch({
    headless,
    args: ['--disable-dev-shm-usage', '--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars', '--disable-gpu-rasterization'],
  });
}

/**
 * A regular desktop Chrome user agent for this browser build. Headless Chromium
 * otherwise announces "HeadlessChrome", which some sign-in pages treat as a bot;
 * sign-in and test runs use the same agent so saved sessions stay valid.
 */
export function browserUserAgent(browser) {
  const major = String(browser.version()).split('.')[0];
  const os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export async function newReportContext(browser, cfg, statePath) {
  const context = await browser.newContext({
    userAgent: browserUserAgent(browser),
    viewport: cfg.viewport,
    deviceScaleFactor: 1,
    locale: cfg.locale,
    timezoneId: cfg.timezone,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    storageState: statePath && fs.existsSync(statePath) ? statePath : undefined,
  });
  await context.addInitScript((css) => {
    const add = () => {
      if (document.getElementById('__pbiv_stabilise')) return;
      const s = document.createElement('style');
      s.id = '__pbiv_stabilise';
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  }, STABILISE_CSS);
  context.setDefaultTimeout(cfg.timing.actionTimeoutMs);
  return context;
}

/**
 * Executes a validation run.
 *
 * ctx = {
 *   mode: 'compare' | 'single', cfg, signal,
 *   reports: { A: {name,url,statePath}, B?: {...} },
 *   log(level, msg), progress(fraction, phase),
 *   record(result) -> Promise, saveState(side, state) -> Promise
 * }
 */
export async function executeRun(ctx) {
  const { cfg, signal } = ctx;
  const compare = ctx.mode !== 'single' && !!ctx.reports.B;
  const sel = resolveSelectors(cfg.selectors);
  const tol = cfg.thresholds.maxDiffRatio;
  const normalize = makeNormalizer(cfg.ignore.textPatterns);
  const log = ctx.log;
  const checkAbort = () => { if (signal?.aborted) throw new CancelledError(); };

  const browser = await launchBrowser({ headless: ctx.headless !== false });
  const sides = [];
  const counters = { scenarios: 0, reloads: 0 };
  try {
    for (const name of compare ? ['A', 'B'] : ['A']) {
      const rep = ctx.reports[name];
      const context = await newReportContext(browser, cfg, rep.statePath);
      const page = await context.newPage();
      sides.push({ name, rep, context, report: new PbiReport(page, { url: rep.url, side: name, sel, cfg, log, signedIn: !!(rep.statePath && fs.existsSync(rep.statePath)) }) });
    }
    const S = Object.fromEntries(sides.map((s) => [s.name, s]));
    const both = (fn) => Promise.all(sides.map((s) => fn(s)));

    // ---------------------------------------------------------------- load
    ctx.progress(0.02, 'Loading reports');
    const loadMs = {};
    await both(async (s) => {
      const t0 = Date.now();
      await s.report.open();
      loadMs[s.name] = Date.now() - t0;
    });
    log('info', `Reports loaded (${Object.entries(loadMs).map(([k, v]) => `${k}: ${(v / 1000).toFixed(1)}s`).join(', ')})`);
    checkAbort();

    // --------------------------------------------------------------- pages
    ctx.progress(0.05, 'Discovering pages');
    const pages = {};
    await both(async (s) => { pages[s.name] = await s.report.listPages(); });
    const pm = matchPages(pages.A, compare ? pages.B : null);
    const renamed = pm.pairs.filter((p) => p.how === 'position');
    const orderChanged = compare && pm.pairs.some((p) => p.a.index !== p.b.index);
    await ctx.record({
      page: '', scenario: 'report_pages', target: 'pages',
      title: 'Report page inventory',
      status: compare && (pm.onlyA.length || pm.onlyB.length || renamed.length || orderChanged) ? 'diff' : 'pass',
      details: {
        loadMs,
        pagesA: pages.A.map((p) => p.name),
        pagesB: compare ? pages.B.map((p) => p.name) : null,
        onlyInA: pm.onlyA.map((p) => p.name),
        onlyInB: pm.onlyB.map((p) => p.name),
        renamed: renamed.map((p) => ({ a: p.a.name, b: p.b.name })),
        orderChanged,
      },
    });

    // ---------------------------------------------------------- data model
    if (cfg.scenarios.model) {
      ctx.progress(0.06, 'Comparing data models');
      try {
        await runModelChecks({
          compare, reports: ctx.reports, record: ctx.record, log,
          // The Power BI web app keeps the signed-in user's API token in the page.
          browserToken: (side) => S[side].report.page.evaluate(() => window.powerBIAccessToken || null),
        });
      } catch (e) {
        log('warn', `Data model check failed: ${e.message}`);
        await ctx.record({ page: '', scenario: 'model', target: 'model', title: 'Data model comparison', status: 'warn', details: { note: `Could not compare the data models: ${e.message}` } });
      }
      checkAbort();
    }

    const inScope = (name) => (!cfg.pages.include.length || anyMatch(cfg.pages.include, name)) && !anyMatch(cfg.pages.exclude, name);
    const pairs = pm.pairs.filter((p) => inScope(p.a.name));
    const orphans = [
      ...pm.onlyA.filter((p) => inScope(p.name)).map((p) => ({ side: 'A', p })),
      ...pm.onlyB.filter((p) => inScope(p.name)).map((p) => ({ side: 'B', p })),
    ];
    const totalUnits = pairs.length + orphans.length * 0.2 || 1;
    let done = 0;

    for (const o of orphans) {
      checkAbort();
      const s = S[o.side];
      await s.report.gotoPage(o.p);
      const shot = await s.report.screenshotCanvas();
      await ctx.record({
        page: o.p.name, scenario: 'page_render', target: 'page',
        title: `Page "${o.p.name}" exists only in ${o.side}`,
        status: 'missing',
        images: { [o.side.toLowerCase()]: shot },
        details: { missingIn: o.side === 'A' ? 'B' : 'A' },
      });
      done += 0.2;
    }

    // Workers: each has its own tab of A and B, so several pages are tested
    // at once. Phase 1 checks every page's screenshot, layout and data; phase 2
    // runs interactions until the time budget is used up.
    const deadline = cfg.timing.budgetMinutes > 0 ? ctx.startedAt + cfg.timing.budgetMinutes * 60_000 - 45_000 : 0;
    const want = Math.min(cfg.limits.parallelPages || ctx.parallelPages || 1, Math.max(1, pairs.length));
    const lanes = [{ id: 1, sides, S, both }];
    if (want > 1) {
      ctx.progress(0.06, `Opening ${want - 1} more tab(s) for parallel pages`);
      const extra = await Promise.all(Array.from({ length: want - 1 }, async (_, i) => {
        try {
          const ls = [];
          // Tab labels: A2/B2, A3/B3… (logs only).
          for (const s0 of sides) {
            const page = await s0.context.newPage();
            ls.push({ name: s0.name, rep: s0.rep, context: s0.context, report: new PbiReport(page, { url: s0.rep.url, side: `${s0.name}${i + 2}`, sel, cfg, log, signedIn: s0.report.signedIn }) });
          }
          await Promise.all(ls.map(async (x) => { await x.report.open(); await x.report.listPages(); }));
          const LS = Object.fromEntries(ls.map((x) => [x.name, x]));
          return { id: i + 2, sides: ls, S: LS, both: (fn) => Promise.all(ls.map((x) => fn(x))) };
        } catch (e) {
          log('warn', `Parallel tab ${i + 2} could not open (${e.message.split('\n')[0]}); continuing with fewer`);
          return null;
        }
      }));
      lanes.push(...extra.filter(Boolean));
    }
    if (lanes.length > 1) log('info', `Testing ${lanes.length} pages at a time`);
    if (deadline) log('info', `Time budget: ${cfg.timing.budgetMinutes} min (interactions stop at ${new Date(deadline).toISOString().slice(11, 16)} UTC)`);

    const runPhase = async (phase, from, to) => {
      const queue = [...pairs];
      let finished = 0;
      await Promise.all(lanes.map(async (lane) => {
        for (let pair = queue.shift(); pair; pair = queue.shift()) {
          checkAbort();
          const ref = { A: pair.a, B: pair.b };
          // Each lane navigates its own tabs; page objects carry per-tab state.
          for (const x of lane.sides) ref[x.name] = x.report.pages.find((p) => p.index === ref[x.name].index) || ref[x.name];
          const pageName = pair.a.name;
          if (phase === 'interactive' && deadline && Date.now() > deadline) {
            await recordTimeSkip(ctx, pageName, { cfg });
            finished += 1;
            continue;
          }
          const frac = (x) => ctx.progress(from + (to - from) * ((finished + x) / Math.max(1, pairs.length)), `${phase === 'static' ? 'Checking' : 'Interacting with'} "${pageName}"`);
          frac(0);
          log('info', `── ${phase === 'static' ? 'Page' : 'Interactions on page'} "${pageName}"${compare && pair.how === 'position' ? ` (B: "${pair.b.name}")` : ''}${lanes.length > 1 ? ` [tab ${lane.id}]` : ''}`);
          try {
            await processPage({ ctx, cfg, sel, sides: lane.sides, S: lane.S, both: lane.both, ref, pageName, compare, tol, normalize, frac, checkAbort, counters, phase, deadline });
          } catch (e) {
            if (e instanceof CancelledError || e.code === 'AUTH_REQUIRED') throw e;
            log('error', `Page "${pageName}" failed: ${e.message.split('\n')[0]}`);
            await ctx.record({ page: pageName, scenario: 'health', target: `page-error-${phase}`, title: `Could not test "${pageName}"`, status: 'error', details: { error: e.message.split('\n').slice(0, 4).join('\n') } });
          }
          finished += 1;
        }
      }));
    };
    await runPhase('static', 0.07 + 0.02 * done, 0.4);
    await runPhase('interactive', 0.4, 0.97);

    counters.reloads = lanes.flatMap((l) => l.sides).reduce((n, s) => n + s.report.reloads, 0);
    counters.parallelPages = lanes.length;
    ctx.progress(0.99, 'Finalising');
    for (const s of sides) {
      if (s.rep.statePath && ctx.saveState) {
        try { await ctx.saveState(s.name, await s.context.storageState()); } catch (e) { log('warn', `Could not refresh session state: ${e.message}`); }
      }
    }
    return { loadMs, pages: { A: pages.A.length, B: pages.B?.length ?? null }, ...counters };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
async function processPage(env) {
  const { ctx, cfg, sel, sides, S, both, ref, pageName, compare, tol, normalize, frac, checkAbort, counters } = env;
  const log = ctx.log;
  const overBudget = () => !!env.deadline && Date.now() > env.deadline;
  let skippedForTime = 0;
  const renderMs = {};
  await both(async (s) => {
    const t0 = Date.now();
    await s.report.gotoPage(ref[s.name]);
    renderMs[s.name] = Date.now() - t0;
  });

  const base = {};
  const state = { ex: {}, match: null, byKey: new Map() };
  await both(async (s) => { base[s.name] = await s.report.screenshotCanvas(); });

  const ignoredType = (v) => cfg.ignore.visualTypes.some((t) => t.toLowerCase() === v.type.toLowerCase());
  const ignoredTitle = (v) => v.title && anyMatch(cfg.ignore.visualTitles, v.title);
  const refresh = async () => {
    await both(async (s) => { state.ex[s.name] = await s.report.extract(); });
    const vis = (n) => state.ex[n]?.visuals.filter((v) => !ignoredTitle(v)) ?? [];
    state.match = matchVisuals(vis('A'), compare ? vis('B') : []);
    if (!compare) {
      state.match.pairs = vis('A').map((a, i) => ({ a, b: null, key: `${a.type}|${a.title || '-'}#${i}` }));
      state.match.onlyA = [];
    }
    state.byKey = new Map(state.match.pairs.map((p) => [p.key, p]));
  };
  await refresh();

  const recordStatic = env.phase !== 'interactive';
  // Health -------------------------------------------------------------
  if (recordStatic) {
  const errs = Object.fromEntries(sides.map((s) => [s.name, state.ex[s.name].visuals.filter((v) => v.error).map((v) => ({ visual: visualLabel(v), error: v.error, box: v.box }))]));
  const anyErr = Object.values(errs).some((e) => e.length);
  await ctx.record({
    page: pageName, scenario: 'health', target: 'page',
    title: anyErr ? `Visual errors on "${pageName}"` : `All visuals rendered on "${pageName}"`,
    status: anyErr ? 'fail' : 'pass',
    images: anyErr ? Object.fromEntries(sides.filter((s) => errs[s.name].length).map((s) => [s.name.toLowerCase(), annotateBoxes(base[s.name], errs[s.name].map((e) => e.box))])) : {},
    details: { errors: errs, visualCount: Object.fromEntries(sides.map((s) => [s.name, state.ex[s.name].total])), renderMs },
  });
  }

  // Page render --------------------------------------------------------
  if (cfg.scenarios.pageRender && recordStatic) {
    await ctx.record(imageResult({
      page: pageName, scenario: 'page_render', target: 'page', title: `Page render · ${pageName}`,
      a: base.A, b: base.B, compare, cfg, details: { renderMs, canvasA: state.ex.A.canvas, canvasB: state.ex.B?.canvas },
    }));
  }

  // Structure ----------------------------------------------------------
  if (cfg.scenarios.structure && compare && recordStatic) {
    const issues = structuralDiff(state.match, cfg.thresholds);
    const inventory = state.match.pairs.map((p) => ({ visual: visualLabel(p.a), type: p.a.type, matchedBy: p.how, boxA: p.a.box, boxB: p.b.box }));
    await ctx.record({
      page: pageName, scenario: 'structure', target: 'layout',
      title: `Layout & visual inventory · ${pageName}`,
      status: issues.length ? 'diff' : 'pass',
      images: issues.length ? {
        a: annotateBoxes(base.A, state.match.onlyA.map((v) => v.box)),
        b: annotateBoxes(base.B, [...state.match.onlyB.map((v) => v.box), ...issues.filter((i) => i.kind === 'moved' || i.kind === 'resized').map((i) => i.b)]),
      } : {},
      details: { issues, countA: state.ex.A.total, countB: state.ex.B.total, inventory },
    });
  }

  // Per-visual ---------------------------------------------------------
  if (cfg.scenarios.visuals && recordStatic) {
    for (const p of state.match.pairs) {
      if (ignoredType(p.a)) continue;
      const a = cropBuffer(base.A, p.a.box), b = p.b ? cropBuffer(base.B, p.b.box) : null;
      if (!a) continue;
      const data = compare ? diffLines(visualDataLines(p.a), visualDataLines(p.b), { numericTolerance: cfg.thresholds.numericTolerance, normalize }) : null;
      const res = imageResult({ page: pageName, scenario: 'visual', target: p.key, title: visualLabel(p.a), a, b, compare, cfg, details: { type: p.a.type, matchedBy: p.how, data, linesA: compare ? undefined : visualDataLines(p.a).slice(0, 200), sample: compare ? visualDataLines(p.b).slice(0, 40) : undefined } });
      if (data && !data.equal) res.status = 'diff';
      if (p.a.error || p.b?.error) { res.status = 'fail'; res.details.error = { A: p.a.error, B: p.b?.error }; }
      await ctx.record(res);
    }
    for (const [side, list] of [['A', state.match.onlyA], ['B', state.match.onlyB]]) {
      for (const v of list) {
        if (ignoredType(v)) continue;
        await ctx.record({
          page: pageName, scenario: 'visual', target: `${v.type}|${v.title || '-'}`,
          title: `${visualLabel(v)} — only in ${side}`, status: 'missing',
          images: { [side.toLowerCase()]: cropBuffer(base[side], v.box) },
          details: { missingIn: side === 'A' ? 'B' : 'A', type: v.type, lines: visualDataLines(v).slice(0, 100) },
        });
      }
    }
  }
  frac(0.15);
  if (env.phase === 'static') return;
  if (overBudget()) { await recordTimeSkip(ctx, pageName, env); return; }

  // Interaction scenarios ---------------------------------------------
  const types = sel.types;
  const isType = (v, group) => types[group].some((t) => t.toLowerCase() === v.type.toLowerCase());
  const pairsWhere = (pred) => state.match.pairs.filter((p) => pred(p.a) && !ignoredTitle(p.a));
  const isChart = (v) => v.points.length > 0 && !v.slicer && !isType(v, 'slicer');

  const restoreAll = async (undo) => {
    const r = await Promise.all(sides.map((s) => s.report.restore(ref[s.name], base[s.name], undo ? () => undo(s) : null)));
    // A page that never returns to its first screenshot (live data, animations,
    // persisted filters) would otherwise be reloaded after every check.
    r.forEach((x, i) => { if (x.drifted && x.shot) base[sides[i].name] = x.shot; });
    if (r.some((x) => x.reloaded)) await refresh();
  };


  /** Runs one interaction scenario with retries, error capture and state restore. */
  const scenario = async (meta, fn, { undo, restore = true } = {}) => {
    checkAbort();
    if (overBudget()) { skippedForTime++; return; }
    counters.scenarios++;
    const t0 = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        const res = await fn();
        if (res) await ctx.record({ page: pageName, ...meta, ...res, durationMs: Date.now() - t0 });
        break;
      } catch (e) {
        if (e instanceof CancelledError || e.code === 'AUTH_REQUIRED') throw e;
        attempt++;
        log('warn', `Scenario "${meta.title}" failed (attempt ${attempt}): ${e.message.split('\n')[0]}`);
        if (attempt > cfg.retries) {
          const shots = {};
          await Promise.all(sides.map(async (s) => { shots[s.name.toLowerCase()] = await s.report.screenshotCanvas().catch(() => null); }));
          await ctx.record({ page: pageName, ...meta, status: 'error', images: shots, details: { error: e.message.split('\n').slice(0, 6).join('\n') }, durationMs: Date.now() - t0 });
          await Promise.all(sides.map((s) => s.report.reloadToPage(ref[s.name]).catch(() => {})));
          await refresh();
          return;
        }
        await Promise.all(sides.map((s) => s.report.reloadToPage(ref[s.name]).catch(() => {})));
        await refresh();
      }
    }
    if (restore) await restoreAll(undo);
  };

  /** Captures post-interaction state for every side. */
  const capturePage = async () => {
    const out = {};
    await both(async (s) => {
      await s.report.waitStable();
      out[s.name] = { shot: await s.report.screenshotCanvas(), ex: await s.report.extract() };
    });
    return out;
  };

  const pageDataDiff = (exA, exB) => {
    const m = matchVisuals(exA.visuals.filter((v) => !ignoredTitle(v)), exB.visuals.filter((v) => !ignoredTitle(v)));
    const diffs = [];
    for (const p of m.pairs) {
      if (ignoredType(p.a)) continue;
      const d = diffLines(visualDataLines(p.a), visualDataLines(p.b), { numericTolerance: cfg.thresholds.numericTolerance, normalize });
      if (!d.equal) diffs.push({ visual: visualLabel(p.a), added: d.added, removed: d.removed, ops: d.ops.slice(0, 60) });
    }
    for (const v of m.onlyA) if (!ignoredType(v)) diffs.push({ visual: visualLabel(v), only: 'A' });
    for (const v of m.onlyB) if (!ignoredType(v)) diffs.push({ visual: visualLabel(v), only: 'B' });
    return diffs;
  };

  /** Standard verdict for actions that change the whole page. */
  const pageVerdict = (cap, extra = {}) => {
    const changed = Object.fromEntries(sides.map((s) => [s.name, quickRatio(cap[s.name].shot, base[s.name], cfg.thresholds.pixelThreshold) > CHANGE_EPS]));
    const res = imageResult({ page: pageName, a: cap.A.shot, b: cap.B?.shot, compare, cfg, details: { changed, ...extra } });
    if (compare) {
      const dataDiffs = pageDataDiff(cap.A.ex, cap.B.ex);
      res.details.dataDiffs = dataDiffs;
      if (dataDiffs.length) res.status = 'diff';
    }
    if (!Object.values(changed).some(Boolean)) {
      if (res.status === 'pass') res.status = 'warn';
      res.details.note = 'Interaction produced no visible change';
    }
    return res;
  };

  // Buttons / navigators ------------------------------------------------
  if (cfg.scenarios.buttons) {
    const btns = pairsWhere((v) => isType(v, 'button') || isType(v, 'navigator') || v.actionable).slice(0, cfg.limits.buttonsPerPage);
    for (const p0 of btns) {
      const nav = isType(p0.a, 'navigator');
      let targets = [{ idx: -1, label: visualLabel(p0.a) }];
      if (nav) {
        const items = await S.A.report.navigatorItems(p0.a);
        targets = items.slice(0, 12).map((it, idx) => ({ idx, label: `${visualLabel(p0.a)} → ${it.label || `item ${idx + 1}`}` }));
      }
      for (const t of targets) {
        await scenario({ scenario: 'button', target: `${p0.key}${t.idx >= 0 ? `@${t.idx}` : ''}`, title: `Click ${t.label}` }, async () => {
          const p = state.byKey.get(p0.key);
          if (!p) return { status: 'skipped', details: { note: 'Visual no longer present after reset' } };
          const before = {};
          await both(async (s) => {
            const v = s.name === 'A' ? p.a : p.b;
            before[s.name] = await s.report.currentPageIndex();
            if (t.idx >= 0) {
              const items = await s.report.navigatorItems(v);
              const it = items[t.idx];
              if (!it) throw new Error(`Navigator item ${t.idx + 1} missing in ${s.name}`);
              await s.report.clickAt(it.x, it.y);
            } else {
              await s.report.clickVisual(v);
            }
          });
          await sleep(1200);
          const outcome = {};
          await both(async (s) => {
            await s.report.waitStable();
            const idx = await s.report.currentPageIndex();
            outcome[s.name] = {
              navigated: idx !== before[s.name],
              page: s.report.pages[idx]?.name ?? null,
              popups: await s.report.closePopups(),
            };
          });
          const cap = await capturePage();
          const res = pageVerdict(cap, { outcome });
          if (Object.values(outcome).some((o) => o.navigated || o.popups.length)) {
            if (res.status === 'warn') res.status = 'pass';
            delete res.details.note;
          }
          if (compare) {
            const oa = outcome.A, ob = outcome.B;
            const pageA = oa.navigated ? (oa.page || '').toLowerCase() : null;
            const pageB = ob.navigated ? (ob.page || '').toLowerCase() : null;
            if (pageA !== pageB || !!oa.popups.length !== !!ob.popups.length) {
              res.status = 'fail';
              res.details.note = `Button behaviour differs: A → ${describeOutcome(oa)}, B → ${describeOutcome(ob)}`;
            }
          }
          return res;
        });
      }
    }
  }
  frac(0.35);

  // Slicers ---------------------------------------------------------------
  if (cfg.scenarios.slicers && cfg.limits.slicerValues > 0) {
    const slicers = pairsWhere((v) => !!v.slicer || isType(v, 'slicer'));
    for (const p0 of slicers) {
      if (p0.a.slicer?.hasRange) {
        await ctx.record({ page: pageName, scenario: 'slicer', target: p0.key, title: `${visualLabel(p0.a)} (range)`, status: 'skipped', details: { note: 'Range/date slicers are captured in page & visual checks; value selection is not automated' } });
        continue;
      }
      let labels = [];
      try {
        labels = (await S.A.report.slicerItems(p0.a)).labels;
      } catch (e) {
        log('warn', `Could not open slicer ${visualLabel(p0.a)}: ${e.message.split('\n')[0]}`);
        await ctx.record({ page: pageName, scenario: 'slicer', target: p0.key, title: `${visualLabel(p0.a)}`, status: 'skipped', details: { note: `The slicer's list could not be opened (${e.message.split('\n')[0].slice(0, 120)}); its values were not tested` } });
        await S.A.report.dismissOverlays();
        continue;
      } finally {
        await S.A.report.page.keyboard.press('Escape').catch(() => {});
        await sleep(300);
      }
      const candidates = labels.filter((l) => l && !/^(select all|all)$/i.test(l));
      const picks = spread(candidates, cfg.limits.slicerValues);
      if (!picks.length) {
        await ctx.record({ page: pageName, scenario: 'slicer', target: p0.key, title: visualLabel(p0.a), status: 'skipped', details: { note: 'No selectable values found' } });
        continue;
      }
      for (const label of picks) {
        await scenario({ scenario: 'slicer', target: `${p0.key}=${label}`, title: `${visualLabel(p0.a)} = "${label}"` }, async () => {
          const p = state.byKey.get(p0.key);
          if (!p) return { status: 'skipped', details: { note: 'Slicer no longer present after reset' } };
          const found = {};
          await both(async (s) => { found[s.name] = await s.report.selectSlicerItem(s.name === 'A' ? p.a : p.b, label); });
          if (!found.A) throw new Error(`Value "${label}" not found in slicer (A)`);
          const cap = await capturePage();
          const res = pageVerdict(cap, { value: label, valueFound: found });
          if (compare && !found.B) { res.status = 'fail'; res.details.note = `Value "${label}" is not available in report B's slicer`; }
          return res;
        }, { undo: (s) => { const p = state.byKey.get(p0.key); return p ? s.report.clearSlicer(s.name === 'A' ? p.a : p.b) : null; } });
      }
    }
  }
  frac(0.55);

  // Hierarchy drill -------------------------------------------------------
  // Follows each drill path down cfg.limits.drillDepth levels (e.g. Year →
  // Quarter → Month), on up to cfg.limits.drillPoints data points per visual,
  // comparing the visual at every level. The deepest level reached in A and B
  // must match too.
  if (cfg.scenarios.drill && cfg.limits.drillPerPage > 0) {
    const depth = cfg.limits.drillDepth;
    const charts = pairsWhere((v) => isChart(v) || isType(v, 'matrix')).slice(0, cfg.limits.drillPerPage);
    for (const p0 of charts) {
      const ops = [];
      const hdr = await S.A.report.headerButtons(p0.a).catch(() => ({}));
      if (hdr.expandAll && !hdr.expandAll.disabled) ops.push({ kind: 'expandAll', label: hdr.expandAll.label || 'Expand all down one level' });
      if (hdr.nextLevel && !hdr.nextLevel.disabled) ops.push({ kind: 'nextLevel', label: hdr.nextLevel.label || 'Go to the next level' });
      if (isChart(p0.a)) {
        const pts = await S.A.report.dataPoints(p0.a, 50);
        if (pts[0]) {
          const menu = await S.A.report.contextMenuAt(pts[0].x, pts[0].y).catch(() => []);
          await S.A.report.page.keyboard.press('Escape').catch(() => {});
          const dd = menu.find((m) => new RegExp(sel.contextMenuLabels.drillDown, 'i').test(m.label) && !m.disabled);
          if (dd) {
            for (const [i, pt] of spread(pts, cfg.limits.drillPoints).entries()) {
              ops.push({ kind: 'drillDown', point: pt.label, first: i === 0, label: `Drill down on "${pt.label}"` });
            }
          }
          const ex = menu.find((m) => new RegExp(sel.contextMenuLabels.expandNext, 'i').test(m.label) && !m.disabled);
          if (ex && !ops.some((o) => o.kind === 'expandAll' || o.kind === 'nextLevel')) ops.push({ kind: 'ctxExpand', label: ex.label });
        }
      }
      if (!ops.length && isChart(p0.a) && hdr.drillMode && !hdr.drillMode.disabled) ops.push({ kind: 'drillMode', label: 'Drill mode + click first data point' });
      await S.A.report.parkMouse();
      const undo = async (s) => {
        const p = state.byKey.get(p0.key);
        const v = p && (s.name === 'A' ? p.a : p.b);
        if (!v) return;
        for (let i = 0; i < depth + 1; i++) if (!(await s.report.clickHeader(v, 'drillUp').catch(() => false))) break; else await s.report.waitStable({ timeout: 10000 });
        await s.report.clickHeader(v, 'drillMode').catch(() => {});
      };
      for (const op of ops) {
        const path = [];
        let go = true;
        for (let level = 1; level <= depth && go; level++) {
          go = false;
          const baseTarget = `${p0.key}:${op.kind}${op.kind === 'drillDown' && !op.first ? `@${op.point}` : ''}`;
          const meta = {
            scenario: 'drill',
            target: level === 1 ? baseTarget : `${baseTarget}>L${level}`,
            title: level === 1 ? `${op.label} · ${visualLabel(p0.a)}` : `${op.label} (level ${level}) · ${visualLabel(p0.a)}`,
          };
          await scenario(meta, async () => {
            const p = state.byKey.get(p0.key);
            if (!p) return { status: 'skipped', details: { note: 'Visual no longer present' } };
            const ok = {}, point = {};
            await both(async (s) => {
              const v = s.name === 'A' ? p.a : p.b;
              const r = await performDrill(s.report, v, op, sel, { level, point: level === 1 ? op.point : null });
              ok[s.name] = r.ok;
              point[s.name] = r.point;
            });
            if (!ok.A && !ok.B) {
              if (level === 1) throw new Error(`Drill control "${op.label}" could not be executed on A`);
              return null; // bottom of the hierarchy in both reports: path complete
            }
            if (!ok.A) {
              return { status: 'fail', details: { level, executed: ok, note: `B can drill one level deeper than A (level ${level})` } };
            }
            const res = await visualAfterAction(both, p, op, ok);
            res.details.level = level;
            // Name the member drilled into at each deeper level, e.g. Drill down on "2025" › "Q3" › "Aug" (level 3).
            if (level > 1) {
              const trail = [...path, point.A].filter(Boolean);
              res.title = `${op.label}${trail.length ? ` › ${trail.map((x) => `"${x}"`).join(' › ')}` : ''} (level ${level}) · ${visualLabel(p0.a)}`;
            }
            if (!ok.B && compare) res.details.note = level === 1 ? res.details.note : `Level ${level} exists only in A: B's hierarchy ends earlier`;
            if (ok.B || !compare) { go = true; if (level > 1 && point.A) path.push(point.A); }
            return res;
          }, { undo, restore: false });
        }
        await restoreAll(undo);
      }
    }
  }

  // Drill-through ---------------------------------------------------------
  // Right-click a data point → Drill through → each target page; compares the
  // page each report lands on (data and screenshot).
  if (cfg.scenarios.drillThrough && cfg.limits.drillThroughPerPage > 0) {
    const targets = [];
    for (const p0 of pairsWhere(isChart).slice(0, cfg.limits.drillPerPage)) {
      if (targets.length >= cfg.limits.drillThroughPerPage) break;
      const pts = await S.A.report.dataPoints(p0.a, 1);
      if (!pts[0]) continue;
      await S.A.report.contextMenuAt(pts[0].x, pts[0].y).catch(() => []);
      const sub = await S.A.report.openSubmenu(sel.contextMenuLabels.drillThrough).catch(() => null);
      await S.A.report.page.keyboard.press('Escape').catch(() => {});
      await S.A.report.page.keyboard.press('Escape').catch(() => {});
      for (const it of (sub || []).filter((x) => !x.disabled && x.label)) {
        if (targets.length < cfg.limits.drillThroughPerPage) targets.push({ p0, point: pts[0].label, page: it.label });
      }
    }
    await S.A.report.parkMouse();
    for (const t of targets) {
      const undo = (s) => s.report.gotoPage(ref[s.name], { force: true });
      await scenario({ scenario: 'drill_through', target: `${t.p0.key}:dt:${t.page}`, title: `Drill through "${t.point}" → "${t.page}" · ${visualLabel(t.p0.a)}` }, async () => {
        const p = state.byKey.get(t.p0.key);
        if (!p) return { status: 'skipped', details: { note: 'Visual no longer present' } };
        const ok = {};
        await both(async (s) => {
          const v = s.name === 'A' ? p.a : p.b;
          const pts = await s.report.dataPoints(v, 50);
          const pt = pts.find((x) => x.label === t.point) || pts[0];
          if (!pt) { ok[s.name] = false; return; }
          await s.report.contextMenuAt(pt.x, pt.y);
          const sub = await s.report.openSubmenu(sel.contextMenuLabels.drillThrough);
          ok[s.name] = !!(sub && sub.some((x) => x.label === t.page) && await s.report.clickMenuItem(`^${escapeRe(t.page)}$`));
          if (!ok[s.name]) await s.report.page.keyboard.press('Escape').catch(() => {});
        });
        if (!ok.A) throw new Error(`Drill-through to "${t.page}" could not be executed on A`);
        await sleep(1200);
        const cap = await capturePage();
        const res = pageVerdict(cap, { executed: ok, targetPage: t.page, dataPoint: t.point });
        if (compare && !ok.B) { res.status = 'fail'; res.details.note = `Drill-through target "${t.page}" is not available in B`; }
        return res;
      }, { undo });
    }
  }
  frac(0.7);

  // Matrix hierarchy (+/-) ------------------------------------------------
  if (cfg.scenarios.matrixExpand) {
    for (const p0 of pairsWhere((v) => isType(v, 'matrix') && v.expanders > 0)) {
      await scenario({ scenario: 'matrix_expand', target: p0.key, title: `Expand ${cfg.limits.matrixExpandRows} row group(s) · ${visualLabel(p0.a)}` }, async () => {
        const p = state.byKey.get(p0.key);
        if (!p) return { status: 'skipped', details: { note: 'Visual no longer present' } };
        const ok = {};
        await both(async (s) => { ok[s.name] = (await s.report.expandMatrixRows(s.name === 'A' ? p.a : p.b, cfg.limits.matrixExpandRows)) > 0; });
        if (!ok.A) throw new Error('No expandable rows found on A');
        return visualAfterAction(both, p, { kind: 'matrix' }, ok);
      });
    }
  }
  frac(0.8);

  // Cross-filtering -------------------------------------------------------
  if (cfg.scenarios.crossFilter && cfg.limits.crossFilterPerPage > 0) {
    const charts = pairsWhere(isChart).slice(0, cfg.limits.crossFilterPerPage);
    for (const p0 of charts) {
      let pointLabel = null;
      await scenario({ scenario: 'cross_filter', target: p0.key, title: `Cross-filter from ${visualLabel(p0.a)}` }, async () => {
        const p = state.byKey.get(p0.key);
        if (!p) return { status: 'skipped', details: { note: 'Visual no longer present' } };
        const labels = {};
        await both(async (s) => {
          const pts = await s.report.dataPoints(s.name === 'A' ? p.a : p.b, 1);
          if (!pts[0]) throw new Error(`No data points in ${s.name}`);
          labels[s.name] = pts[0].label;
          await s.report.clickAt(pts[0].x, pts[0].y);
        });
        pointLabel = labels.A;
        const cap = await capturePage();
        const res = pageVerdict(cap, { dataPoint: labels });
        res.title = `Cross-filter: click "${pointLabel}" in ${visualLabel(p.a)}`;
        return res;
      }, { undo: async (s) => {
        const p = state.byKey.get(p0.key);
        const v = p && (s.name === 'A' ? p.a : p.b);
        if (!v) return;
        const pts = await s.report.dataPoints(v, 1);
        if (pts[0]) await s.report.clickAt(pts[0].x, pts[0].y);
      } });
    }
  }
  frac(0.9);

  // Tooltips --------------------------------------------------------------
  if (cfg.scenarios.tooltips && cfg.limits.tooltipsPerPage > 0) {
    const charts = pairsWhere(isChart).slice(0, cfg.limits.tooltipsPerPage);
    for (const p0 of charts) {
      await scenario({ scenario: 'tooltip', target: p0.key, title: `Tooltip · ${visualLabel(p0.a)}` }, async () => {
        const p = state.byKey.get(p0.key);
        if (!p) return null;
        const tip = {};
        await both(async (s) => {
          const pts = await s.report.dataPoints(s.name === 'A' ? p.a : p.b, 1);
          if (!pts[0]) { tip[s.name] = null; return; }
          await s.report.page.mouse.move(pts[0].x, pts[0].y, { steps: 4 });
          await sleep(1100);
          const t = await s.report.tooltip();
          tip[s.name] = t ? { lines: t.lines, shot: await s.report.screenshotBox(t.box, 4) } : null;
          await s.report.parkMouse();
        });
        if (!tip.A) return { status: 'skipped', title: `Tooltip · ${visualLabel(p.a)}`, details: { note: 'No tooltip appeared on hover in A' } };
        const res = imageResult({ a: tip.A.shot, b: tip.B?.shot, compare, cfg, details: { linesA: tip.A.lines, linesB: tip.B?.lines } });
        if (compare) {
          if (!tip.B) { res.status = 'fail'; res.details.note = 'Tooltip did not appear in B'; }
          else {
            const d = diffLines(tip.A.lines, tip.B.lines, { numericTolerance: cfg.thresholds.numericTolerance, normalize });
            res.details.data = d;
            if (!d.equal) res.status = 'diff';
          }
        }
        return res;
      }, { restore: false });
    }
  }
  if (skippedForTime) await recordTimeSkip(ctx, pageName, env, skippedForTime);
  frac(1);
  log('info', `Page "${pageName}" complete`);

  // --- helpers bound to this page --------------------------------------
  async function visualAfterAction(bothFn, p, op, ok) {
    const out = {};
    await bothFn(async (s) => {
      const v = s.name === 'A' ? p.a : p.b;
      await s.report.waitStable();
      const shot = await s.report.screenshotCanvas();
      const ex = await s.report.extract({ onlyIndex: v.domIndex });
      const nv = ex.visuals[0] || v;
      out[s.name] = { crop: cropBuffer(shot, nv.box), v: nv, changed: quickRatio(shot, base[s.name], cfg.thresholds.pixelThreshold) > CHANGE_EPS };
    });
    const res = imageResult({ a: out.A.crop, b: out.B?.crop, compare, cfg, details: { executed: ok, changed: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.changed])) } });
    if (compare) {
      const d = diffLines(visualDataLines(out.A.v), visualDataLines(out.B.v), { numericTolerance: cfg.thresholds.numericTolerance, normalize });
      res.details.data = d;
      if (!d.equal) res.status = 'diff';
      if (!ok.B) { res.status = 'fail'; res.details.note = `Control not available in B (${op.kind})`; }
    } else {
      res.details.lines = visualDataLines(out.A.v).slice(0, 200);
    }
    if (!out.A.changed && (!out.B || !out.B.changed)) {
      if (res.status === 'pass') res.status = 'warn';
      res.details.note = res.details.note || 'Action produced no visible change';
    }
    return res;
  }
}

/** One "skipped" check per page whose interactions didn't fit in the run's time budget. */
async function recordTimeSkip(ctx, pageName, env, count = null) {
  const mins = env.cfg.timing.budgetMinutes;
  await ctx.record({
    page: pageName, scenario: 'budget', target: 'interactions',
    title: count ? `${count} interaction check(s) not run: ${mins}-minute time budget reached` : `Interactions not tested: ${mins}-minute time budget reached`,
    status: 'skipped',
    details: { note: `The run is limited to ${mins} minutes (Advanced → Time budget). Screenshots, layout and data of this page were still checked. Raise the budget, test fewer pages, or run more pages in parallel to cover these interactions.` },
  });
}

/**
 * Executes one drill step. `point` (level 1 only) picks the data point by its
 * label so A and B drill on the same member; deeper levels use the first point.
 * Returns { ok, point } where point is the label drilled on.
 */
async function performDrill(report, v, op, sel, { level = 1, point = null } = {}) {
  if (!v) return { ok: false };
  const pick = async () => {
    const pts = await report.dataPoints(v, 50);
    return (point && pts.find((p) => p.label === point)) || pts[0] || null;
  };
  switch (op.kind) {
    case 'expandAll': return { ok: await report.clickHeader(v, 'expandAll') };
    case 'nextLevel': return { ok: await report.clickHeader(v, 'nextLevel') };
    case 'drillDown':
    case 'ctxExpand': {
      const pt = await pick();
      if (!pt) return { ok: false };
      const menu = await report.contextMenuAt(pt.x, pt.y);
      const pattern = op.kind === 'drillDown' ? sel.contextMenuLabels.drillDown : sel.contextMenuLabels.expandNext;
      if (!menu.some((m) => new RegExp(pattern, 'i').test(m.label) && !m.disabled)) {
        await report.page.keyboard.press('Escape').catch(() => {});
        return { ok: false };
      }
      return { ok: !!(await report.clickMenuItem(pattern)), point: pt.label };
    }
    case 'drillMode': {
      if (level === 1) {
        if (!(await report.clickHeader(v, 'drillMode'))) return { ok: false };
        await sleep(400);
      }
      const before = await report.canvasHash().catch(() => null);
      const pt = await pick();
      if (!pt) return { ok: false };
      await report.clickAt(pt.x, pt.y);
      await report.waitStable({ timeout: 10000 }).catch(() => {});
      const after = await report.canvasHash().catch(() => null);
      return { ok: level === 1 || before !== after, point: pt.label };
    }
    default: return { ok: false };
  }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function describeOutcome(o) {
  if (o.popups.length) return `opened ${o.popups.join(', ')}`;
  if (o.navigated) return `page "${o.page}"`;
  return 'stayed on page';
}

/** Picks n values evenly spread across a list (first, ..., last). */
function spread(list, n) {
  if (list.length <= n) return list;
  if (n === 1) return [list[0]];
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

/** Builds a result with pixel comparison between two optional images. */
function imageResult({ a, b, compare, cfg, details = {}, ...rest }) {
  const res = { ...rest, status: 'pass', images: {}, details };
  if (a) res.images.a = a;
  if (b) res.images.b = b;
  if (compare && a && b) {
    const d = diffImages(a, b, { threshold: cfg.thresholds.pixelThreshold, shiftTolerancePx: cfg.thresholds.shiftTolerancePx });
    res.diffRatio = d.ratio;
    res.diffPixels = d.diffPixels;
    res.details.pixel = { ratio: d.ratio, diffPixels: d.diffPixels, regions: d.regions.length, sizeA: d.sizeA, sizeB: d.sizeB, sizeMismatch: d.sizeMismatch };
    if (d.diffPixels > 0) { res.images.diff = d.diffPng; res.images.annotated = d.annotatedPng; }
    const sizeDelta = Math.max(Math.abs(d.sizeA.w - d.sizeB.w), Math.abs(d.sizeA.h - d.sizeB.h));
    if (d.ratio > cfg.thresholds.maxDiffRatio || sizeDelta > cfg.thresholds.positionTolerancePx) res.status = 'diff';
  } else if (compare && a && !b) {
    res.status = 'missing';
    res.details.missingIn = 'B';
  }
  return res;
}

export { ReportError };
