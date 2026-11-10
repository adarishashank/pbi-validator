import fs from 'node:fs';
import { PNG } from 'pngjs';

export const THUMB_WIDTH = 360;

/** `0007-a.png` -> `0007-a.thumb.png` */
export const thumbName = (file) => file.replace(/\.png$/i, '.thumb.png');

/**
 * Box (area-average) downscale of a PNG buffer to at most `maxW` px wide, aspect ratio kept, never
 * upscaled. An image that is already small enough comes back unchanged (a copy).
 */
export function makeThumbnail(buf, maxW = THUMB_WIDTH) {
  const src = PNG.sync.read(buf);
  if (src.width <= maxW) return Buffer.from(buf);
  const W = maxW, H = Math.max(1, Math.round(src.height * (maxW / src.width)));
  const out = new PNG({ width: W, height: H });
  const sx = src.width / W, sy = src.height / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3]; n++;
        }
      }
      const o = (y * W + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = a / n;
    }
  }
  return PNG.sync.write(out);
}

/** Writes the thumbnail next to `file`. Resolves true on success; never throws. */
export async function writeThumbnail(file, buf, log = () => {}) {
  try {
    await fs.promises.writeFile(thumbName(file), makeThumbnail(buf));
    return true;
  } catch (e) {
    log(`thumbnail for ${file} failed: ${e.message}`);
    return false;
  }
}
