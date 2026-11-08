import path from 'node:path';
import { isZip, readZip } from './zip.js';

// A data-model snapshot in one canonical shape, whatever it was read from:
//   - model.bim / Tabular JSON (Tabular Editor, SSDT, "Save as .bim")
//   - .pbit Power BI template (DataModelSchema inside the zip)
//   - TMDL folder (Power BI Project / Fabric Git), uploaded as a .zip
//   - Power BI REST API (INFO.VIEW.* DAX queries), see powerbi.js
//
// {
//   source, name,
//   tables:        { [table]: { hidden, source, columns: { [c]: { dataType, expression, hidden } },
//                               measures: { [m]: { expression, formatString, displayFolder, hidden } } } },
//   relationships: { ["T[c] → U[d]"]: { active, crossFilter, cardinality } },
//   roles:         { [role]: { permission, filters: { [table]: expression } } },
//   parameters:    { [name]: expression },   // shared M expressions / query parameters
//   meta:          { lastRefresh, culture, compatibilityLevel }
// }

const AUTO_TABLE = /^(LocalDateTable|DateTableTemplate)_/;
const AUTO_COLUMN = /^RowNumber-/;

const text = (v) => (Array.isArray(v) ? v.join('\n') : v == null ? '' : String(v));
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** Normalises an expression for display: LF line ends, no trailing spaces, dedented. */
export function cleanExpr(s) {
  const lines = text(s).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const indents = lines.filter((l) => l.trim()).map((l) => /^[\t ]*/.exec(l)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join('\n');
}

function emptyModel(source) {
  return { source, name: '', tables: {}, relationships: {}, roles: {}, parameters: {}, meta: {} };
}

export const relKey = (r) => `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]`;

function addRelationship(m, r) {
  if (!r.fromTable || !r.toTable || AUTO_TABLE.test(r.fromTable) || AUTO_TABLE.test(r.toTable)) return;
  m.relationships[relKey(r)] = {
    active: r.active === undefined ? true : bool(r.active),
    crossFilter: String(r.crossFilter || 'oneDirection'),
    cardinality: `${(r.fromCardinality || 'many').toString().toLowerCase()}:${(r.toCardinality || 'one').toString().toLowerCase()}`,
  };
}

// ---------------------------------------------------------------- BIM / JSON
export function fromBim(json, source = 'model.bim') {
  const model = json.model || json;
  if (!Array.isArray(model.tables)) throw Object.assign(new Error('This JSON file is not a Power BI / Tabular model (no "tables")'), { status: 400 });
  const m = emptyModel(source);
  m.name = json.name || model.name || '';
  m.meta = { culture: model.culture || null, compatibilityLevel: json.compatibilityLevel || null };
  for (const t of model.tables) {
    if (!t?.name || AUTO_TABLE.test(t.name)) continue;
    const tbl = { hidden: !!t.isHidden, source: '', columns: {}, measures: {} };
    const part = (t.partitions || [])[0];
    if (part?.source) tbl.source = cleanExpr(part.source.expression || part.source.query || '');
    for (const c of t.columns || []) {
      if (!c?.name || c.type === 'rowNumber' || AUTO_COLUMN.test(c.name)) continue;
      tbl.columns[c.name] = { dataType: c.dataType || '', expression: cleanExpr(c.expression), hidden: !!c.isHidden };
    }
    for (const x of t.measures || []) {
      if (!x?.name) continue;
      tbl.measures[x.name] = { expression: cleanExpr(x.expression), formatString: x.formatString || '', displayFolder: x.displayFolder || '', hidden: !!x.isHidden };
    }
    m.tables[t.name] = tbl;
  }
  for (const r of model.relationships || []) {
    addRelationship(m, { ...r, active: r.isActive, crossFilter: r.crossFilteringBehavior });
  }
  for (const r of model.roles || []) {
    if (!r?.name) continue;
    m.roles[r.name] = { permission: r.modelPermission || 'read', filters: Object.fromEntries((r.tablePermissions || []).filter((p) => p.filterExpression).map((p) => [p.name, cleanExpr(p.filterExpression)])) };
  }
  for (const e of model.expressions || []) if (e?.name) m.parameters[e.name] = cleanExpr(e.expression);
  return m;
}

// ---------------------------------------------------------------- .pbit
export function fromPbit(buf, source = 'template.pbit') {
  const entry = readZip(buf).find((e) => e.name === 'DataModelSchema');
  if (!entry) throw Object.assign(new Error('This .pbit has no DataModelSchema'), { status: 400 });
  let raw = entry.read();
  // UTF-16LE with or without a BOM.
  const s = raw[1] === 0 || (raw[0] === 0xff && raw[1] === 0xfe) ? raw.toString('utf16le') : raw.toString('utf8');
  return fromBim(JSON.parse(s.replace(/^﻿/, '')), source);
}

// ---------------------------------------------------------------- TMDL
const DECL = /^(table|column|measure|relationship|role|tablePermission|partition|expression|calculationGroup|calculationItem|hierarchy|level|annotation|extendedProperty|changedProperty|model|database|culture|perspective|ref|dataSource|queryGroup|linguisticMetadata|columnPermission|variation|formatStringDefinition|detailRowsDefinition|kpi|function)\b\s*(.*)$/;

function unquote(s) {
  s = s.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1).replace(/""/g, '"');
  return s;
}

