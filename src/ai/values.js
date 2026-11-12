/**
 * Value evidence for the AI analysis.
 *
 * The AI works from the values of the two reports, not from their pictures:
 * every changed value is listed with its row, its before and after, and the
 * difference worked out here (the model never does the arithmetic). A check
 * whose values are the same and only looks different is labelled as such.
 */
import { valueChanges } from '../jobs/changes.js';

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const SUFFIX = { K: 1e3, k: 1e3, M: 1e6, B: 1e9, bn: 1e9, T: 1e12 };
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const formats = new Map();
/** Number format of a locale: its decimal and grouping characters, and a pattern for one number. */
function formatOf(locale = 'en-US') {
  let f = formats.get(locale);
  if (f) return f;
  let decimal = '.', group = ',';
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
    decimal = parts.find((p) => p.type === 'decimal')?.value || '.';
    group = parts.find((p) => p.type === 'group')?.value || (decimal === ',' ? '.' : ',');
  } catch { /* unknown locale: en-US */ }
  // Narrow and non-breaking spaces as grouping are written as any space.
  const g = /\s/.test(group) ? '[\\s\\u00a0\\u202f]' : esc(group);
  const body = `\\d+(?:${g}\\d{3})*(?:${esc(decimal)}\\d+)?`;
  // A sign counts only at the start of a number, not between two (2024-01, 5-10).
  const token = `(?<![\\w.])[-+\\u2212]?[$€£¥₹]?${body}(?:\\s?(?:bn|[KkMBT])(?![A-Za-z]))?%?`;
  f = { decimal, groupRe: new RegExp(g, 'g'), token: new RegExp(token, 'g'), whole: new RegExp(`^\\(?\\s*(?:${token})\\s*\\)?$`) };
  formats.set(locale, f);
  return f;
}

/** One number as written ("1,234.5", "−12%", "$1.2M"): { value, percent } or null. */
function parseToken(tok, f) {
  let s = tok.replace(/−/g, '-').replace(/[$€£¥₹]/g, '');
  const percent = s.endsWith('%');
  if (percent) s = s.slice(0, -1);
  const suf = /(bn|[KkMBT])$/.exec(s.trim());
  if (suf) s = s.trim().slice(0, -suf[1].length);
  s = s.trim().replace(f.groupRe, '');
  if (f.decimal !== '.') s = s.replace(f.decimal, '.');
  const value = Number(s) * (suf ? SUFFIX[suf[1]] : 1);
  return Number.isFinite(value) ? { value, percent } : null;
}

/** A whole cell that is one number, "(1,234)" meaning negative. Null when it is not a number. */
export function parseNumber(text, locale = 'en-US') {
  const f = formatOf(locale);
  const s = String(text ?? '').trim();
  if (!s || !f.whole.test(s)) return null;
  const neg = s.startsWith('(') && s.endsWith(')');
  const n = parseToken(s.replace(/^\(\s*|\s*\)$/g, ''), f);
  return n && neg ? { ...n, value: -Math.abs(n.value) } : n;
}

/** Shortest text for a number without float noise ("5285", "0.0189"). */
export function fmtNum(n) {
  if (!Number.isFinite(n)) return String(n);
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e15 || a < 1e-6)) return n.toExponential(3);
  const s = Number(n.toPrecision(10));
  return Math.abs(s) >= 1000 ? s.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(Number(s.toFixed(6)));
}
const signed = (n) => `${n > 0 ? '+' : ''}${fmtNum(n)}`;
/** A percentage with its sign; tiny ones keep two significant digits instead of showing as 0. */
export const fmtPct = (p) => `${p > 0 ? '+' : ''}${Math.abs(p) >= 100 ? Math.round(p) : Math.abs(p) < 0.01 ? Number(p.toPrecision(2)) : Number(p.toFixed(Math.abs(p) < 1 ? 3 : 2))}%`;

const DATE = /\b\d{4}-\d{1,2}(-\d{1,2})?\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b\d{1,2}:\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b/i;

/** Difference between two written numbers: { delta, pct } (pct null when A is 0), with the note for a blank side. */
function numberChange(a, b, f) {
  const na = parseToken(a, f), nb = parseToken(b, f);
  if (!na || !nb) return null;
  const delta = nb.value - na.value;
  if (delta === 0) return null; // same number written differently (1,200 vs 1.2K)
  const points = na.percent && nb.percent; // two percentages differ in percentage points
  return { a: na.value, b: nb.value, delta, pct: na.value !== 0 ? (delta / Math.abs(na.value)) * 100 : null, points };
}

