#!/usr/bin/env node
// Builds the static site that Cloudflare serves from its edge: a copy of public/
// plus /vendor/*.mjs, produced exactly as src/server.js serves them at runtime
// (bare "preact" imports rewritten so no import map is needed).
//   node scripts/build-static.mjs [outDir]     (default deploy/cloudflare/.static)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'deploy/cloudflare/.static'));
if (out === ROOT || !out.startsWith(ROOT + path.sep)) throw new Error(`Refusing to write outside the repository: ${out}`);

// Keep in sync with the `vendor` table in src/server.js.
const vendor = {
  'preact.mjs': 'node_modules/preact/dist/preact.mjs',
  'hooks.mjs': 'node_modules/preact/hooks/dist/hooks.mjs',
  'htm.mjs': 'node_modules/htm/dist/htm.mjs',
};

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), out, { recursive: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
for (const [name, rel] of Object.entries(vendor)) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`Missing ${rel}: run "npm ci" in the repository root first`);
  fs.writeFileSync(path.join(out, 'vendor', name), fs.readFileSync(src, 'utf8').replace(/from\s*["']preact["']/g, 'from"/vendor/preact.mjs"'));
}
if (!fs.existsSync(path.join(out, 'index.html'))) throw new Error('public/index.html is missing');
console.log(`Static site built in ${path.relative(ROOT, out)}`);
