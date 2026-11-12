/**
 * AI integration against a local OpenAI-compatible stand-in for NVIDIA's API
 * (integrate.api.nvidia.com). Verifies that the analysis is written from the
 * values of the two reports (exact before → after, worked-out differences) and
 * not from their pictures, the request shape (auth, models), tolerance of
 * reasoning traces / code fences / broken JSON, and storage.
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
      if (/Explain the value differences/.test(text)) {
        const seq = Number(/#(\d+) \[DIFF\] visual \| page: Overview \| Card · Total Sales/.exec(text)?.[1]);
        return reply(res, JSON.stringify({ changes: [{ resultRef: seq, whatChanged: 'Total Sales rose from 280,000 to 285,285.', details: ['280,000 → 285,285 (+1.89%)'], pattern: 'one value', severity: 'high', likelyCause: 'Newer data or a changed measure', confidence: 'medium' }, { resultRef: 99999, whatChanged: 'made up' }], links: [], assessment: 'One total moved.' }));
      }
      if (/Explain this one check/.test(text)) return reply(res, '{"whatChanged":"The button opens a different page in B.","details":[],"pattern":"not about values","severity":"medium","category":"interaction","likelyCause":"The button action was edited","confidence":"medium"}');
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

test('run analysis from the values, per-check explanation and Q&A end-to-end', { timeout: 300000 }, async () => {
  const { db, queue, ai } = mods;
  const base = `http://127.0.0.1:${fixture.address().port}/r`;
  const a = db.insert('reports', { name: 'A', url: `${base}?v=a` });
  const b = db.insert('reports', { name: 'B', url: `${base}?v=b` });
  const cfg = { pages: { include: ['Overview'] }, timing: { settleMs: 250 }, viewport: { width: 1400, height: 800 },
    // Appearance is compared here so the run also has checks that only look different.
    scenarios: { appearance: true, slicers: false, drill: false, crossFilter: false, tooltips: false, matrixExpand: false } };
  const sid = db.insert('suites', { name: 'ai', mode: 'compare', report_a_id: a, report_b_id: b, config: JSON.stringify(cfg) });
  const runId = queue.runQueue.enqueue(sid, 'test');
  assert.equal(await queue.runQueue.waitFor(runId), 'failed');
  const results = db.q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId);
  const card = results.find((r) => r.scenario === 'visual' && /Card · Total Sales/.test(r.title));
  const textOf = (r) => { const c = r.body.messages.at(-1).content; return typeof c === 'string' ? c : c.find((p) => p.type === 'text').text; };
  const hasImage = (r) => r.body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

  await ai.analyzeRun(runId);
  const out = ai.getRunAi(runId);
  assert.equal(out.summary.status, 'done', out.summary.error);
  assert.equal(out.summary.content.risk, 'high');
  assert.equal(out.summary.content.findings[0].resultRefs[0], 3);
  assert.equal(out.anomalies.status, 'done');
  assert.equal(out.anomalies.content.anomalies.length, 1);

  // No picture is sent: the analysis is written from the values.
  assert.ok(requests.length >= 3 && requests.every((r) => !hasImage(r)), 'no screenshot was sent to the AI');
  assert.ok(requests.every((r) => r.auth === 'Bearer nvapi-test-key' && r.path === '/v1/chat/completions'));
  const summaryReq = requests.find((r) => /Triage this validation run/.test(textOf(r)));
  assert.equal(summaryReq.body.model, 'nvidia/nemotron-3-ultra-550b-a55b');
  assert.match(textOf(summaryReq), /\[DIFF\] visual \| page: Overview \| Card · Total Sales/);
  // Exact before → after, with the difference worked out by the tool.
  assert.match(textOf(summaryReq), /280,000 → 285,285 \(Δ \+5,285, \+1\.89%\)/);
  assert.doesNotMatch(textOf(summaryReq), /pixels differ|differing pixels/);
  assert.match(summaryReq.body.messages[0].content, /Work from the VALUES, never from how something looks/);
  assert.ok(requests.some((r) => /not valid JSON/.test(JSON.stringify(r.body.messages.at(-1).content))), 'broken JSON triggered a repair request');

  // The value differences are explained visual by visual, and kept per check.
  const valuesReq = requests.find((r) => /Explain the value differences/.test(textOf(r)));
  assert.match(textOf(valuesReq), /280,000 → 285,285 \(Δ \+5,285, \+1\.89%\)/);
  assert.equal(out.values.status, 'done', out.values.error);
  assert.deepEqual(out.values.content.changes.map((c) => c.resultRef), [card.seq], 'an explanation for a check that was not sent is dropped');
  assert.equal(out.values.content.changes[0].visual, card.title);
  assert.equal(out.explain[card.id].status, 'done');
  assert.equal(out.explain[card.id].content.basis, 'values');
  assert.match(out.explain[card.id].content.whatChanged, /280,000 to 285,285/);
  // Asking again for a check that is explained already costs nothing.
  let sent = requests.length;
  assert.equal((await ai.explainResult(card.id)).id, out.explain[card.id].id);
  assert.equal(requests.length, sent);

  // A check that is not about values is explained from its facts, still without pictures.
  const other = results.find((r) => ['fail', 'missing', 'warn'].includes(r.status) && !out.explain[r.id] && r.scenario !== 'page_render');
  assert.ok(other, 'the run has a failing check besides the value differences');
  const ex = await ai.explainResult(other.id);
  assert.equal(ex.status, 'done');
  assert.equal(requests.length, sent + 1);
  assert.match(textOf(requests.at(-1)), /Explain this one check/);
  assert.ok(!hasImage(requests.at(-1)));

  // The page as a whole: explained by the values of its visuals.
  const pageCheck = results.find((r) => r.scenario === 'page_render' && r.status === 'diff');
  sent = requests.length;
  const px = await ai.explainResult(pageCheck.id);
  assert.equal(px.status, 'done');
  assert.equal(requests.length, sent + 1);
  assert.match(textOf(requests.at(-1)), /WHAT DIFFERS ON THIS PAGE[\s\S]*280,000 → 285,285/);
  assert.ok(!hasImage(requests.at(-1)));

  // An interaction is explained from the values it left in the other visuals.
  const drill = results.find((r) => r.scenario === 'drill_through' && r.status === 'diff');
  const dx = await ai.explainResult(drill.id);
  assert.equal(dx.content.basis, 'values');
  assert.match(textOf(requests.at(-1)), /afterwards in "Card · Orders"[\s\S]*12 → 13 \(Δ \+1, \+8\.33%\)/);
  assert.ok(!hasImage(requests.at(-1)));

  // Same values, different look: nothing to explain from the values, so nothing is sent.
  const look = db.insert('results', {
    run_id: runId, seq: 900, page: 'Overview', scenario: 'visual', target: 'look', title: 'Card · Same numbers, new colour', status: 'diff',
    diff_ratio: 0.04, diff_pixels: 1200, images: JSON.stringify({ a: card.images.a, b: card.images.b }),
    details: JSON.stringify({ data: { equal: true, added: 0, removed: 0, totalA: 3, totalB: 3, ops: [] } }),
  });
  sent = requests.length;
  const lx = await ai.explainResult(look);
  assert.equal(lx.content.basis, 'appearance');
  assert.match(lx.content.whatChanged, /values are identical/);
  assert.equal(requests.length, sent, 'a look-only difference costs no AI request');

  // Screenshots are looked at only when the suite asks for it, and only for look-only differences.
  await ai.analyzeRun(runId, { screenshots: true, maxVision: 5 });
  const shots = requests.filter(hasImage);
  assert.equal(shots.length, 1, 'only the check whose values match was sent as a picture');
  assert.equal(shots[0].body.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.match(shots[0].body.messages.at(-1).content.find((p) => p.type === 'image_url').image_url.url, /^data:image\/png;base64,iVBOR/);
  assert.match(textOf(shots[0]), /Same numbers, new colour[\s\S]*values read from both sides are identical/);
  assert.equal(ai.getRunAi(runId).explain[look].content.basis, 'screenshot');

  const ans = await ai.askRun(runId, 'What changed?', []);
  assert.match(ans.answer, /Total Sales/);
  assert.equal(ai.getRunAi(runId).chat.length, 1);

  // Export bundle carries the AI analysis.
  const { loadRunBundle, renderHtml } = await import('../src/jobs/export.js');
  const bundle = loadRunBundle(runId);
  assert.equal(bundle.ai.summary.content.headline, 'B changes sales figures and breaks navigation');
  assert.equal(bundle.ai.values.content.changes.length, 1);
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