/**
 * The numbers that differ between two versions of one line. The lines must
 * have the same wording once numbers are taken out; otherwise it is a text
 * change (null).
 */
export function numberChanges(a, b, locale = 'en-US') {
  const f = formatOf(locale);
  // Dates and times are not amounts: a later date is a text change.
  if (DATE.test(String(a)) || DATE.test(String(b))) return null;
  const ta = String(a ?? '').match(f.token) || [], tb = String(b ?? '').match(f.token) || [];
  if (!ta.length || ta.length !== tb.length) return null;
  if (String(a).replace(f.token, '#') !== String(b).replace(f.token, '#')) return null;
  const out = [];
  ta.forEach((x, i) => {
    if (x === tb[i]) return;
    const c = numberChange(x, tb[i], f);
    if (c) out.push({ at: i, textA: x, textB: tb[i], ...c });
  });
  return out;
}

const BLANK = /^(\(blank\)|blank|null|n\/a|-|—|–)?$/i;

/**
 * One value change with what it is about and its size.
 * kind: number | text | blank (a value became blank, or the reverse) | added | removed.
 */
function describe(c, { fields, locale }) {
  if (c.op === 'add') return { kind: 'added', label: clip(c.b, 160) };
  if (c.op === 'del') return { kind: 'removed', label: clip(c.a, 160) };
  const out = [];
  const cellsA = c.a.split('|').map((x) => x.trim()), cellsB = c.b.split('|').map((x) => x.trim());
  const tabular = cellsA.length === cellsB.length && cellsA.length > 1;
  if (tabular) {
    // Columns are named when the data came with its field names (the data behind a visual).
    const named = fields?.length === cellsA.length;
    cellsA.forEach((x, i) => {
      if (x === cellsB[i]) return;
      const column = named ? fields[i] : '';
      const row = [c.key, column].filter(Boolean).join(' · ');
      if (BLANK.test(x) !== BLANK.test(cellsB[i])) { out.push({ kind: 'blank', row, a: x || '(blank)', b: cellsB[i] || '(blank)' }); return; }
      const nums = numberChanges(x, cellsB[i], locale);
      if (nums?.length) for (const n of nums) out.push({ kind: 'number', row, a: n.textA, b: n.textB, va: n.a, vb: n.b, delta: n.delta, pct: n.pct, points: n.points });
      else out.push({ kind: 'text', row, a: x, b: cellsB[i] });
    });
    return out;
  }
  const nums = numberChanges(c.a, c.b, locale);
  if (nums?.length) {
    const f = formatOf(locale);
    const row = clip(c.a.replace(f.token, '').replace(/\s+/g, ' ').replace(/^[\s:·•,.-]+|[\s:·•,.-]+$/g, ''), 80);
    for (const n of nums) out.push({ kind: 'number', row, a: n.textA, b: n.textB, va: n.a, vb: n.b, delta: n.delta, pct: n.pct, points: n.points });
  } else out.push({ kind: 'text', row: '', a: c.a, b: c.b });
  return out;
}

/**
 * What the numeric changes of one visual have in common, worked out from the
 * numbers (never guessed): the same factor, the same amount, one direction,
 * sign flips, or changes too small to see once rounded.
 */