/** Splits "Name = expr" / "'A name' = expr" / "Name" into [name, expr|null]. */
function splitDecl(rest) {
  let i = 0, name;
  if (rest.startsWith("'")) {
    i = 1;
    while (i < rest.length) { if (rest[i] === "'" && rest[i + 1] === "'") i += 2; else if (rest[i] === "'") break; else i++; }
    name = unquote(rest.slice(0, i + 1));
    i += 1;
  } else {
    const eq = rest.indexOf(' =');
    name = (eq >= 0 ? rest.slice(0, eq) : rest).trim();
    i = eq >= 0 ? eq : rest.length;
  }
  const after = rest.slice(i).trim();
  if (!after.startsWith('=')) return [name, null];
  return [name, after.slice(1).trim()];
}

/** "Sales.CustomerKey" / "'Sales Table'.'Customer Key'" → [table, column]. */
function splitColumnRef(s) {
  const m = /^('(?:[^']|'')+'|[^.]+)\.('(?:[^']|'')+'|.+)$/.exec(String(s || '').trim());
  return m ? [unquote(m[1]), unquote(m[2])] : [String(s || ''), ''];
}

const indentOf = (line) => {
  const ws = /^[\t ]*/.exec(line)[0];
  return (ws.match(/\t/g) || []).length + Math.floor((ws.match(/ /g) || []).length / 4);
};

/** Parses TMDL text files into a tree of { type, name, expr, props, children }. */
export function parseTmdl(files) {
  const root = { type: 'root', indent: -1, props: {}, children: [] };
  for (const f of files) {
    const stack = [root];
    let collect = null; // { target, key, base, fenced, lines }
    const flush = () => {
      if (!collect) return;
      const v = collect.lines.join('\n');
      if (collect.key) collect.target.props[collect.key] = v; else collect.target.expr = v;
      collect = null;
    };
    for (const line of f.text.replace(/\r\n?/g, '\n').split('\n')) {
      const ind = indentOf(line);
      const t = line.trim();
      if (collect) {
        if (collect.fenced) {
          if (t === '```') { flush(); continue; }
          collect.lines.push(line);
          continue;
        }
        if (!t || ind > collect.base + 1) { collect.lines.push(line); continue; }
        flush();
      }
      if (!t || t.startsWith('///') || t.startsWith('//')) continue;
      const d = DECL.exec(t);
      if (d) {
        while (stack.length > 1 && stack.at(-1).indent >= ind) stack.pop();
        const [name, expr] = splitDecl(d[2]);
        const node = { type: d[1], name, expr: expr || '', props: {}, children: [], indent: ind };
        stack.at(-1).children.push(node);
        stack.push(node);
        if (expr === '```') collect = { target: node, key: null, base: ind, fenced: true, lines: [] };
        else if (expr === '') collect = { target: node, key: null, base: ind, fenced: false, lines: [] };
        continue;
      }
      while (stack.length > 1 && stack.at(-1).indent >= ind) stack.pop();
      const owner = stack.at(-1);
      const p = /^([A-Za-z][\w]*)\s*([:=])\s*(.*)$/.exec(t);
      if (!p) { owner.props[t] = true; continue; } // bare flag such as isHidden
      const [, key, sep, val] = p;
      if (sep === '=' && (val === '' || val === '```')) { collect = { target: owner, key, base: ind, fenced: val === '```', lines: [] }; continue; }
      owner.props[key] = sep === ':' ? unquote(val) : val;
    }
    flush();
  }
  return root;
}

