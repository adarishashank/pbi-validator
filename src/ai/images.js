import fs from 'node:fs';
import { PNG } from 'pngjs';
import { diffImages } from '../engine/compare.js';

/** Box-filter downscale so screenshots fit model input limits. */
export function downscale(png, maxW, maxH) {
  const s = Math.min(1, maxW / png.width, maxH / png.height);
  if (s >= 1) return png;
  const W = Math.max(1, Math.round(png.width * s)), H = Math.max(1, Math.round(png.height * s));
  const out = new PNG({ width: W, height: H });
  const inv = 1 / s;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * inv), y1 = Math.min(png.height, Math.floor((y + 1) * inv) || y0 + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * inv), x1 = Math.min(png.width, Math.floor((x + 1) * inv) || x0 + 1);
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) {
        for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) {
          const i = (yy * png.width + xx) * 4;
          r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
        }
      }
      const o = (y * W + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
    }
  }
  return out;
}

function crop(png, r) {
  const out = new PNG({ width: r.w, height: r.h });
  PNG.bitblt(png, out, r.x, r.y, r.w, r.h, 0, 0);
  return out;
}

/** Bounding box of the real-difference pixels (pure red) in a stored diff image, or null. */
function regionFromDiffFile(diffFile) {
  const d = PNG.sync.read(fs.readFileSync(diffFile));
  let x1 = d.width, y1 = d.height, x2 = -1, y2 = -1;
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const i = (y * d.width + x) * 4;
      if (d.data[i] === 255 && d.data[i + 1] === 0 && d.data[i + 2] === 0 && d.data[i + 3] === 255) {
        if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
    }
  }
  return x2 < 0 ? null : { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

/**
 * Builds one image for the vision model: A (left) | B (right), cropped to
 * the area that actually differs so details stay legible after scaling.
 * `diffFile` (the result's stored diff image) gives the differing area without re-running the
 * full pixel diff; each side is scaled down before compositing so the big canvas is never built.
 */
export function buildComparisonImage(fileA, fileB, { maxW = 1600, maxH = 1000, gap = 16, diffFile = null } = {}) {
  const bufA = fs.readFileSync(fileA), bufB = fs.readFileSync(fileB);
  let a = PNG.sync.read(bufA), b = PNG.sync.read(bufB);
  const W = Math.min(a.width, b.width), H = Math.min(a.height, b.height);
  let region = null;
  try {
    let box = null;
    if (diffFile && fs.existsSync(diffFile)) box = regionFromDiffFile(diffFile);
    else {
      const d = diffImages(bufA, bufB);
      if (d.regions.length) {
        const x1 = Math.min(...d.regions.map((r) => r.x)), y1 = Math.min(...d.regions.map((r) => r.y));
        box = { x: x1, y: y1, w: Math.max(...d.regions.map((r) => r.x + r.w)) - x1, h: Math.max(...d.regions.map((r) => r.y + r.h)) - y1 };
      }
    }
    if (box) {
      const pad = 60;
      const r = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad) };
      r.w = Math.min(W, box.x + box.w + pad) - r.x;
      r.h = Math.min(H, box.y + box.h + pad) - r.y;
      if (r.w * r.h < 0.6 * W * H && r.w > 40 && r.h > 40) region = r;
    }
  } catch { /* fall back to full images */ }
  if (region) { a = crop(a, region); b = crop(b, region); }
  // Scale each side so the composite fits maxW x maxH, instead of scaling the finished canvas.
  const s = Math.min(1, maxW / (a.width + gap + b.width), maxH / Math.max(a.height, b.height));
  if (s < 1) {
    a = downscale(a, Math.max(1, Math.round(a.width * s)), Math.max(1, Math.round(a.height * s)));
    b = downscale(b, Math.max(1, Math.round(b.width * s)), Math.max(1, Math.round(b.height * s)));
  }
  const out = new PNG({ width: a.width + gap + b.width, height: Math.max(a.height, b.height) });
  out.data.fill(255);
  for (let y = 0; y < out.height; y++) {           // separator bar
    for (let x = a.width + gap / 2 - 2; x < a.width + gap / 2 + 2; x++) out.data.set([220, 38, 38, 255], (y * out.width + x) * 4);
  }
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0);
  return { png: PNG.sync.write(out), cropped: !!region, region };
}

export function singleImage(file, { maxW = 1600, maxH = 1000 } = {}) {
  return PNG.sync.write(downscale(PNG.sync.read(fs.readFileSync(file)), maxW, maxH));
}
