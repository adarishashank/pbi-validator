/**
 * AI integration against a local OpenAI-compatible stand-in for NVIDIA's API
 * (integrate.api.nvidia.com). Verifies request shape (auth, models, images),
 * tolerance of reasoning traces / code fences / broken JSON, and storage.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbiv-ai-'));
const requests = [];
let mock, fixture, mods;

function reply(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: 'mock', choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 42 } }));
}

before(async () => {
  let brokenOnce = true;
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      requests.push({ auth: req.headers.authorization, path: req.url, body: j });
      const last = j.messages.at(-1);
      const all = j.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.find((p) => p.type === 'text').text)).join('\n');
      const text = /not valid JSON/.test(all) && /Triage this validation run/.test(all) ? 'Triage this validation run' : (typeof last.content === 'string' ? last.content : '');
      if (Array.isArray(last.content)) return reply(res, '{"whatChanged":"Total Sales card shows 285,285 in B instead of 280,000","details":["value increased by 5,285"],"severity":"high","category":"data","likelyNoise":false,"confidence":"high"}');
      if (/Triage this validation run/.test(text)) {
        if (brokenOnce) { brokenOnce = false; return reply(res, '<think>reasoning…</think>Here you go: {"headline": broken'); }
        return reply(res, '<think>let me think</think>```json\n{"headline":"B changes sales figures and breaks navigation","risk":"high","summary":"Totals differ.","rootCauses":[{"cause":"Measure change","confidence":"medium","evidence":"card","resultRefs":[3]}],"findings":[{"title":"Total Sales differs","severity":"high","category":"data","explanation":"x","recommendation":"y","resultRefs":[3]}],"noise":[],"nextSteps":["Check DAX"]}\n```');
      }
      if (/data-quality reviewer/.test(text)) return reply(res, '{"anomalies":[{"page":"Overview","visual":"Total Sales","severity":"medium","issue":"Total not equal to sum of regions","evidence":"285,285 vs 285","resultRefs":[3]}],"reconciliation":[],"assessment":"One inconsistency."}');
      return reply(res, 'The **Total Sales** card changed — see #3.');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const page = fs.readFileSync(new URL('./fixtures/mock-report.html', import.meta.url));
  fixture = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(page); });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));

  Object.assign(process.env, {
    DATA_DIR: tmp, LOG_LEVEL: 'warn', NVIDIA_API_KEY: 'nvapi-test-key',
    AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, AI_AUTO_ANALYZE: 'false',
  });
  mods = {
    db: await import('../src/db.js'),
    queue: await import('../src/jobs/queue.js'),
    ai: await import('../src/ai/analysis.js'),
    client: await import('../src/ai/client.js'),
  };
});
after(() => { mock.close(); fixture.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('parseJsonLoose handles reasoning traces, fences and prose', async () => {
  const { parseJsonLoose } = await import('../src/ai/client.js');
  assert.deepEqual(parseJsonLoose('<think>hmm {not json}</think>```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! {"a":{"b":"x}y"}} trailing'), { a: { b: 'x}y' } });
  assert.throws(() => parseJsonLoose('no json here'));
});

test('run analysis, vision explanation and Q&A end-to-end', { timeout: 300000 }, async () => {
  const { db, queue, ai } = mods;
  const base = `http://127.0.0.1:${fixture.address().port}/r`;
  const a = db.insert('reports', { name: 'A', url: `${base}?v=a` });
  const b = db.insert('reports', { name: 'B', url: `${base}?v=b` });
  const cfg = { pages: { include: ['Overview'] }, timing: { settleMs: 250 }, viewport: { width: 1400, height: 800 },
    scenarios: { slicers: false, drill: false, crossFilter: false, tooltips: false, matrixExpand: false } };
  const sid = db.insert('suites', { name: 'ai', mode: 'compare', report_a_id: a, report_b_id: b, config: JSON.stringify(cfg) });
  const runId = queue.runQueue.enqueue(sid, 'test');
  assert.equal(await queue.runQueue.waitFor(runId), 'failed');

  await ai.analyzeRun(runId, { vision: true, maxVision: 2 });
  const out = ai.getRunAi(runId);
  assert.equal(out.summary.status, 'done', out.summary.error);
  assert.equal(out.summary.content.risk, 'high');
  assert.equal(out.summary.content.findings[0].resultRefs[0], 3);
  assert.equal(out.anomalies.status, 'done');
  assert.equal(out.anomalies.content.anomalies.length, 1);
  const visions = Object.values(out.vision);
  assert.equal(visions.length, 2);
  assert.ok(visions.every((v) => v.status === 'done' && /285,285/.test(v.content.whatChanged)));

  // Request contract: bearer key, configured models, digest content, PNG image part.
  assert.ok(requests.every((r) => r.auth === 'Bearer nvapi-test-key' && r.path === '/v1/chat/completions'));
  const summaryReq = requests.find((r) => /Triage this validation run/.test(r.body.messages.at(-1).content));
  assert.equal(summaryReq.body.model, 'nvidia/nemotron-3-ultra-550b-a55b');
  assert.match(summaryReq.body.messages.at(-1).content, /\[DIFF\] visual \| page: Overview \| Card · Total Sales/);
  assert.match(summaryReq.body.messages.at(-1).content, /"280,000" → "285,285"/);
  const visionReq = requests.find((r) => Array.isArray(r.body.messages.at(-1).content));
  assert.equal(visionReq.body.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.match(visionReq.body.messages.at(-1).content.find((p) => p.type === 'image_url').image_url.url, /^data:image\/png;base64,iVBOR/);
  assert.ok(requests.some((r) => /not valid JSON/.test(JSON.stringify(r.body.messages.at(-1).content))), 'broken JSON triggered a repair request');

  const ans = await ai.askRun(runId, 'What changed?', []);
  assert.match(ans.answer, /Total Sales/);
  assert.equal(ai.getRunAi(runId).chat.length, 1);

  // Export bundle carries the AI analysis.
  const { loadRunBundle, renderHtml } = await import('../src/jobs/export.js');
  const bundle = loadRunBundle(runId);
  assert.equal(bundle.ai.summary.content.headline, 'B changes sales figures and breaks navigation');
  assert.match(renderHtml(bundle), /AI analysis/);
});

test('upstream auth errors surface as 502 with a hint', async () => {
  const { chat } = mods.client;
  const srv = http.createServer((q, r) => { r.writeHead(401); r.end('{"error":"invalid key"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { config } = await import('../src/config.js');
  const prev = config.ai.baseUrl;
  config.ai.baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
  await assert.rejects(chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }), (e) => e.status === 502 && /NVIDIA_API_KEY/.test(e.message));
  config.ai.baseUrl = prev;
  srv.close();
});
