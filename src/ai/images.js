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

/**
 * Builds one image for the vision model: A (left) | B (right), cropped to
 * the area that actually differs so details stay legible after scaling.
 */
export function buildComparisonImage(fileA, fileB, { maxW = 1600, maxH = 1000, gap = 16 } = {}) {
  const bufA = fs.readFileSync(fileA), bufB = fs.readFileSync(fileB);
  let a = PNG.sync.read(bufA), b = PNG.sync.read(bufB);
  const W = Math.min(a.width, b.width), H = Math.min(a.height, b.height);
  let region = null;
  try {
    const d = diffImages(bufA, bufB);
    if (d.regions.length) {
      const x1 = Math.min(...d.regions.map((r) => r.x)), y1 = Math.min(...d.regions.map((r) => r.y));
      const x2 = Math.max(...d.regions.map((r) => r.x + r.w)), y2 = Math.max(...d.regions.map((r) => r.y + r.h));
      const pad = 60;
      const r = { x: Math.max(0, x1 - pad), y: Math.max(0, y1 - pad) };
      r.w = Math.min(W, x2 + pad) - r.x;
      r.h = Math.min(H, y2 + pad) - r.y;
      if (r.w * r.h < 0.6 * W * H && r.w > 40 && r.h > 40) region = r;
    }
  } catch { /* fall back to full images */ }
  if (region) { a = crop(a, region); b = crop(b, region); }
  const out = new PNG({ width: a.width + gap + b.width, height: Math.max(a.height, b.height) });
  out.data.fill(255);
  for (let y = 0; y < out.height; y++) {           // separator bar
    for (let x = a.width + gap / 2 - 2; x < a.width + gap / 2 + 2; x++) out.data.set([220, 38, 38, 255], (y * out.width + x) * 4);
  }
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0);
  return { png: PNG.sync.write(downscale(out, maxW, maxH)), cropped: !!region, region };
}

export function singleImage(file, { maxW = 1600, maxH = 1000 } = {}) {
  return PNG.sync.write(downscale(PNG.sync.read(fs.readFileSync(file)), maxW, maxH));
}
