import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt);

// scrypt (memory-hard), parameters stored with each hash so they can be raised later.
const N = 32768, R = 8, P = 1, KEYLEN = 64;
const maxmem = (n, r) => 256 * n * r;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

/** Constant-work verify: unknown users / missing hashes still cost one scrypt. */
export async function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password ?? '').normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: maxmem(Number(n), Number(r)),
  });
  return Boolean(stored) && crypto.timingSafeEqual(key, expected);
}

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', '1234567890', '12345678910', 'qwertyuiop',
  'iloveyou123', 'welcome123', 'welcome1234', 'letmein123', 'admin12345', 'administrator', 'changeme123', 'powerbi123',
  'qwerty12345', '1q2w3e4r5t', 'passw0rd123', 'p@ssw0rd123', 'p@ssword123', 'abc1234567', 'football123', 'monkey12345',
]);

/** Returns a human-readable problem, or null when the password is acceptable. */
export function passwordProblem(password, { email = '' } = {}) {
  const min = config.auth.passwordMinLength;
  if (typeof password !== 'string' || password.length < min) return `Password must be at least ${min} characters`;
  if (password.length > 200) return 'Password must be at most 200 characters';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common';
  if (/^(.)\1+$/.test(password)) return 'Password must not be a single repeated character';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'Password must not contain your email name';
  return null;
}

// No look-alike characters (0/O, 1/l/I), so a temporary password can be read out or retyped.
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * Random temporary password in four groups, e.g. "Kp7m-Wq4x-Hr9t-Bz3c"
 * (16 characters from 57 ≈ 93 bits). Users must replace it at first sign-in.
 */
export function generatePassword() {
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}
