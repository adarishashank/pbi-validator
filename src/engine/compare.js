import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export const decode = (buf) => PNG.sync.read(buf);
export const encode = (png) => PNG.sync.write(png);

function blank(w, h, rgba = [255, 255, 255, 255]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) png.data.set(rgba, i);
  return png;
}

export function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = blank(w, h, [255, 255, 255, 255]);
  PNG.bitblt(png, out, 0, 0, Math.min(png.width, w), Math.min(png.height, h), 0, 0);
  return out;
}

/** Crops a PNG buffer to box {x,y,w,h}; clamps to bounds. Returns Buffer|null. */
export function cropBuffer(buf, box, pad = 0) {
  const png = decode(buf);
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const w = Math.min(png.width - x, Math.ceil(box.w + pad * 2));
  const h = Math.min(png.height - y, Math.ceil(box.h + pad * 2));
  if (w < 2 || h < 2) return null;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x, y, w, h, 0, 0);
  return encode(out);
}

function strokeRect(png, x, y, w, h, color = [230, 0, 60, 255], t = 3) {
  const set = (px, py) => {
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) return;
    png.data.set(color, (py * png.width + px) * 4);
  };
  for (let k = 0; k < t; k++) {
    for (let i = x; i < x + w; i++) { set(i, y + k); set(i, y + h - 1 - k); }
    for (let j = y; j < y + h; j++) { set(x + k, j); set(x + w - 1 - k, j); }
  }
}

/** Groups differing pixels into rectangular regions (coarse grid + flood fill). */
function findRegions(diffPng, cell = 12, maxRegions = 60) {
  const { width: W, height: H, data } = diffPng;
  const cw = Math.ceil(W / cell), ch = Math.ceil(H / cell);
  const grid = new Uint8Array(cw * ch);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0) grid[Math.floor(y / cell) * cw + Math.floor(x / cell)] = 1;
    }
  }
  const seen = new Uint8Array(cw * ch);
  let regions = [];
  for (let gy = 0; gy < ch; gy++) {
    for (let gx = 0; gx < cw; gx++) {
      const start = gy * cw + gx;
      if (!grid[start] || seen[start]) continue;
      let x1 = gx, y1 = gy, x2 = gx, y2 = gy;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const c = stack.pop();
        const cx = c % cw, cy = (c - cx) / cw;
        x1 = Math.min(x1, cx); y1 = Math.min(y1, cy); x2 = Math.max(x2, cx); y2 = Math.max(y2, cy);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
            const n = ny * cw + nx;
            if (grid[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
          }
        }
      }
      regions.push({ x: x1 * cell, y: y1 * cell, w: (x2 - x1 + 1) * cell, h: (y2 - y1 + 1) * cell });
    }
  }
  // Merge overlapping / near regions.
  let merged = true;
  const near = (a, b, m = 8) => a.x - m < b.x + b.w && b.x - m < a.x + a.w && a.y - m < b.y + b.h && b.y - m < a.y + a.h;
  while (merged && regions.length > 1) {
    merged = false;
    outer: for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        if (near(regions[i], regions[j])) {
          const a = regions[i], b = regions[j];
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          regions[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          regions.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  regions.sort((a, b) => b.w * b.h - a.w * a.h);
  if (regions.length > maxRegions) regions = regions.slice(0, maxRegions);
  return regions.map((r) => ({ x: r.x, y: r.y, w: Math.min(r.w, W - r.x), h: Math.min(r.h, H - r.y) }));
}

/**
 * Pixel-compares two PNG buffers. Images of different size are padded so the
 * size mismatch itself shows up as a difference.
 */
// YIQ colour distance (same metric pixelmatch uses), for opaque screenshots.
function yiqDelta(d1, i, d2, j) {
  const r = d1[i] - d2[j], g = d1[i + 1] - d2[j + 1], b = d1[i + 2] - d2[j + 2];
  const y = r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
  const iq = r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
  const q = r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

/** True if pixel (x,y) of `src` exists in `dst` within ±r px (sub-pixel layout jitter). */
function matchesNearby(src, dst, x, y, W, H, r, maxDelta) {
  const i = (y * W + x) * 4;
  for (let dy = -r; dy <= r; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= H) continue;
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= W) continue;
      if (yiqDelta(src, i, dst, (ny * W + nx) * 4) <= maxDelta) return true;
    }
  }
  return false;
}

export function diffImages(bufA, bufB, { threshold = 0.1, shiftTolerancePx = 1 } = {}) {
  const a0 = decode(bufA), b0 = decode(bufB);
  const W = Math.max(a0.width, b0.width), H = Math.max(a0.height, b0.height);
  const a = padTo(a0, W, H), b = padTo(b0, W, H);
  const mask = new PNG({ width: W, height: H });
  pixelmatch(a.data, b.data, mask.data, W, H, {
    threshold, includeAA: false, diffMask: true, diffColor: [255, 0, 0], aaColor: [0, 0, 0],
  });
  // Build the human-facing diff: faded greyscale A, red for real differences.
  const diff = new PNG({ width: W, height: H });
  const maxDelta = 35215 * threshold * threshold;
  let diffPixels = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const isDiff = mask.data[i] === 255 && mask.data[i + 1] === 0 && mask.data[i + 3] > 0;
      let real = isDiff;
      if (isDiff && shiftTolerancePx > 0) {
        real = !(matchesNearby(a.data, b.data, x, y, W, H, shiftTolerancePx, maxDelta)
          && matchesNearby(b.data, a.data, x, y, W, H, shiftTolerancePx, maxDelta));
      }
      if (real) {
        diffPixels++;
        diff.data[i] = 255; diff.data[i + 1] = 0; diff.data[i + 2] = 0; diff.data[i + 3] = 255;
      } else {
        const l = 255 - (255 - (a.data[i] * 0.299 + a.data[i + 1] * 0.587 + a.data[i + 2] * 0.114)) * 0.15;
        diff.data[i] = diff.data[i + 1] = diff.data[i + 2] = isDiff ? Math.min(l, 235) : l;
        diff.data[i + 3] = 255;
      }
    }
  }
  const regions = diffPixels ? findRegions(diff) : [];
  const annotated = new PNG({ width: W, height: H });
  b.data.copy(annotated.data);
  for (const r of regions) strokeRect(annotated, r.x, r.y, r.w, r.h);
  return {
    diffPixels,
    ratio: diffPixels / (W * H),
    width: W,
    height: H,
    sizeA: { w: a0.width, h: a0.height },
    sizeB: { w: b0.width, h: b0.height },
    sizeMismatch: a0.width !== b0.width || a0.height !== b0.height,
    regions,
    diffPng: encode(diff),
    annotatedPng: encode(annotated),
  };
}

