import { z } from 'zod';

/**
 * Suite configuration. Every field has a production-sensible default so a
 * suite can be created with `{}` and tuned later from the UI.
 */
export const SuiteConfigSchema = z.object({
  viewport: z.object({
    width: z.number().int().min(800).max(3840).default(1920),
    height: z.number().int().min(600).max(2160).default(1080),
  }).prefault({}),
  locale: z.string().default('en-US'),
  timezone: z.string().default('UTC'),
  pages: z.object({
    // Page names or /regex/ strings. Empty include = all pages.
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
  }).prefault({}),
  scenarios: z.object({
    pageRender: z.boolean().default(true),     // full page screenshot diff + health
    structure: z.boolean().default(true),      // visual inventory, type, title, layout
    visuals: z.boolean().default(true),        // per-visual screenshot + data diff
    buttons: z.boolean().default(true),        // action buttons / navigators / bookmarks
    slicers: z.boolean().default(true),        // apply slicer values, compare whole page
    drill: z.boolean().default(true),          // hierarchy drill down / expand next level
    drillThrough: z.boolean().default(true),   // right-click → Drill through → target page
    matrixExpand: z.boolean().default(true),   // matrix +/- row hierarchy expansion
    crossFilter: z.boolean().default(true),    // click data points, compare cross-filtering
    tooltips: z.boolean().default(true),       // hover data points, compare tooltip content
    model: z.boolean().default(true),          // compare the data model: tables, columns, measures (DAX), relationships, roles
    queryData: z.boolean().default(true),      // compare the data Power BI downloads for each visual (all rows, full precision)
    // Before comparing a page, set B's slicers to the values selected in A, so values are compared
    // on the same parameters. A different default selection is reported on its own.
    alignSelections: z.boolean().default(true),
  }).prefault({}),
  limits: z.object({
    slicerValues: z.number().int().min(0).max(20).default(2),
    buttonsPerPage: z.number().int().min(0).max(100).default(25),
    drillPerPage: z.number().int().min(0).max(50).default(10),      // visuals per page drilled
    drillDepth: z.number().int().min(1).max(5).default(2),           // hierarchy levels followed down (Year → Quarter → Month …)
    drillPoints: z.number().int().min(1).max(5).default(1),          // data points drilled per visual (first, …, last)
    drillThroughPerPage: z.number().int().min(0).max(20).default(3), // drill-through targets tried per page
    crossFilterPerPage: z.number().int().min(0).max(50).default(4),
    tooltipsPerPage: z.number().int().min(0).max(50).default(4),
    matrixExpandRows: z.number().int().min(1).max(20).default(3),
    maxVisualsPerPage: z.number().int().min(1).max(500).default(150),
    // Pages tested at the same time (each needs its own browser tabs). 0 = server default (PARALLEL_PAGES).
    parallelPages: z.number().int().min(0).max(8).default(0),
  }).prefault({}),
  thresholds: z.object({
    pixelThreshold: z.number().min(0).max(1).default(0.1),     // pixelmatch per-pixel colour tolerance
    maxDiffRatio: z.number().min(0).max(1).default(0.002),     // fraction of differing pixels tolerated
    positionTolerancePx: z.number().min(0).max(200).default(4),
    numericTolerance: z.number().min(0).default(0),            // relative tolerance for numbers in data
    shiftTolerancePx: z.number().int().min(0).max(3).default(1), // ignore sub-pixel layout jitter
    // Still screenshots: this many differing pixels in one connected area is a difference,
    // however small a share of the image it is (one changed digit or marker). 0 = off.
    minRegionPixels: z.number().int().min(0).max(100000).default(40),
  }).prefault({}),
  ignore: z.object({
    visualTypes: z.array(z.string()).default(['shape', 'image', 'basicShape']),
    visualTitles: z.array(z.string()).default([]),             // names or /regex/
    textPatterns: z.array(z.string()).default([]),             // regex stripped from extracted text
    maskSelectors: z.array(z.string()).default([]),            // CSS selectors masked in screenshots
  }).prefault({}),
  timing: z.object({
    loadTimeoutMs: z.number().int().min(10000).max(600000).default(120000),
    // Target run time. Every page always gets its screenshot, layout and data
    // checks; interactions (buttons, slicers, drills…) use the remaining time
    // and are reported as skipped when it runs out. 0 = no limit.
    budgetMinutes: z.number().min(0).max(600).default(15),
    stableTimeoutMs: z.number().int().min(2000).max(300000).default(45000),
    settleMs: z.number().int().min(0).max(30000).default(700),
    actionTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  }).prefault({}),
  ai: z.object({
    enabled: z.boolean().default(true),        // AI summary, triage & anomaly analysis after each run
    vision: z.boolean().default(true),         // send diff screenshots to the vision model
    maxVisionItems: z.number().int().min(0).max(50).default(8),
  }).prefault({}),
  // Fixed slicer selections applied to both reports before comparing, e.g.
  // { slicer: 'Region', values: ['South'] }. slicer/page: exact name or /regex/; page empty = every page.
  parameters: z.array(z.object({
    slicer: z.string().min(1),
    values: z.array(z.string()).default([]),
    page: z.string().default(''),
  })).max(50).default([]),
  resetToDefaultOnLoad: z.boolean().default(true),
  retries: z.number().int().min(0).max(3).default(1),
  selectors: z.record(z.string(), z.any()).default({}),
});

export function parseSuiteConfig(raw) {
  return SuiteConfigSchema.parse(raw ?? {});
}

export const DEFAULT_SUITE_CONFIG = parseSuiteConfig({});

/** Turns "Sales" / "/^Sales.*$/i" into a matcher. */
export function toMatcher(pattern) {
  const m = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (m) {
    const re = new RegExp(m[1], m[2]);
    return (s) => re.test(s ?? '');
  }
  const needle = pattern.trim().toLowerCase();
  return (s) => (s ?? '').trim().toLowerCase() === needle;
}

export function anyMatch(patterns, value) {
  return patterns.some((p) => toMatcher(p)(value));
}
