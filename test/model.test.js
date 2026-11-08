/**
 * Data-model comparison: reading .bim / .pbit / TMDL / Power BI API (INFO.VIEW)
 * into one snapshot shape, comparing two models, the run checks, the upload
 * route and the "What changed" summary.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ZipArchive } from 'archiver';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-model-'));
let fakeApi;
Object.assign(process.env, {
  DATA_DIR: tmp, LOG_LEVEL: 'error', API_TOKEN: 'model-token-0123456789',
  NVIDIA_API_KEY: '', AI_API_KEY: '', AI_AUTO_ANALYZE: 'false',
  PBI_TENANT_ID: 'tenant-1', PBI_CLIENT_ID: 'client-1', PBI_CLIENT_SECRET: 'secret-1',
});

// ------------------------------------------------------------------ fixtures
const BIM_A = {
  name: 'Sales model', compatibilityLevel: 1567,
  model: {
    culture: 'en-US',
    tables: [
      { name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }, { name: 'Region', dataType: 'string' }, { name: 'RowNumber-123', type: 'rowNumber' }],
        measures: [
          { name: 'Total Sales', expression: 'SUM ( Sales[Amount] )', formatString: '#,0' },
          { name: 'Avg Sale', expression: ['AVERAGE (', '    Sales[Amount]', ')'] },
          { name: 'Old KPI', expression: '1' },
        ],
        partitions: [{ source: { type: 'm', expression: ['let', '    Source = Sql.Database("prod", "db")', 'in', '    Source'] } }] },
      { name: 'Customer', columns: [{ name: 'CustomerKey', dataType: 'int64' }] },
      { name: 'LocalDateTable_abc', columns: [{ name: 'Date', dataType: 'dateTime' }] },
    ],
    relationships: [{ name: 'r1', fromTable: 'Sales', fromColumn: 'Region', toTable: 'Customer', toColumn: 'CustomerKey' }],
    roles: [{ name: 'North only', modelPermission: 'read', tablePermissions: [{ name: 'Sales', filterExpression: '[Region] = "North"' }] }],
    expressions: [{ name: 'Server', expression: '"prod" meta [IsParameterQuery=true]' }],
  },
};

const TMDL_B = {
  'model.tmdl': 'model Model\n\tculture: en-US\n',
  'tables/Sales.tmdl': `table Sales
\tlineageTag: 1

\tmeasure 'Total Sales' =
\t\t\tSUMX (
\t\t\t    Sales,
\t\t\t    Sales[Amount] * 1.1
\t\t\t)
\t\tformatString: #,0
\t\tdisplayFolder: KPIs

\tmeasure 'Avg Sale' = AVERAGE ( Sales[Amount] )

\tmeasure 'New KPI' = DIVIDE ( [Total Sales], 2 )

\tcolumn Amount
\t\tdataType: decimal
\t\tsourceColumn: Amount

\tcolumn Region
\t\tdataType: string
\t\tisHidden

\tcolumn Margin = [Amount] * 0.2
\t\tdataType: double

\tpartition Sales = m
\t\tmode: import
\t\tsource =
\t\t\t\tlet
\t\t\t\t    Source = Sql.Database("dev", "db")
\t\t\t\tin
\t\t\t\t    Source
`,
  'tables/Customer.tmdl': "table Customer\n\tcolumn CustomerKey\n\t\tdataType: int64\n",
  'relationships.tmdl': "relationship r1\n\tisActive: false\n\tfromColumn: Sales.Region\n\ttoColumn: Customer.CustomerKey\n",
  'roles/North only.tmdl': "role 'North only'\n\tmodelPermission: read\n\ttablePermission Sales = [Region] = \"North\" || [Region] = \"East\"\n",
  'expressions.tmdl': 'expression Server = "dev" meta [IsParameterQuery=true]\n',
};

const zipOf = (files) => new Promise((resolve, reject) => {
  const a = new ZipArchive();
  const bufs = [];
  a.on('data', (d) => bufs.push(d)).on('end', () => resolve(Buffer.concat(bufs))).on('error', reject);
  for (const [name, data] of Object.entries(files)) a.append(data, { name });
  a.finalize();
});

let snap, cmp, checks, db, server, base;
before(async () => {
  snap = await import('../src/model/snapshot.js');
  cmp = await import('../src/model/compare.js');
  checks = await import('../src/model/checks.js');
  db = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); fakeApi?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ------------------------------------------------------------------ readers
test('reads model.bim: tables, columns, measures, relationships, roles, parameters', () => {
  const m = snap.fromBim(BIM_A);
  assert.deepEqual(Object.keys(m.tables).sort(), ['Customer', 'Sales'], 'auto date tables are skipped');
  assert.ok(!m.tables.Sales.columns['RowNumber-123'], 'row-number column skipped');
  assert.equal(m.tables.Sales.measures['Avg Sale'].expression, 'AVERAGE (\n    Sales[Amount]\n)');
  assert.match(m.tables.Sales.source, /Sql\.Database\("prod"/);
  assert.deepEqual(m.relationships['Sales[Region] → Customer[CustomerKey]'], { active: true, crossFilter: 'oneDirection', cardinality: 'many:one' });
  assert.equal(m.roles['North only'].filters.Sales, '[Region] = "North"');
  assert.deepEqual(snap.modelStats(m), { tables: 2, columns: 3, measures: 3, relationships: 1, roles: 1 });
});

test('reads a TMDL folder (zipped) including multi-line DAX and M', async () => {
  const m = snap.snapshotFromUpload(await zipOf(Object.fromEntries(Object.entries(TMDL_B).map(([k, v]) => [`MyReport.SemanticModel/definition/${k}`, v]))), 'model.zip');
  const s = m.tables.Sales;
  assert.equal(s.measures['Total Sales'].expression, 'SUMX (\n    Sales,\n    Sales[Amount] * 1.1\n)');
  assert.equal(s.measures['Total Sales'].displayFolder, 'KPIs');
  assert.equal(s.measures['New KPI'].expression, 'DIVIDE ( [Total Sales], 2 )');
  assert.equal(s.columns.Margin.expression, '[Amount] * 0.2');
  assert.equal(s.columns.Region.hidden, true);
  assert.match(s.source, /^let\n {4}Source = Sql\.Database\("dev", "db"\)\nin\n {4}Source$/);
  assert.equal(m.relationships['Sales[Region] → Customer[CustomerKey]'].active, false);
  assert.match(m.roles['North only'].filters.Sales, /"East"/);
  assert.match(m.parameters.Server, /"dev"/);
});

test('reads a .pbit template (UTF-16 DataModelSchema)', async () => {
  const schema = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(BIM_A), 'utf16le')]);
  const m = snap.snapshotFromUpload(await zipOf({ DataModelSchema: schema, Version: '1.28' }), 'Sales.pbit');
  assert.equal(snap.modelStats(m).measures, 3);
  assert.throws(() => snap.snapshotFromUpload(Buffer.from('not a model'), 'x.txt'), /Unsupported file/);
});

// ------------------------------------------------------------------ compare
test('compares two models: changed DAX, new/missing measures, M query, relationship, RLS, parameter', async () => {
  const A = snap.fromBim(BIM_A);
  const B = snap.fromTmdl(Object.entries(TMDL_B).map(([name, text]) => ({ name, text })));
  const { changes, counts } = cmp.compareModels(A, B);
  const find = (kind, name) => changes.find((c) => c.kind === kind && c.name === name);
  assert.deepEqual(find('measure', 'Total Sales').fields.map((f) => f.field), ['expression', 'displayFolder']);
  assert.equal(find('measure', 'Avg Sale'), undefined, 'reformatted DAX is not a change');
  assert.equal(find('measure', 'New KPI').change, 'added');
  assert.equal(find('measure', 'Old KPI').change, 'removed');
  assert.equal(find('column', 'Margin').change, 'added');
  assert.deepEqual(find('column', 'Region').fields.map((f) => f.field), ['hidden']);
  assert.ok(find('table', 'Sales').fields.some((f) => f.field === 'source'), 'Power Query source change');
  assert.deepEqual(find('relationship', 'Sales[Region] → Customer[CustomerKey]').fields.map((f) => f.field), ['active']);
  assert.ok(find('role', 'North only').fields[0].field.startsWith('filter:'));
  assert.equal(find('parameter', 'Server').change, 'changed');
  assert.equal(counts.added, 2);
  assert.equal(counts.removed, 1);
  assert.match(cmp.changeTitle(find('measure', 'Total Sales')), /^Measure \[Total Sales\] changed: DAX, Display folder$/);
  assert.equal(cmp.compareModels(A, snap.fromBim(BIM_A)).changes.length, 0, 'identical models');
});

// ------------------------------------------------------------------ Power BI API
test('reads the model through the Power BI REST API with a service principal', async () => {
  const seen = [];
  fakeApi = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization || ''}`);
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.url.startsWith('/login/tenant-1/oauth2/v2.0/token')) {
        assert.match(body, /grant_type=client_credentials/);
        assert.match(body, /scope=https%3A%2F%2Fanalysis\.windows\.net%2Fpowerbi%2Fapi%2F\.default/);
        return send(200, { access_token: 'sp-token', expires_in: 3600 });
      }
      if (req.url === '/api/groups/11111111-1111-1111-1111-111111111111/reports/22222222-2222-2222-2222-222222222222') return send(200, { name: 'Sales', datasetId: 'ds-1', datasetWorkspaceId: 'ws-9' });
      if (req.url === '/api/groups/ws-9/datasets/ds-1/executeQueries') {
        const q = JSON.parse(body).queries[0].query;
        const rows = {
          'EVALUATE INFO.VIEW.TABLES()': [{ '[Name]': 'Sales', '[IsHidden]': false }],
          'EVALUATE INFO.VIEW.COLUMNS()': [{ '[Name]': 'Amount', '[Table]': 'Sales', '[DataType]': 'Decimal', '[IsHidden]': false }],
          'EVALUATE INFO.VIEW.MEASURES()': [{ '[Name]': 'Total Sales', '[Table]': 'Sales', '[Expression]': 'SUM(Sales[Amount])', '[FormatString]': '#,0' }],
          'EVALUATE INFO.VIEW.RELATIONSHIPS()': [],
        }[q];
        if (!rows) return send(400, { error: { code: 'NoAdmin', message: 'Requires admin' } });
        return send(200, { results: [{ tables: [{ rows }] }] });
      }
      if (req.url === '/api/groups/ws-9/datasets/ds-1') return send(200, { name: 'Sales model' });
      if (req.url.startsWith('/api/groups/ws-9/datasets/ds-1/refreshes')) return send(200, { value: [{ endTime: '2026-11-08T05:00:00Z', status: 'Completed' }] });
      return send(404, { error: { code: 'NotFound' } });
    });
  });
  await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));
  const port = fakeApi.address().port;
  process.env.PBI_API_BASE = `http://127.0.0.1:${port}/api`;
  process.env.PBI_LOGIN_BASE = `http://127.0.0.1:${port}/login`;
  const url = 'https://app.powerbi.com/groups/11111111-1111-1111-1111-111111111111/reports/22222222-2222-2222-2222-222222222222/ReportSection1?experience=power-bi';
  const got = await checks.loadModel({ url }, { browserToken: async () => null, log: () => {} });
  assert.ok(got.snap, JSON.stringify(got));
  assert.equal(got.snap.tables.Sales.measures['Total Sales'].expression, 'SUM(Sales[Amount])');
  assert.equal(got.snap.meta.lastRefresh, '2026-11-08T05:00:00Z');
  assert.equal(got.snap.meta.rolesRead, false, 'roles need admin: skipped, not fatal');
  assert.match(got.snap.source, /service principal/);
  assert.ok(seen.filter((s) => s.includes('/api/')).every((s) => s.endsWith('Bearer sp-token')));

  const web = await checks.loadModel({ url: 'https://app.powerbi.com/view?r=abc' }, { browserToken: async () => 'x', log: () => {} });
  assert.match(web.unavailable, /publish-to-web/);
});

// ------------------------------------------------------------------ run checks
test('run checks record one result per model change, with the DAX diff', async () => {
  const dir = path.join(tmp, 'm');
  fs.mkdirSync(dir, { recursive: true });
  const pa = path.join(dir, 'a.json'), pb = path.join(dir, 'b.json');
  fs.writeFileSync(pa, JSON.stringify(snap.fromBim(BIM_A)));
  fs.writeFileSync(pb, JSON.stringify(snap.fromTmdl(Object.entries(TMDL_B).map(([name, text]) => ({ name, text })))));
  const rows = [];
  const r = await checks.runModelChecks({
    compare: true, log: () => {}, browserToken: async () => null, record: async (x) => rows.push(x),
    reports: { A: { url: 'x', modelPath: pa }, B: { url: 'y', modelPath: pb } },
  });
  assert.equal(r.compared, true);
  assert.equal(rows[0].target, 'model');
  assert.equal(rows[0].status, 'diff');
  const dax = rows.find((x) => x.title.startsWith('Measure [Total Sales] changed'));
  assert.equal(dax.status, 'diff');
  assert.ok(dax.details.data.ops.some((o) => o.op !== 'skip'), 'line diff of the DAX');
  assert.equal(rows.find((x) => x.title.startsWith('Measure [Old KPI]')).status, 'missing');
  const rel = rows.find((x) => x.details.model?.kind === 'relationship');
  assert.match(rel.details.note, /Active: true → false/);
  const fmtOnly = rows.find((x) => x.details.model?.name === 'Region');
  assert.equal(fmtOnly.details.data, undefined, 'no expression diff for a hidden-flag change');
});

// ------------------------------------------------------------------ upload route + summary
const api = (p, opts = {}) => fetch(base + p, { ...opts, headers: { Authorization: 'Bearer model-token-0123456789', ...(opts.headers || {}) } })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('model files are uploaded per report link and summarised in "What changed"', async () => {
  const id = db.insert('reports', { name: 'Sales DEV', url: 'https://app.powerbi.com/view?r=abc' });
  const bad = await api(`/api/reports/${id}/model?filename=notes.txt`, { method: 'POST', body: 'hello', headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(bad.status, 400);
  const up = await api(`/api/reports/${id}/model?filename=Sales.bim`, { method: 'POST', body: JSON.stringify(BIM_A), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.equal(up.json.model_file, 'Sales.bim');
  assert.equal(up.json.model_stats.measures, 3);
  assert.ok(fs.existsSync(path.join(tmp, 'models', `report-${id}.json`)));
  const meta = await api('/api/meta');
  assert.equal(meta.json.model.servicePrincipal, true);
  const audit = db.q.get("SELECT * FROM audit_log WHERE action = 'report.upload_model'");
  assert.ok(audit, 'audited');
  const del = await api(`/api/reports/${id}/model`, { method: 'DELETE' });
  assert.equal(del.json.model_file, null);
  assert.ok(!fs.existsSync(path.join(tmp, 'models', `report-${id}.json`)));

  // "What changed" picks up model results recorded for a run.
  const sid = db.insert('suites', { name: 'S', mode: 'compare', report_a_id: id, report_b_id: id, config: '{}' });
  const runId = db.insert('runs', { suite_id: sid, suite_name: 'S', trigger: 'manual', status: 'diffs', queued_at: new Date().toISOString(), snapshot: JSON.stringify({ reports: { A: { name: 'a' }, B: { name: 'b' } } }) });
  const add = (o, i) => db.insert('results', { run_id: runId, seq: i + 1, page: '', scenario: 'model', target: o.target, title: o.title, status: o.status, details: JSON.stringify(o.details), images: '{}', created_at: new Date().toISOString() });
  [{ target: 'model', title: 'Data model comparison', status: 'diff', details: { model: { stats: { A: { tables: 2 }, B: { tables: 2 } }, sources: { A: 'a', B: 'b' } } } },
    { target: 'model|measure|Sales|Total Sales', title: 'Measure [Total Sales] changed: DAX', status: 'diff', details: { model: { kind: 'measure', change: 'changed', name: 'Total Sales', table: 'Sales', label: '[Total Sales]', fields: [{ label: 'DAX' }] } } },
  ].forEach(add);
  const ch = await api(`/api/runs/${runId}/changes`);
  assert.equal(ch.status, 200);
  assert.equal(ch.json.report.model.compared, true);
  assert.equal(ch.json.report.model.changes.length, 1);
  assert.equal(ch.json.report.totals.modelChanges, 1);
  assert.match(ch.json.report.headline, /data model: 1 change/);
});
