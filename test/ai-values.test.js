/**
 * The value evidence the AI analysis is written from: numbers as written in a
 * report, the worked-out difference of each changed value, what the changes of
 * one visual have in common, and what a check's verdict rests on.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-aiv-'));
let v;
before(async () => { process.env.DATA_DIR = tmp; process.env.LOG_LEVEL = 'warn'; v = await import('../src/ai/values.js'); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const diff = (pairs, extra = {}) => ({
  equal: false, totalA: pairs.length, totalB: pairs.length, ...extra,
  ops: pairs.map(([a, b]) => (a == null ? { op: 'add', b } : b == null ? { op: 'del', a } : a === b ? { op: 'eq', a, b } : { op: 'chg', a, b })),
});

test('numbers are read as they are written in a report', () => {
  assert.equal(v.parseNumber('1,234.5').value, 1234.5);
  assert.equal(v.parseNumber('(1,234)').value, -1234);
  assert.equal(v.parseNumber('$1.2M').value, 1200000);
  assert.equal(v.parseNumber('950K').value, 950000);
  assert.deepEqual(v.parseNumber('−12.5%'), { value: -12.5, percent: true });
  assert.equal(v.parseNumber('1.234,56', 'de-DE').value, 1234.56);
  assert.equal(v.parseNumber('1 234,5', 'fr-FR').value, 1234.5);
  for (const notANumber of ['North', '2024-01-01', 'Q1 2024', '', '12 units sold']) assert.equal(v.parseNumber(notANumber), null, notANumber);
});

test('a changed value comes with its difference and percentage worked out', () => {
  const [c] = v.numberChanges('North 280,000', 'North 285,285');
  assert.equal(c.delta, 5285);
  assert.equal(Number(c.pct.toFixed(4)), 1.8875);
  // Two percentages differ in percentage points.
  assert.equal(v.numberChanges('Share 12.5%', 'Share 14.0%')[0].points, true);
  // The same amount written differently is not a change.
  assert.deepEqual(v.numberChanges('1,200', '1.2K'), []);
  // A different scale is.
  assert.equal(v.numberChanges('1.2M', '950K')[0].delta, -250000);
  // Dates are not amounts, and a changed label is a text change.
  assert.equal(v.numberChanges('2024-01-01', '2024-06-01'), null);
  assert.equal(v.numberChanges('North 5', 'South 5'), null);
});

test('the evidence of a visual lists each changed value with its row, and the common pattern', () => {
  const data = diff([
    ['Region | Sales | Margin', 'Region | Sales | Margin'],
    ['North | 100,000 | 12.5%', 'North | 101,900 | 12.5%'],
    ['South | 200,000 | 10.0%', 'South | 203,800 | 10.0%'],
    ['East | 50,000 | 8.0%', 'East | 50,950 | 8.0%'],
    [null, 'West | 10,000 | 5.0%'],
  ]);
  const e = v.evidenceOf({ status: 'diff', scenario: 'visual', details: { data } });
  const text = e.lines.join('\n');
  assert.equal(e.basis, 'values');
  assert.equal(e.changed, 4);
  assert.match(text, /North: 100,000 → 101,900 \(Δ \+1,900, \+1\.9%\)/);
  assert.match(text, /only in B: West \| 10,000 \| 5\.0%/);
  assert.match(text, /all 3 changed numbers went up/);
  assert.match(text, /every changed number moved by the same factor ×1\.019 \(\+1\.9%\)/);
  assert.match(text, /1 row\(s\) only in B/);
});

test('the data behind a visual names its fields and shows digits that are rounded away on screen', () => {
  const query = { ...diff([['Region | Sum(Sales)', 'Region | Sum(Sales)'], ['North | 100000.4', 'North | 100000.44'], ['South | (blank)', 'South | 5']]), fields: ['Region', 'Sum(Sales)'], rowsA: 2, rowsB: 2, complete: true };
  const e = v.evidenceOf({ status: 'diff', scenario: 'visual', details: { data: { equal: true, totalA: 3, totalB: 3, ops: [] }, query } });
  const text = e.lines.join('\n');
  assert.equal(e.basis, 'values');
  assert.match(text, /data behind the visual, unrounded \(2 rows in A, 2 in B\): 2 change\(s\)/);
  assert.match(text, /North · Sum\(Sales\): 100000\.4 → 100000\.44 \(Δ \+0\.04, \+0\.00004%\)/);
  assert.match(text, /South · Sum\(Sales\): "\(blank\)" → "5" \(blank on one side\)/);
  assert.match(text, /the text on screen is identical/);
});

test('patterns are measured, not guessed', () => {
  const num = (va, vb) => ({ kind: 'number', va, vb, delta: vb - va, pct: va ? ((vb - va) / Math.abs(va)) * 100 : null });
  assert.match(v.patternOf([num(0.125, 12.5), num(0.5, 50), num(0.08, 8)]).join('; '), /same factor: ×100 \(a percentage or unit change\)/);
  assert.match(v.patternOf([num(10, 15), num(200, 205), num(-3, 2)]).join('; '), /moved by the same amount \(\+5\)/);
  assert.match(v.patternOf([num(100, 100.001), num(50, 50.0004)]).join('; '), /below 0\.01% \(rounding-level\)/);
  assert.match(v.patternOf([num(10, 12), num(10, 7), num(5, 0)]).join('; '), /1 went up, 2 went down.*1 value\(s\) became 0/);
  assert.doesNotMatch(v.patternOf([num(10, 12), num(10, 7), num(5, 9)]).join('; '), /same factor|same amount/);
});

test('a check says what its verdict rests on: values, or only the look', () => {
  const same = { equal: true, totalA: 5, totalB: 5, ops: [] };
  assert.equal(v.basisOf({ status: 'diff', scenario: 'visual', details: { data: diff([['a 1', 'a 2']]) } }), 'values');
  assert.equal(v.basisOf({ status: 'diff', scenario: 'visual', details: { data: same, query: diff([['a | 1', 'a | 2']]) } }), 'values');
  assert.equal(v.basisOf({ status: 'diff', scenario: 'slicer', details: { dataDiffs: [{ visual: 'Card', ops: [] }] } }), 'values');
  assert.equal(v.basisOf({ status: 'diff', scenario: 'visual', details: { data: same } }), 'appearance');
  assert.equal(v.basisOf({ status: 'diff', scenario: 'slicer', details: { dataDiffs: [] } }), 'appearance');
  assert.equal(v.basisOf({ status: 'diff', scenario: 'visual', details: { data: { equal: true, totalA: 0, totalB: 0, ops: [] } } }), 'unread');
  assert.equal(v.basisOf({ status: 'diff', scenario: 'page_render', details: {} }), 'page');
  assert.equal(v.basisOf({ status: 'missing', scenario: 'visual', details: { missingIn: 'B' } }), 'presence');
  assert.equal(v.basisOf({ status: 'fail', scenario: 'button', details: { outcome: {} } }), 'behaviour');
  assert.match(v.basisNote('appearance'), /values that were read are identical/);
  assert.match(v.basisNote('unread'), /Whether the numbers changed is unknown/);
});