export function patternOf(changes) {
  const nums = changes.filter((c) => c.kind === 'number');
  const notes = [];
  const count = (k) => changes.filter((c) => c.kind === k).length;
  if (nums.length) {
    const up = nums.filter((n) => n.delta > 0).length;
    if (nums.length > 1) notes.push(up === nums.length ? `${nums.length === 2 ? 'both' : `all ${nums.length}`} changed numbers went up` : up === 0 ? `${nums.length === 2 ? 'both' : `all ${nums.length}`} changed numbers went down` : `${up} went up, ${nums.length - up} went down`);
    const ratios = nums.filter((n) => n.va !== 0).map((n) => n.vb / n.va);
    let sameFactor = false;
    if (ratios.length >= 3 && ratios.length === nums.length) {
      const sorted = [...ratios].sort((x, y) => x - y), med = sorted[Math.floor(sorted.length / 2)];
      if (med !== 0 && ratios.every((r) => Math.abs(r / med - 1) < 0.005)) {
        const special = [[100, '×100 (a percentage or unit change)'], [0.01, '÷100 (a percentage or unit change)'], [1000, '×1,000 (a unit change)'], [0.001, '÷1,000 (a unit change)'], [-1, 'the sign flipped on every value']]
          .find(([r]) => Math.abs(med / r - 1) < 0.005);
        sameFactor = true;
        notes.push(special ? `every changed number moved by the same factor: ${special[1]}` : `every changed number moved by the same factor ×${Number(med.toPrecision(5))} (${fmtPct((med - 1) * 100)})`);
      }
    }
    if (nums.length >= 3 && nums.every((n) => Math.abs(n.delta - nums[0].delta) <= Math.abs(nums[0].delta) * 1e-9)) notes.push(`every changed number moved by the same amount (${signed(nums[0].delta)})`);
    const flips = nums.filter((n) => n.va !== 0 && n.vb !== 0 && Math.sign(n.va) !== Math.sign(n.vb)).length;
    if (flips && flips !== nums.length) notes.push(`${flips} value(s) changed sign`);
    const pcts = nums.map((n) => n.pct).filter((p) => p != null).map(Math.abs);
    if (pcts.length === nums.length && pcts.length) {
      const max = Math.max(...pcts), min = Math.min(...pcts);
      if (max < 0.01) notes.push('every change is below 0.01% (rounding-level)');
      else if (nums.length > 1 && !sameFactor) notes.push(`the changes are between ${fmtPct(min).replace('+', '')} and ${fmtPct(max).replace('+', '')} in size`);
    }
    const zero = nums.filter((n) => n.vb === 0).length, fromZero = nums.filter((n) => n.va === 0).length;
    if (zero) notes.push(`${zero} value(s) became 0`);
    if (fromZero) notes.push(`${fromZero} value(s) were 0 in A`);
  }
  if (count('blank')) notes.push(`${count('blank')} value(s) became blank or stopped being blank`);
  if (count('text')) notes.push(`${count('text')} text value(s) changed (labels or categories)`);
  if (count('added')) notes.push(`${count('added')} row(s) only in B`);
  if (count('removed')) notes.push(`${count('removed')} row(s) only in A`);
  return notes;
}

/** All value changes of one diff ({ ops }) as described changes. */
export function changesOf(data, opts = {}) {
  if (!data || data.equal) return [];
  const fields = opts.fields || null;
  return valueChanges(data)
    // The line naming the fields is not a row of data.
    .filter((c) => !(fields && (c.a ?? c.b) === fields.join(' | ') && c.op !== 'chg'))
    .flatMap((c) => describe(c, { fields, locale: opts.locale }));
}

function changeLine(c) {
  if (c.kind === 'added') return `only in B: ${c.label}`;
  if (c.kind === 'removed') return `only in A: ${c.label}`;
  const head = c.row ? `${clip(c.row, 90)}: ` : '';
  if (c.kind === 'number') {
    const size = c.points ? `Δ ${signed(c.delta)} percentage points` : `Δ ${signed(c.delta)}${c.pct != null ? `, ${fmtPct(c.pct)}` : ', A was 0'}`;
    return `${head}${c.a} → ${c.b} (${size})`;
  }
  return `${head}"${clip(c.a, 70)}" → "${clip(c.b, 70)}"${c.kind === 'blank' ? ' (blank on one side)' : ''}`;
}

/** Biggest changes first: rows on one side only, then by relative size. */
const weight = (c) => (c.kind === 'number' ? (c.pct == null ? 1e6 : Math.abs(c.pct)) : c.kind === 'blank' ? 1e7 : c.kind === 'text' ? 1e5 : 1e8);

function section(name, changes, max) {
  if (!changes.length) return [];
  const sorted = [...changes].sort((x, y) => weight(y) - weight(x));
  const lines = [`  ${name}: ${changes.length} change(s)`];
  for (const c of sorted.slice(0, max)) lines.push(`    ${changeLine(c)}`);
  if (sorted.length > max) lines.push(`    … ${sorted.length - max} more, smaller than the ones listed`);
  const notes = patternOf(changes);
  if (notes.length) lines.push(`    pattern: ${notes.join('; ')}`);
  return lines;
}

