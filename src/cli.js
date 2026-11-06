#!/usr/bin/env node
/**
 * CLI for CI/CD pipelines and headless servers.
 *
 *   node src/cli.js list
 *   node src/cli.js run "<suite name|id>" [--junit out.xml] [--html out.zip] [--json out.json] [--fail-on diffs|failed|never]
 *   node src/cli.js login "<profile name>" [--url https://app.powerbi.com/home]
 *   node src/cli.js check "<profile name>"
 *
 * Exit codes: 0 = passed, 1 = differences/failures (per --fail-on), 2 = run error.
 */
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { q, insert } from './db.js';
import { runQueue, bus } from './jobs/queue.js';
import { loadRunBundle, junitXml, streamHtmlZip } from './jobs/export.js';
import { interactiveLogin, checkProfile } from './auth/profiles.js';

const [, , cmd, target, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const findSuite = (t) => q.get('SELECT * FROM suites WHERE id = ? OR name = ?', Number(t) || -1, t);
const findProfile = (t) => q.get('SELECT * FROM auth_profiles WHERE id = ? OR name = ?', Number(t) || -1, t);

async function main() {
  switch (cmd) {
    case 'list': {
      const suites = q.all('SELECT id, name, mode, schedule FROM suites ORDER BY name');
      if (!suites.length) console.log('No suites yet — create one in the web UI.');
      for (const s of suites) console.log(`#${s.id}\t${s.mode}\t${s.name}${s.schedule ? `\t(cron ${s.schedule})` : ''}`);
      return 0;
    }
    case 'run': {
      const suite = findSuite(target);
      if (!suite) { console.error(`Suite "${target}" not found`); return 2; }
      const runId = runQueue.enqueue(suite.id, 'cli');
      bus.on(`run:${runId}`, (e) => {
        if (e.type === 'log' && e.level !== 'debug') console.log(`${e.ts.slice(11, 19)} ${e.level.padEnd(5)} ${e.message}`);
      });
      const status = await runQueue.waitFor(runId);
      const bundle = loadRunBundle(runId);
      if (flag('junit')) fs.writeFileSync(flag('junit'), junitXml(bundle));
      if (flag('json')) fs.writeFileSync(flag('json'), JSON.stringify(bundle, null, 2));
      if (flag('html')) await writeZip(bundle, flag('html'));
      console.log(`\nRun #${runId}: ${status.toUpperCase()}  ${JSON.stringify(bundle.run.summary?.byStatus || {})}`);
      const failOn = flag('fail-on') || 'diffs';
      if (status === 'error' || status === 'cancelled') return 2;
      if (failOn === 'never') return 0;
      if (status === 'failed') return 1;
      if (status === 'diffs' && failOn === 'diffs') return 1;
      return 0;
    }
    case 'login': {
      let p = findProfile(target);
      if (!p) {
        if (!target) { console.error('Usage: login "<profile name>"'); return 2; }
        const id = insert('auth_profiles', { name: target, login_url: flag('url') || '' });
        p = findProfile(String(id));
        console.log(`Created auth profile "${p.name}" (#${p.id})`);
      }
      console.log('A browser window is opening — sign in to Power BI (MFA is supported). It closes automatically once you land on Power BI.');
      await interactiveLogin(p.id);
      console.log('Session saved.');
      return 0;
    }
    case 'check': {
      const p = findProfile(target);
      if (!p) { console.error(`Profile "${target}" not found`); return 2; }
      const r = await checkProfile(p.id);
      console.log(`${p.name}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}`);
      return r.status === 'active' ? 0 : 1;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
      return cmd ? 2 : 0;
  }
}

function writeZip(bundle, file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const shim = new Writable({ write(chunk, enc, cb) { out.write(chunk, cb); }, final(cb) { out.end(cb); } });
    shim.setHeader = () => {};
    shim.on('finish', resolve).on('error', reject);
    streamHtmlZip(bundle, shim);
  });
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e.message); process.exit(2); });