export function fromTmdl(files, source = 'TMDL') {
  const tree = parseTmdl(files);
  const m = emptyModel(source);
  const walk = (n, fn) => { fn(n); for (const c of n.children) walk(c, fn); };
  walk(tree, (n) => {
    if (n.type === 'model' || n.type === 'database') {
      if (n.props.culture) m.meta.culture = n.props.culture;
      if (n.props.compatibilityLevel) m.meta.compatibilityLevel = Number(n.props.compatibilityLevel);
      if (n.type === 'model' && !m.name) m.name = n.name;
    }
    if (n.type === 'table' && !AUTO_TABLE.test(n.name)) {
      const tbl = m.tables[n.name] || { hidden: false, source: '', columns: {}, measures: {} };
      tbl.hidden = !!n.props.isHidden && n.props.isHidden !== 'false';
      for (const c of n.children) {
        if (c.type === 'column' && !AUTO_COLUMN.test(c.name)) {
          tbl.columns[c.name] = { dataType: c.props.dataType || '', expression: cleanExpr(c.expr), hidden: !!c.props.isHidden && c.props.isHidden !== 'false' };
        } else if (c.type === 'measure') {
          tbl.measures[c.name] = { expression: cleanExpr(c.expr), formatString: c.props.formatString || '', displayFolder: c.props.displayFolder || '', hidden: !!c.props.isHidden && c.props.isHidden !== 'false' };
        } else if (c.type === 'partition' && !tbl.source) {
          tbl.source = cleanExpr(c.props.source || c.props.query || '');
        }
      }
      m.tables[n.name] = tbl;
    }
    if (n.type === 'relationship') {
      const [fromTable, fromColumn] = splitColumnRef(n.props.fromColumn);
      const [toTable, toColumn] = splitColumnRef(n.props.toColumn);
      addRelationship(m, { fromTable, fromColumn, toTable, toColumn, active: n.props.isActive === undefined ? true : n.props.isActive, crossFilter: n.props.crossFilteringBehavior, fromCardinality: n.props.fromCardinality, toCardinality: n.props.toCardinality });
    }
    if (n.type === 'role') {
      m.roles[n.name] = { permission: n.props.modelPermission || 'read', filters: Object.fromEntries(n.children.filter((c) => c.type === 'tablePermission' && c.expr).map((c) => [c.name, cleanExpr(c.expr)])) };
    }
    if (n.type === 'expression' && n.indent === 0) m.parameters[n.name] = cleanExpr(n.expr);
  });
  if (!Object.keys(m.tables).length) throw Object.assign(new Error('No tables found in the TMDL files'), { status: 400 });
  return m;
}

// ---------------------------------------------------------------- INFO.VIEW
const keyOf = (k) => k.replace(/^.*\[/, '').replace(/\]$/, '').toLowerCase();
const rowsOf = (rows) => (rows || []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [keyOf(k), v])));