/**
 * What a check's verdict rests on:
 *   values     – values differ (on screen, behind the visual, or after an interaction)
 *   presence   – something exists on one side only
 *   structure  – pages, layout, data model: facts about the report, not its numbers
 *   behaviour  – an interaction did something different (destination, no effect)
 *   error      – the step could not be carried out
 *   appearance – the values that were read are the same; only the picture differs
 *   page       – the whole page looks different (its values are in the visual checks)
 *   unread     – only the picture could be compared (no values could be read)
 *   none       – nothing differs
 */
export function basisOf(r) {
  const d = r.details || {};
  if (r.status === 'error') return 'error';
  if (r.status === 'missing' || d.missingIn) return 'presence';
  if ((d.data && !d.data.equal) || (d.query && !d.query.equal) || d.dataDiffs?.length || r.scenario === 'selections') return 'values';
  if (['model', 'report_pages', 'structure', 'health', 'budget'].includes(r.scenario)) return 'structure';
  if (r.status === 'fail' || r.status === 'warn' || d.outcome) return 'behaviour';
  if (r.status !== 'diff') return 'none';
  if (r.scenario === 'page_render') return 'page';
  const read = (d.data?.totalA || 0) + (d.query?.rowsA || 0) + (Array.isArray(d.dataDiffs) ? 1 : 0);
  return read ? 'appearance' : 'unread';
}

/**
 * The value evidence of one check: its changes on screen, behind the visual
 * and in the visuals affected by an interaction, each with worked-out
 * differences and what they have in common.
 */
export function evidenceOf(r, { locale = 'en-US', max = 12 } = {}) {
  const d = r.details || {};
  const screen = changesOf(d.data, { locale });
  // Unrounded values straight from the query: always written with a decimal point.
  const behind = changesOf(d.query, { fields: d.query?.fields, locale: 'en-US' });
  const after = (d.dataDiffs || []).map((x) => ({ visual: x.visual, only: x.only, changes: x.only ? [] : changesOf({ equal: false, ops: x.ops || [] }, { locale }) }));
  const all = [...screen, ...behind, ...after.flatMap((x) => x.changes)];
  const nums = all.filter((c) => c.kind === 'number');
  const maxPct = nums.reduce((m, n) => Math.max(m, n.pct == null ? 0 : Math.abs(n.pct)), 0);
  const lines = [];
  lines.push(...section(`values on screen (${d.data?.totalA ?? '?'} lines in A, ${d.data?.totalB ?? '?'} in B)`, screen, max));
  if (d.query) {
    if (d.query.equal) { if (screen.length) lines.push(`  data behind the visual: identical (${d.query.rowsA} rows)`); }
    else lines.push(...section(`data behind the visual, unrounded (${d.query.rowsA} rows in A, ${d.query.rowsB} in B${d.query.complete ? '' : '; first window of the data only'})`, behind, max));
  }
  for (const x of after.slice(0, 6)) {
    if (x.only) lines.push(`  afterwards "${clip(x.visual, 60)}" exists only in ${x.only}`);
    else lines.push(...section(`afterwards in "${clip(x.visual, 60)}"`, x.changes, Math.max(4, Math.floor(max / 2))));
  }
  if (after.length > 6) lines.push(`  … ${after.length - 6} more visuals with different values afterwards`);
  if (d.data?.equal && d.query && !d.query.equal) lines.push('  the text on screen is identical: the difference is in rounded-away digits or rows that are not drawn');
  return {
    basis: basisOf(r),
    changed: all.length,
    numbers: nums.length,
    maxPct,
    // Rows on one side only and blanks outrank any percentage.
    impact: all.some((c) => c.kind !== 'number' && c.kind !== 'text') ? 1e6 + all.length : maxPct * 1000 + all.length,
    lines,
  };
}

const BASIS_NOTE = {
  appearance: 'APPEARANCE ONLY: the values that were read are identical in A and B; only the look differs (formatting, colour, position or rendering). Not a change in the numbers.',
  page: 'WHOLE PAGE: this check only says the page looks different. The values of the page are in its "visual" checks: judge the page by those.',
  unread: 'PICTURE ONLY: no values could be read from this item, so only its picture was compared. Whether the numbers changed is unknown.',
};
export const basisNote = (basis) => BASIS_NOTE[basis] || '';
