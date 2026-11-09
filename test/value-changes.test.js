/** Value changes read as one line per changed row, without unchanged context. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/engine/compare.js';
import { valueChanges, changeText } from '../src/jobs/changes.js';

const row = (date, region, v) => `Select Row | ${date} | JAN | INVENTORY | ${region} | 16.0 | ${v}Additional Conditional Formatting | 21.0`;

test('a row whose number changed is one change, even when the diff listed it apart', () => {
  const a = [row('28-Dec-25', 'North', '17.36'), row('28-Dec-25', 'South', '9.45'), row('28-Dec-25', 'East', '16.45')];
  const b = [row('28-Dec-25', 'North', '17.41'), row('28-Dec-25', 'South', '9.47'), row('28-Dec-25', 'East', '16.45')];
  const ch = valueChanges(diffLines(a, b));
  assert.deepEqual(ch.map((c) => changeText(c)), [
    '28-Dec-25 · JAN · INVENTORY · North: 17.36 → 17.41',
    '28-Dec-25 · JAN · INVENTORY · South: 9.45 → 9.47',
  ]);
});

test('chart labels pair in order; rows only on one side stay additions and removals', () => {
  const ch = valueChanges(diffLines(['NOV', 'DEC', '15.7', '18.0', '• 15.65'], ['NOV', 'DEC', '15.6', '17.9', '• 15.63']));
  assert.deepEqual(ch.map((c) => changeText(c)), ['15.7 → 15.6', '18.0 → 17.9', '15.65 → 15.63']);
  const ch2 = valueChanges(diffLines(['KPI | Sales | 10', 'KPI | Cost | 4'], ['KPI | Sales | 10', 'KPI | Margin | 6 | x']));
  assert.deepEqual(ch2.map((c) => c.op), ['del', 'add']);
  assert.equal(valueChanges(diffLines(['A | 1'], ['A | 1'])).length, 0);
});
