import zlib from 'node:zlib';

// Minimal ZIP reader (stored + deflate), enough for .pbit files and zipped
// TMDL folders. Reads the central directory, so data descriptors are fine.

const MAX_ENTRY = 200 * 1024 * 1024;

export const isZip = (buf) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

/** Returns [{ name, read() → Buffer }]. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('Not a valid ZIP file'), { status: 400 });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(new Error('Corrupt ZIP directory'), { status: 400 });
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    out.push({
      name,
      read() {
        if (usize > MAX_ENTRY) throw Object.assign(new Error(`${name} is too large`), { status: 413 });
        const ln = buf.readUInt16LE(local + 26), lx = buf.readUInt16LE(local + 28);
        const data = buf.subarray(local + 30 + ln + lx, local + 30 + ln + lx + csize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
        throw Object.assign(new Error(`Unsupported compression in ${name}`), { status: 400 });
      },
    });
  }
  return out;
}