/** Builds a snapshot from INFO.VIEW.TABLES/COLUMNS/MEASURES/RELATIONSHIPS rows (+ optional roles). */
export function fromInfoView({ tables, columns, measures, relationships, roles, tablePermissions }, source = 'Power BI API') {
  const m = emptyModel(source);
  for (const t of rowsOf(tables)) {
    if (!t.name || AUTO_TABLE.test(t.name) || bool(t.isprivate)) continue;
    m.tables[t.name] = { hidden: bool(t.ishidden), source: cleanExpr(t.expression || ''), columns: {}, measures: {} };
  }
  const tableFor = (name) => (m.tables[name] ??= { hidden: false, source: '', columns: {}, measures: {} });
  for (const c of rowsOf(columns)) {
    if (!c.name || !c.table || AUTO_TABLE.test(c.table) || AUTO_COLUMN.test(c.name) || /rownumber/i.test(String(c.type || ''))) continue;
    tableFor(c.table).columns[c.name] = { dataType: String(c.datatype ?? ''), expression: cleanExpr(c.expression || ''), hidden: bool(c.ishidden) };
  }
  for (const x of rowsOf(measures)) {
    if (!x.name || !x.table) continue;
    tableFor(x.table).measures[x.name] = { expression: cleanExpr(x.expression || ''), formatString: x.formatstring || '', displayFolder: x.displayfolder || '', hidden: bool(x.ishidden) };
  }
  for (const r of rowsOf(relationships)) {
    addRelationship(m, { fromTable: r.fromtable, fromColumn: r.fromcolumn, toTable: r.totable, toColumn: r.tocolumn, active: r.isactive, crossFilter: r.crossfilteringbehavior, fromCardinality: r.fromcardinality, toCardinality: r.tocardinality });
  }
  if (roles) {
    const byId = {};
    for (const r of rowsOf(roles)) { byId[r.id] = r.name; m.roles[r.name] = { permission: String(r.modelpermission || 'read'), filters: {} }; }
    for (const p of rowsOf(tablePermissions)) {
      const role = byId[p.roleid] || p.role;
      if (role && m.roles[role] && p.filterexpression) m.roles[role].filters[p.table || p.tablename || p.tableid] = cleanExpr(p.filterexpression);
    }
  }
  return m;
}

// ---------------------------------------------------------------- uploads
/**
 * Reads an uploaded model file: .bim / .json, .pbit, a single .tmdl file, or
 * a .zip of a TMDL folder (Power BI Project "definition" folder).
 */
export function snapshotFromUpload(buf, filename = 'model') {
  const ext = path.extname(filename).toLowerCase();
  if (isZip(buf)) {
    const entries = readZip(buf);
    if (entries.some((e) => e.name === 'DataModelSchema')) return fromPbit(buf, filename);
    const bim = entries.find((e) => /(^|\/)model\.bim$/i.test(e.name));
    if (bim) return fromBim(JSON.parse(bim.read().toString('utf8').replace(/^﻿/, '')), filename);
    const tmdl = entries.filter((e) => e.name.toLowerCase().endsWith('.tmdl'));
    if (tmdl.length) return fromTmdl(tmdl.map((e) => ({ name: e.name, text: e.read().toString('utf8') })), filename);
    if (ext === '.pbix') throw Object.assign(new Error('A .pbix stores its model in a compressed binary format. Save it as a template (File → Export → Power BI template, .pbit) and upload that instead.'), { status: 400 });
    throw Object.assign(new Error('The ZIP contains no model.bim, DataModelSchema or .tmdl files'), { status: 400 });
  }
  const s = buf.toString('utf8').replace(/^﻿/, '');
  if (ext === '.tmdl' || /^\s*(table|model|database|relationship)\s/m.test(s) && !s.trimStart().startsWith('{')) return fromTmdl([{ name: filename, text: s }], filename);
  let json;
  try { json = JSON.parse(s); } catch { throw Object.assign(new Error('Unsupported file. Upload a .pbit, model.bim, .tmdl or a .zip of a TMDL folder.'), { status: 400 }); }
  return fromBim(json, filename);
}

/** Counts for display. */
export function modelStats(m) {
  const t = Object.values(m.tables);
  return {
    tables: t.length,
    columns: t.reduce((n, x) => n + Object.keys(x.columns).length, 0),
    measures: t.reduce((n, x) => n + Object.keys(x.measures).length, 0),
    relationships: Object.keys(m.relationships).length,
    roles: Object.keys(m.roles).length,
  };
}
