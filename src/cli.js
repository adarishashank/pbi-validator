#!/usr/bin/env node
/**
 * CLI for CI/CD pipelines and headless servers.
 *
 *   node src/cli.js list
 *   node src/cli.js run "<suite name|id>" [--junit out.xml] [--html out.zip] [--json out.json] [--fail-on diffs|failed|never]
 *   node src/cli.js login "<profile name>" [--url https://app.powerbi.com/home]
 *   node src/cli.js check "<profile name>"
 *   node src/cli.js create-admin <email> [--name "Full Name"]   (prints a one-time password)
 *   node src/cli.js reset-password <email>                      (prints a one-time password)
 *   node src/cli.js users
 *
 * Exit codes: 0 = passed, 1 = differences/failures (per --fail-on), 2 = run error.
 */
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { q, insert } from './db.js';
import { runQueue, bus } from './jobs/queue.js';
import { loadRunBundle, junitXml, streamHtmlZip } from './jobs/export.js';
import { interactiveLogin, checkProfile } from './auth/profiles.js';
import { findUserByEmail, createUser, updateUser, revokeUserSessions, audit } from './auth/users.js';
import { hashPassword, generatePassword } from './auth/passwords.js';

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
    case 'create-admin': {
      const email = String(target || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Usage: create-admin you@company.com [--name "Full Name"]'); return 2; }
      const temp = generatePassword();
      const existing = findUserByEmail(email);
      if (existing) {
        updateUser(existing.id, { role: 'admin', disabled: 0, password_hash: await hashPassword(temp), must_change_password: 1 });
        revokeUserSessions(existing.id);
        console.log(`${email} already existed: promoted to admin and given a new one-time password.`);
      } else {
        createUser({ email, name: flag('name') || '', role: 'admin', passwordHash: await hashPassword(temp), mustChange: true });
        console.log(`Administrator ${email} created.`);
      }
      audit('cli', 'cli.create_admin', { target: email });
      console.log(`One-time password: ${temp}\nSign in with it; you'll be asked to choose a new password.`);
      return 0;
    }
    case 'reset-password': {
      const user = findUserByEmail(target);
      if (!user) { console.error(`No user ${target}`); return 2; }
      const temp = generatePassword();
      updateUser(user.id, { password_hash: await hashPassword(temp), must_change_password: 1, disabled: 0 });
      revokeUserSessions(user.id);
      audit('cli', 'cli.reset_password', { target: user.email });
      console.log(`One-time password for ${user.email}: ${temp}`);
      return 0;
    }
    case 'users': {
      for (const u of q.all('SELECT id, email, name, role, provider, disabled, last_login_at FROM users ORDER BY email')) {
        console.log(`#${u.id}\t${u.role.padEnd(6)}\t${u.provider.padEnd(9)}\t${u.disabled ? 'DISABLED\t' : ''}${u.email}${u.name ? ` (${u.name})` : ''}`);
      }
      return 0;
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
