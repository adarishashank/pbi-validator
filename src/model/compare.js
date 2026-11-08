// Compares two canonical model snapshots (see snapshot.js). Expressions are
// compared ignoring whitespace-only differences (re-indenting DAX is not a change).

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const same = (a, b) => squash(a) === squash(b);

const KIND_LABEL = { table: 'Table', column: 'Column', measure: 'Measure', relationship: 'Relationship', role: 'Security role', parameter: 'Parameter / shared query' };
export { KIND_LABEL };

function diffFields(a, b, fields) {
  const out = [];
  for (const [field, label] of fields) {
    if (!same(a?.[field], b?.[field])) out.push({ field, label, a: a?.[field] ?? '', b: b?.[field] ?? '' });
  }
  return out;
}

const keys = (a, b) => [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort((x, y) => x.localeCompare(y));

/**
 * Returns { changes, counts, stats } where each change is
 * { kind, change: 'added'|'removed'|'changed', table, name, label, fields: [{field,label,a,b}], exprA, exprB }.
 * "added" = only in B, "removed" = only in A.
 */
export function compareModels(A, B) {
  const changes = [];
  const push = (c) => changes.push({ fields: [], exprA: '', exprB: '', table: '', ...c });

  for (const t of keys(A.tables, B.tables)) {
    const ta = A.tables[t], tb = B.tables[t];
    const tLabel = `'${t}'`;
    if (!ta || !tb) {
      const x = ta || tb;
      push({ kind: 'table', change: ta ? 'removed' : 'added', name: t, label: tLabel, exprA: ta?.source || '', exprB: tb?.source || '',
        fields: [{ field: 'contents', label: 'Contents', a: ta ? `${Object.keys(x.columns).length} columns, ${Object.keys(x.measures).length} measures` : '', b: tb ? `${Object.keys(x.columns).length} columns, ${Object.keys(x.measures).length} measures` : '' }] });
      continue;
    }
    const tf = diffFields(ta, tb, [['hidden', 'Hidden'], ['source', 'Source query (Power Query / partition)']]);
    if (tf.length) push({ kind: 'table', change: 'changed', name: t, label: tLabel, fields: tf, exprA: tf.some((f) => f.field === 'source') ? ta.source : '', exprB: tf.some((f) => f.field === 'source') ? tb.source : '' });
    for (const c of keys(ta.columns, tb.columns)) {
      const ca = ta.columns[c], cb = tb.columns[c];
      const label = `${t}[${c}]`;
      if (!ca || !cb) { push({ kind: 'column', change: ca ? 'removed' : 'added', table: t, name: c, label, exprA: ca?.expression || '', exprB: cb?.expression || '', fields: [{ field: 'dataType', label: 'Data type', a: ca?.dataType || '', b: cb?.dataType || '' }] }); continue; }
      const f = diffFields(ca, cb, [['dataType', 'Data type'], ['expression', 'DAX (calculated column)'], ['hidden', 'Hidden']]);
      if (f.length) push({ kind: 'column', change: 'changed', table: t, name: c, label, fields: f, exprA: ca.expression, exprB: cb.expression });
    }
    for (const x of keys(ta.measures, tb.measures)) {
      const ma = ta.measures[x], mb = tb.measures[x];
      const label = `[${x}]`;
      if (!ma || !mb) { push({ kind: 'measure', change: ma ? 'removed' : 'added', table: t, name: x, label, exprA: ma?.expression || '', exprB: mb?.expression || '' }); continue; }
      const f = diffFields(ma, mb, [['expression', 'DAX'], ['formatString', 'Format'], ['displayFolder', 'Display folder'], ['hidden', 'Hidden']]);
      if (f.length) push({ kind: 'measure', change: 'changed', table: t, name: x, label, fields: f, exprA: ma.expression, exprB: mb.expression });
    }
  }
  // A measure moved to another table shows up as removed + added: pair them.
  for (const add of changes.filter((c) => c.kind === 'measure' && c.change === 'added')) {
    const rem = changes.find((c) => c.kind === 'measure' && c.change === 'removed' && c.name === add.name);
    if (!rem) continue;
    changes.splice(changes.indexOf(rem), 1);
    Object.assign(add, { change: 'changed', exprA: rem.exprA, fields: [{ field: 'table', label: 'Home table', a: rem.table, b: add.table }, ...(same(rem.exprA, add.exprB) ? [] : [{ field: 'expression', label: 'DAX', a: rem.exprA, b: add.exprB }])] });
  }

  for (const k of keys(A.relationships, B.relationships)) {
    const ra = A.relationships[k], rb = B.relationships[k];
    if (!ra || !rb) { push({ kind: 'relationship', change: ra ? 'removed' : 'added', name: k, label: k }); continue; }
    const f = diffFields(ra, rb, [['active', 'Active'], ['crossFilter', 'Cross-filter direction'], ['cardinality', 'Cardinality']]);
    if (f.length) push({ kind: 'relationship', change: 'changed', name: k, label: k, fields: f });
  }

  for (const r of keys(A.roles, B.roles)) {
    const ra = A.roles[r], rb = B.roles[r];
    if (!ra || !rb) { push({ kind: 'role', change: ra ? 'removed' : 'added', name: r, label: `Role "${r}"` }); continue; }
    const f = diffFields(ra, rb, [['permission', 'Permission']]);
    for (const t of keys(ra.filters, rb.filters)) {
      if (!same(ra.filters[t], rb.filters[t])) f.push({ field: `filter:${t}`, label: `Row filter on ${t}`, a: ra.filters[t] || '', b: rb.filters[t] || '' });
    }
    if (f.length) push({ kind: 'role', change: 'changed', name: r, label: `Role "${r}"`, fields: f, exprA: f.filter((x) => x.field.startsWith('filter:')).map((x) => `${x.label}: ${x.a || '(none)'}`).join('\n'), exprB: f.filter((x) => x.field.startsWith('filter:')).map((x) => `${x.label}: ${x.b || '(none)'}`).join('\n') });
  }

  for (const p of keys(A.parameters, B.parameters)) {
    const pa = A.parameters[p], pb = B.parameters[p];
    if (pa === undefined || pb === undefined) { push({ kind: 'parameter', change: pa === undefined ? 'added' : 'removed', name: p, label: p, exprA: pa || '', exprB: pb || '' }); continue; }
    if (!same(pa, pb)) push({ kind: 'parameter', change: 'changed', name: p, label: p, exprA: pa, exprB: pb, fields: [{ field: 'expression', label: 'Expression', a: pa, b: pb }] });
  }

  const counts = { added: 0, removed: 0, changed: 0 };
  const byKind = {};
  for (const c of changes) {
    counts[c.change]++;
    byKind[c.kind] ??= { added: 0, removed: 0, changed: 0 };
    byKind[c.kind][c.change]++;
  }
  return { changes, counts, byKind };
}

/** "Measure [Total Sales] changed: DAX, Format" */
export function changeTitle(c) {
  const what = `${KIND_LABEL[c.kind] || c.kind} ${c.label}`;
  if (c.change === 'added') return `${what} added in B`;
  if (c.change === 'removed') return `${what} missing in B`;
  return `${what} changed: ${c.fields.map((f) => f.label).join(', ')}`;
}
