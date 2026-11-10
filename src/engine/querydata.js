/**
 * The data Power BI downloads for each visual ("querydata" responses).
 *
 * What a visual draws is rounded and cut to what fits on screen; the response
 * behind it has every row of the first data window at full precision. The
 * runner compares these between A and B in addition to the text on screen.
 *
 * A response is tied to its visual by the visual's ID, which is in the request
 * (ApplicationContext.Sources[].VisualId) and in the page (see inpage.js).
 */
import crypto from 'node:crypto';

const BLANK = '(blank)';

/** Numbers at 12 significant digits: exact enough to catch any real change, without float noise in the last digits. */
function fmtNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(Number(n.toPrecision(12)));
}

function fmtValue(v, type) {
  if (v === null || v === undefined) return BLANK;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (type === 7 && typeof v === 'number') { // date/time as milliseconds
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().replace('T00:00:00.000Z', '').replace('.000Z', 'Z');
  }
  if (typeof v === 'number') return fmtNumber(v);
  if (typeof v === 'string') {
    // Type 1 is text; other types send numbers as strings ("0.7736281938813823").
    if (type !== 1 && v !== '' && /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v)) return fmtNumber(Number(v));
    return v.replace(/\s+/g, ' ').trim();
  }
  return JSON.stringify(v);
}

/** Values of one row: positional ("C", with repeat "R" and null "Ø" bit masks) or by name. */
function rowValues(row, schema, prev, dicts) {
  const positional = Array.isArray(row.C) || row.R !== undefined || row['Ø'] !== undefined;
  const c = row.C || [];
  let ci = 0;
  return schema.map((col, i) => {
    let v;
    if (positional) {
      if (row.R && (row.R >> i) & 1) return prev[i];
      if (row['Ø'] && (row['Ø'] >> i) & 1) v = null;
      else v = c[ci++];
    } else v = row[col.N];
    if (v !== null && v !== undefined && col.DN && dicts?.[col.DN]) v = dicts[col.DN][v];
    return v === undefined ? null : v;
  });
}

function walkMembers(rows, prefix, dicts, lines, state) {
  let schema = [], prev = [];
  for (const row of rows || []) {
    if (lines.length >= state.cap) { state.truncated = true; return; }
    if (Array.isArray(row.S)) { schema = row.S; prev = []; }
    const vals = rowValues(row, schema, prev, dicts);
    prev = vals;
    const cells = [...prefix, ...vals.map((v, i) => fmtValue(v, schema[i]?.T))];
    // Values across a second hierarchy (matrix columns, chart series).
    let cross = '';
    if (Array.isArray(row.X)) {
      let xPrev = [], at = 0;
      const parts = [];
      for (const x of row.X) {
        if (Array.isArray(x.S)) { state.xSchema = x.S; xPrev = []; }
        if (typeof x.I === 'number') at = x.I;
        const xv = rowValues(x, state.xSchema || [], xPrev, dicts);
        xPrev = xv;
        parts.push(`[${at}] ${xv.map((v, i) => fmtValue(v, state.xSchema?.[i]?.T)).join(' | ')}`);
        at++;
      }
      cross = parts.join(' ; ');
    }
    if (vals.length || cross) lines.push([cells.join(' | '), cross].filter(Boolean).join(' → '));
    for (const m of row.M || []) for (const key of Object.keys(m)) if (Array.isArray(m[key])) walkMembers(m[key], cells, dicts, lines, state);
  }
}

/**
 * Turns one query result into comparable lines: a header with the field
 * names, then one line per row. Returns { lines, rows, complete, error, opaque }.
 */
export function decodeQueryResult(data, { cap = 5000 } = {}) {
  const select = data?.descriptor?.Select || [];
  const header = select.map((s) => s.Name || s.Value).join(' | ');
  const dsr = data?.dsr;
  const failure = dsr?.DataShapes?.find((d) => d['odata.error'])?.['odata.error'];
  if (failure) return { lines: [], rows: 0, complete: false, error: String(failure.message?.value || failure.code || 'query failed').slice(0, 300) };
  const sets = dsr?.DS || [];
  try {
    const lines = [];
    const state = { cap, truncated: false, xSchema: null };
    let complete = true;
    for (const ds of sets) {
      if (ds.IC === false || ds.RT) complete = false;
      // Members of the second hierarchy (column headers), then the rows.
      for (const sh of ds.SH || []) {
        for (const key of Object.keys(sh)) {
          if (!Array.isArray(sh[key])) continue;
          const cols = [];
          walkMembers(sh[key], [], ds.ValueDicts, cols, { cap, truncated: false, xSchema: null });
          cols.forEach((c, i) => lines.push(`column [${i}] ${c}`));
        }
      }
      for (const ph of ds.PH || []) for (const key of Object.keys(ph)) if (Array.isArray(ph[key])) walkMembers(ph[key], [], ds.ValueDicts, lines, state);
    }
    return { lines: header ? [header, ...lines] : lines, rows: lines.length, complete: complete && !state.truncated, error: null };
  } catch {
    // Unknown layout: still comparable as a whole, just not row by row.
    const hash = crypto.createHash('sha1').update(JSON.stringify(sets.map((ds) => [ds.PH, ds.SH, ds.ValueDicts]))).digest('hex').slice(0, 16);
    return { lines: [header, `data fingerprint ${hash}`].filter(Boolean), rows: 0, complete: false, error: null, opaque: true };
  }
}

/** Splits one querydata exchange into per-visual results: [{ visualId, ...decoded }]. */
export function parseQueryExchange(postData, body) {
  let req, res;
  try { req = JSON.parse(postData); res = JSON.parse(body); } catch { return []; }
  const out = [];
  (req?.queries || []).forEach((q, i) => {
    const visualId = q?.ApplicationContext?.Sources?.[0]?.VisualId;
    const r = res?.results?.[i]?.result;
    if (!visualId || !r) return;
    if (r.error) { out.push({ visualId, lines: [], rows: 0, complete: false, error: String(r.error.message || r.error.code || 'query failed').slice(0, 300) }); return; }
    if (r.data) out.push({ visualId, ...decodeQueryResult(r.data) });
  });
  return out;
}
