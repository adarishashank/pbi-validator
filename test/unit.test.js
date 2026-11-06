import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { diffImages, diffLines, makeNormalizer, cropBuffer } from '../src/engine/compare.js';
import { matchPages, matchVisuals, structuralDiff } from '../src/engine/matcher.js';
import { parseSuiteConfig, anyMatch } from '../src/engine/options.js';

function img(w, h, paint) {
  const p = new PNG({ width: w, height: h });
  p.data.fill(255);
  paint?.((x, y, c = [0, 0, 0]) => { const i = (y * w + x) * 4; p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; });
  return PNG.sync.write(p);
}
const rect = (x0, y0, w, h) => (set) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y); };

test('identical images have no diff', () => {
  const a = img(100, 60, rect(10, 10, 20, 20));
  const d = diffImages(a, a);
  assert.equal(d.diffPixels, 0);
  assert.equal(d.regions.length, 0);
});

test('1px layout jitter is tolerated, real changes are not', () => {
  const a = img(100, 60, rect(10, 10, 20, 20));
  const shifted = img(100, 60, rect(11, 10, 20, 20));
  assert.equal(diffImages(a, shifted).diffPixels, 0, 'sub-pixel shift should be ignored');
  assert.ok(diffImages(a, shifted, { shiftTolerancePx: 0 }).diffPixels > 0, 'strict mode sees shift');
  const changed = img(100, 60, (set) => { rect(10, 10, 20, 20)(set); rect(60, 30, 8, 8)(set); });
  const d = diffImages(a, changed);
  assert.equal(d.diffPixels, 64);
  assert.equal(d.regions.length, 1);
  assert.ok(d.regions[0].x <= 60 && d.regions[0].x + d.regions[0].w >= 68);
});

test('size mismatch is padded and reported', () => {
  const d = diffImages(img(50, 50), img(60, 50, rect(52, 0, 8, 50)));
  assert.equal(d.sizeMismatch, true);
  assert.ok(d.diffPixels > 0);
});

test('cropBuffer clamps to bounds', () => {
  const c = cropBuffer(img(50, 50), { x: 40, y: 40, w: 30, h: 30 });
  const p = PNG.sync.read(c);
  assert.deepEqual([p.width, p.height], [10, 10]);
});

test('diffLines finds changes and honours numeric tolerance + ignore patterns', () => {
  const d = diffLines(['Sales', '1,000', 'North'], ['Sales', '1,001', 'North']);
  assert.equal(d.equal, false);
  assert.ok(d.ops.some((o) => o.op === 'chg' && o.a === '1,000' && o.b === '1,001'));
  assert.equal(diffLines(['1,000'], ['1,001'], { numericTolerance: 0.01 }).equal, true);
  const norm = makeNormalizer(['Last refreshed: .*']);
  assert.equal(diffLines(['Last refreshed: 1/1/2026'], ['Last refreshed: 2/2/2026'], { normalize: norm }).equal, true);
});

test('page matching: by name, then renamed by position, then orphans', () => {
  const A = ['Overview', 'Details', 'Trends', 'Archive'].map((name, index) => ({ name, index }));
  const B = ['Overview', 'Details', 'Trend Analysis'].map((name, index) => ({ name, index }));
  const m = matchPages(A, B);
  assert.equal(m.pairs.length, 3);
  assert.deepEqual(m.pairs.find((p) => p.how === 'position') && [m.pairs[2].a.name, m.pairs[2].b.name], ['Trends', 'Trend Analysis']);
  assert.deepEqual(m.onlyA.map((p) => p.name), ['Archive']);
});

test('visual matching and structural diff', () => {
  const v = (type, title, x, y, w = 100, h = 50) => ({ type, title, box: { x, y, w, h }, lines: [] });
  const A = [v('card', 'Total', 0, 0), v('chart', 'Sales', 200, 0), v('textbox', '', 0, 100)];
  const B = [v('card', 'Total', 0, 0), v('chart', 'Sales', 230, 0), v('card', 'New', 0, 300)];
  const m = matchVisuals(A, B);
  assert.equal(m.pairs.length, 2);
  const issues = structuralDiff(m, { positionTolerancePx: 4 });
  const kinds = issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['extra_in_b', 'missing_in_b', 'moved']);
});

test('suite config defaults and pattern matching', () => {
  const c = parseSuiteConfig({ limits: { slicerValues: 5 } });
  assert.equal(c.limits.slicerValues, 5);
  assert.equal(c.thresholds.maxDiffRatio, 0.002);
  assert.ok(anyMatch(['/^Sales/i'], 'sales by region'));
  assert.ok(anyMatch(['Overview'], ' overview '));
  assert.throws(() => parseSuiteConfig({ viewport: { width: 10 } }));
});