/** Pixel equality check without producing artifacts (used for state restore). */
export function quickRatio(bufA, bufB, threshold = 0.1) {
  const a0 = decode(bufA), b0 = decode(bufB);
  if (a0.width !== b0.width || a0.height !== b0.height) return 1;
  const raw = pixelmatch(a0.data, b0.data, null, a0.width, a0.height, { threshold, includeAA: false });
  if (!raw) return 0;
  return diffImages(bufA, bufB, { threshold }).ratio;
}

// ---------------------------------------------------------------------------
// Data / text comparison
// ---------------------------------------------------------------------------
const NUM_RE = /-?\d[\d,]*(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

export function makeNormalizer(ignorePatterns = []) {
  const res = ignorePatterns.map((p) => {
    const m = /^\/(.*)\/([a-z]*)$/.exec(p);
    return m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : new RegExp(p, 'gi');
  });
  return (line) => {
    let s = String(line ?? '');
    for (const re of res) s = s.replace(re, '');
    return s.replace(/\s+/g, ' ').trim();
  };
}

function linesEqual(a, b, tol) {
  if (a === b) return true;
  if (!tol) return false;
  const sa = a.replace(NUM_RE, '#'), sb = b.replace(NUM_RE, '#');
  if (sa !== sb) return false;
  const na = a.match(NUM_RE) || [], nb = b.match(NUM_RE) || [];
  if (na.length !== nb.length) return false;
  return na.every((x, i) => {
    const p = Number(x.replace(/,/g, '')), q = Number(nb[i].replace(/,/g, ''));
    if (!Number.isFinite(p) || !Number.isFinite(q)) return x === nb[i];
    return Math.abs(p - q) <= tol * Math.max(Math.abs(p), Math.abs(q), 1e-12);
  });
}

/** LCS line diff. Returns { equal, added, removed, ops } (ops truncated for UI). */
export function diffLines(aLines, bLines, { numericTolerance = 0, normalize = (s) => s, cap = 1500 } = {}) {
  const a = (aLines || []).map(normalize).filter(Boolean).slice(0, cap);
  const b = (bLines || []).map(normalize).filter(Boolean).slice(0, cap);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = linesEqual(a[i], b[j], numericTolerance) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n && j < m) {
    if (linesEqual(a[i], b[j], numericTolerance)) { ops.push({ op: 'eq', a: a[i], b: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'del', a: a[i] }); removed++; i++; }
    else { ops.push({ op: 'add', b: b[j] }); added++; j++; }
  }
  while (i < n) { ops.push({ op: 'del', a: a[i++] }); removed++; }
  while (j < m) { ops.push({ op: 'add', b: b[j++] }); added++; }
  // Pair adjacent del/add as "changed" for readability.
  const merged = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k], nx = ops[k + 1];
    if (o.op === 'del' && nx?.op === 'add') { merged.push({ op: 'chg', a: o.a, b: nx.b }); k++; }
    else merged.push(o);
  }
  return {
    equal: added === 0 && removed === 0,
    added,
    removed,
    totalA: n,
    totalB: m,
    ops: compactOps(merged),
  };
}

/** Keeps diffs plus 2 lines of context; collapses long equal runs. */
function compactOps(ops, ctx = 2, max = 400) {
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, i) => {
    if (o.op !== 'eq') for (let k = Math.max(0, i - ctx); k <= Math.min(ops.length - 1, i + ctx); k++) keep[k] = 1;
  });
  const out = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) { out.push({ op: 'skip', count: skipped }); skipped = 0; }
      out.push(o);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ op: 'skip', count: skipped });
  return out.slice(0, max);
}

/** Flattens a visual's extracted content into comparable lines. */
export function visualDataLines(v) {
  if (!v) return [];
  const lines = [];
  if (v.grid?.length) for (const row of v.grid) lines.push(row.join(' | '));
  else lines.push(...(v.lines || []));
  if (v.points?.length) lines.push(...v.points.map((p) => `• ${p}`));
  return lines;
}

/** Draws outlined boxes onto a PNG buffer (e.g. missing / extra visuals). */
export function annotateBoxes(buf, boxes, color = [230, 0, 60, 255]) {
  const png = decode(buf);
  for (const b of boxes) {
    const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
    const w = Math.min(png.width - x, Math.round(b.w)), h = Math.min(png.height - y, Math.round(b.h));
    if (w > 6 && h > 6) strokeRect(png, x, y, w, h, color, 4);
  }
  return encode(png);
}
