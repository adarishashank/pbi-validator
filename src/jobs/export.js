import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { q } from '../db.js';
import { runDir } from './queue.js';
import { getRunAi } from '../ai/analysis.js';

export function loadRunBundle(runId) {
  const run = q.get('SELECT * FROM runs WHERE id = ?', runId);
  if (!run) return null;
  const results = q.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', runId);
  const logs = q.all('SELECT ts, level, message FROM run_logs WHERE run_id = ? ORDER BY id', runId);
  const ai = getRunAi(runId);
  return { run, results, logs, ai: { summary: ai.summary, anomalies: ai.anomalies, values: ai.values, explain: ai.explain, chat: ai.chat } };
}

const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/** One-line, human-readable reason for a non-passing result. */
export function describe(r) {
  const d = r.details || {};
  if (r.status === 'accepted' && d.accepted) return `accepted as expected (was ${d.accepted.originalStatus})${d.accepted.note ? `: ${d.accepted.note}` : ''}`;
  const parts = [];
  if (d.note) parts.push(d.note);
  if (typeof d.error === 'string') parts.push(d.error.split('\n')[0]);
  if (d.missingIn) parts.push(`missing in ${d.missingIn}`);
  if (d.onlyInA?.length) parts.push(`pages only in A: ${d.onlyInA.join(', ')}`);
  if (d.onlyInB?.length) parts.push(`pages only in B: ${d.onlyInB.join(', ')}`);
  if (d.renamed?.length) parts.push(`renamed: ${d.renamed.map((x) => `${x.a} → ${x.b}`).join(', ')}`);
  if (d.orderChanged) parts.push('page order differs');
  if (d.issues?.length) parts.push(d.issues.slice(0, 5).map((i) => `${i.kind.replace(/_/g, ' ')}: ${i.visual}`).join('; '));
  if (d.data && !d.data.equal) parts.push(`data differs (+${d.data.added}/−${d.data.removed} lines)`);
  if (d.query && !d.query.equal) parts.push(`data behind the visual differs (+${d.query.added}/−${d.query.removed} rows)`);
  if (d.dataDiffs?.length) parts.push(`${d.dataDiffs.length} visual(s) with different data`);
  if (d.errors) {
    const errs = Object.entries(d.errors).flatMap(([s, list]) => list.map((e) => `${s}: ${e.visual} — ${e.error}`));
    if (errs.length) parts.push(errs.slice(0, 5).join('; '));
  }
  if (r.diff_ratio != null && r.diff_ratio > 0) parts.push(`${(r.diff_ratio * 100).toFixed(3)}% pixels differ`);
  return parts.join(' | ') || r.status;
}

export function junitXml(bundle) {
  const { run, results } = bundle;
  const groups = new Map();
  for (const r of results) {
    const k = r.page || 'Report';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const bad = (s) => ['diff', 'fail', 'missing', 'error'].includes(s);
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xmlEsc(run.suite_name)}" tests="${results.length}" failures="${results.filter((r) => bad(r.status)).length}" time="${((run.summary?.durationMs || 0) / 1000).toFixed(1)}">\n`;
  for (const [page, rs] of groups) {
    xml += `  <testsuite name="${xmlEsc(page)}" tests="${rs.length}" failures="${rs.filter((r) => bad(r.status)).length}" skipped="${rs.filter((r) => r.status === 'skipped').length}">\n`;
    for (const r of rs) {
      xml += `    <testcase classname="${xmlEsc(`${run.suite_name}.${r.scenario}`)}" name="${xmlEsc(r.title)}" time="${((r.duration_ms || 0) / 1000).toFixed(2)}">`;
      if (bad(r.status)) {
        xml += `<failure type="${r.status}" message="${xmlEsc(describe(r))}"/>`;
      } else if (r.status === 'skipped') xml += '<skipped/>';
      xml += '</testcase>\n';
    }
    xml += '  </testsuite>\n';
  }
  return `${xml}</testsuites>\n`;
}

/** Streams a zip containing a standalone HTML report, images and raw JSON. */
export function streamHtmlZip(bundle, res) {
  const { run } = bundle;
  const zip = new ZipArchive({ zlib: { level: 6 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="pbireporttest-run-${run.id}.zip"`);
  zip.on('error', (e) => res.destroy(e));
  zip.pipe(res);
  const dir = runDir(run.id);
  const data = { ...bundle, results: bundle.results.map((r) => ({ ...r, images: Object.fromEntries(Object.entries(r.images || {}).map(([k, f]) => [k, `images/${f}`])) })) };
  zip.append(renderHtml(data), { name: 'index.html' });
  zip.append(JSON.stringify(bundle, null, 2), { name: 'report.json' });
  if (fs.existsSync(dir)) {
    // PNGs are already compressed: store them (no deflate). Thumbnails are UI-only, not part of the export.
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.png') && !f.endsWith('.thumb.png')) zip.file(path.join(dir, f), { name: `images/${f}`, store: true });
  }
  zip.finalize();
}

/** Standalone interactive report. `topBar` is optional extra HTML shown above the header (published results site). */
export function renderHtml(data, { topBar = '' } = {}) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Power BI validation · ${xmlEsc(data.run.suite_name)} · run #${data.run.id}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#5f6b7a;--line:#e3e6ea;--pass:#1f883d;--diff:#bf8700;--fail:#cf222e;--miss:#8250df;--err:#bc4c00;--skip:#6e7781;--warn:#9a6700}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:#111827;color:#fff;padding:20px 28px}header h1{margin:0 0 4px;font-size:20px}header .sub{color:#cbd5e1}
main{padding:20px 28px;max-width:1500px;margin:auto}.chips{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.chip{padding:4px 10px;border-radius:999px;background:#fff;border:1px solid var(--line);font-weight:600}
.s-pass{color:var(--pass)}.s-diff{color:var(--diff)}.s-fail{color:var(--fail)}.s-missing{color:var(--miss)}.s-error{color:var(--err)}.s-skipped{color:var(--skip)}.s-accepted{color:#0369a1}.s-warn{color:var(--warn)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}select,input{padding:6px 8px;border:1px solid var(--line);border-radius:6px;font:inherit}
.page{margin:22px 0 8px;font-size:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:10px 0;padding:12px 14px}
.card h3{margin:0;font-size:14px;display:flex;gap:10px;align-items:center}.badge{font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:999px;border:1px solid currentColor}
.meta{color:var(--muted);font-size:12px;margin-top:2px}.imgs{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:10px}
figure{margin:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fafafa}figcaption{font-size:11px;font-weight:700;padding:4px 8px;border-bottom:1px solid var(--line)}
figure img{display:block;width:100%;cursor:zoom-in}table{border-collapse:collapse;width:100%;margin-top:8px;font:12px ui-monospace,Menlo,monospace}
td{border-top:1px solid var(--line);padding:2px 6px;vertical-align:top;white-space:pre-wrap;word-break:break-word}.add{background:#e6ffec}.del{background:#ffebe9}.chg{background:#fff8c5}
details summary{cursor:pointer;color:var(--muted);font-size:12px;margin-top:6px}pre{white-space:pre-wrap;font-size:12px;background:#f6f8fa;padding:8px;border-radius:6px}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:9;cursor:zoom-out}#lb img{max-width:96vw;max-height:94vh;background:#fff}
</style></head><body>
${topBar}<header><h1>${xmlEsc(data.run.suite_name)} — run #${data.run.id}</h1><div class="sub" id="sub"></div></header>
<main><div class="chips" id="chips"></div>
<div id="ai"></div>
<div class="filters"><select id="fs"><option value="">All statuses</option></select><select id="fc"><option value="">All scenarios</option></select><select id="fp"><option value="">All pages</option></select><input id="fq" placeholder="Search…"></div>
<div id="list"></div></main><div id="lb" onclick="this.style.display='none'"><img></div>
<script>
const D=${json};const R=D.results;const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const snap=D.run.snapshot||{};const rp=snap.reports||{};
$('#sub').textContent=[ 'Status: '+D.run.status.toUpperCase(), rp.A?'A: '+rp.A.name:'', rp.B?'B: '+rp.B.name:'', D.run.started_at?'Started '+new Date(D.run.started_at).toLocaleString():'', D.run.summary&&D.run.summary.durationMs?Math.round(D.run.summary.durationMs/1000)+'s':''].filter(Boolean).join('  ·  ');
const by=(k)=>[...new Set(R.map(r=>r[k]).filter(Boolean))];
const cnt={};R.forEach(r=>cnt[r.status]=(cnt[r.status]||0)+1);
const AI=D.ai||{};const S=AI.summary&&AI.summary.status==='done'?AI.summary.content:null;const AN=AI.anomalies&&AI.anomalies.status==='done'?AI.anomalies.content:null;
const VA=AI.values&&AI.values.status==='done'?AI.values.content:null;
if(S||AN||VA){let h='<div class="card" style="border-left:4px solid #6d28d9"><h3>🤖 AI analysis <span class="badge" style="color:#6d28d9">'+esc(S?S.risk:'')+' risk</span></h3><div class="meta">'+esc((AI.summary&&AI.summary.model)||'')+'</div>';
if(S){h+='<p><b>'+esc(S.headline)+'</b></p><p>'+esc(S.summary)+'</p>';if((S.findings||[]).length)h+='<table><tr><td><b>Severity</b></td><td><b>Finding</b></td></tr>'+S.findings.map(f=>'<tr><td>'+esc(f.severity)+'</td><td><b>'+esc(f.title)+'</b> — '+esc(f.explanation)+'<br><i>'+esc(f.recommendation||'')+'</i> '+(f.resultRefs||[]).map(x=>'#'+x).join(' ')+'</td></tr>').join('')+'</table>';
if((S.rootCauses||[]).length)h+='<details open><summary>Likely root causes</summary><ul>'+S.rootCauses.map(c=>'<li>'+esc(c.cause)+' ('+esc(c.confidence)+') — '+esc(c.evidence)+'</li>').join('')+'</ul></details>';
if((S.nextSteps||[]).length)h+='<details open><summary>Next steps</summary><ol>'+S.nextSteps.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ol></details>';}
if(VA&&(VA.changes||[]).length){h+='<details open><summary>Value differences explained ('+VA.changes.length+')</summary><p>'+esc(VA.assessment||'')+'</p><ul>'+VA.changes.map(c=>'<li><b>'+esc(c.visual)+'</b> ('+esc(c.page)+') #'+c.resultRef+': '+esc(c.whatChanged)+(c.likelyCause?' <i>Likely cause: '+esc(c.likelyCause)+'</i>':'')+'</li>').join('')+'</ul></details>';}
if(AN){h+='<details open><summary>Data anomalies ('+(AN.anomalies||[]).length+')</summary><p>'+esc(AN.assessment||'')+'</p><ul>'+(AN.anomalies||[]).map(a=>'<li><b>'+esc(a.severity)+'</b> '+esc(a.page)+' · '+esc(a.visual)+': '+esc(a.issue)+' <i>'+esc(a.evidence)+'</i></li>').join('')+'</ul></details>';}
$('#ai').innerHTML=h+'</div>';}
const VIS=AI.explain||AI.vision||{};
$('#chips').innerHTML=Object.entries(cnt).map(([s,n])=>'<span class="chip s-'+s+'">'+s+': '+n+'</span>').join('');
by('status').forEach(s=>$('#fs').insertAdjacentHTML('beforeend','<option>'+esc(s)+'</option>'));
by('scenario').forEach(s=>$('#fc').insertAdjacentHTML('beforeend','<option>'+esc(s)+'</option>'));
by('page').forEach(s=>$('#fp').insertAdjacentHTML('beforeend','<option>'+esc(s)+'</option>'));
const LBL={a:'A · '+(rp.A?rp.A.name:'report'),b:'B · '+(rp.B?rp.B.name:'report'),diff:'Pixel diff',annotated:'B with differences outlined'};
function ops(d){if(!d||!d.ops||d.equal)return'';return'<table>'+d.ops.map(o=>o.op==='skip'?'<tr><td colspan=2 style="color:#888">… '+o.count+' identical lines …</td></tr>':'<tr class="'+o.op+'"><td>'+esc(o.a??'')+'</td><td>'+esc(o.b??'')+'</td></tr>').join('')+'</table>';}
function card(r){const d=r.details||{};let h='<div class="card"><h3><span class="badge s-'+r.status+'">'+r.status+'</span>'+esc(r.title)+'</h3><div class="meta">'+esc(r.scenario)+(r.diff_ratio!=null?' · '+(r.diff_ratio*100).toFixed(3)+'% pixels differ':'')+(d.note?' · '+esc(d.note):'')+'</div>';
const im=Object.entries(r.images||{});if(im.length)h+='<div class="imgs">'+im.map(([k,f])=>'<figure><figcaption>'+esc(LBL[k]||k)+'</figcaption><img loading="lazy" src="'+f+'"></figure>').join('')+'</div>';
const v=VIS[r.id];if(v&&v.status==='done')h+='<div class="meta" style="color:#6d28d9;margin-top:8px">🤖 '+esc(v.content.whatChanged)+(v.content.likelyCause?' Likely cause: '+esc(v.content.likelyCause):'')+'</div>';
if(d.data&&!d.data.equal)h+='<details open><summary>Data differences (+'+d.data.added+' / −'+d.data.removed+')</summary>'+ops(d.data)+'</details>';
if(d.query&&!d.query.equal)h+='<details open><summary>Data behind the visual differs (+'+d.query.added+' / −'+d.query.removed+' rows, unrounded)</summary>'+ops(d.query)+'</details>';
if(d.dataDiffs&&d.dataDiffs.length)h+='<details><summary>'+d.dataDiffs.length+' visual(s) with different data after the interaction</summary>'+d.dataDiffs.map(x=>'<div><b>'+esc(x.visual)+'</b>'+(x.only?' — only in '+x.only:'')+ops({ops:x.ops||[]})+'</div>').join('')+'</details>';
if(d.issues&&d.issues.length)h+='<details open><summary>'+d.issues.length+' structural issue(s)</summary><pre>'+esc(d.issues.map(i=>i.kind+': '+i.visual+(i.a!==undefined?'  A='+JSON.stringify(i.a)+'  B='+JSON.stringify(i.b):'')).join('\\n'))+'</pre></details>';
h+='<details><summary>Raw details</summary><pre>'+esc(JSON.stringify(d,null,2))+'</pre></details></div>';return h;}
function render(){const s=$('#fs').value,c=$('#fc').value,p=$('#fp').value,t=$('#fq').value.toLowerCase();let last=null,h='';
R.filter(r=>(!s||r.status===s)&&(!c||r.scenario===c)&&(!p||r.page===p)&&(!t||(r.title+' '+r.page).toLowerCase().includes(t))).forEach(r=>{if(r.page!==last){last=r.page;h+='<h2 class="page">'+esc(r.page||'Report')+'</h2>';}h+=card(r);});
$('#list').innerHTML=h||'<p>No results match.</p>';}
['#fs','#fc','#fp','#fq'].forEach(id=>$(id).addEventListener('input',render));
document.addEventListener('click',e=>{if(e.target.matches('figure img')){$('#lb img').src=e.target.src;$('#lb').style.display='flex';}});
render();
</script></body></html>`;
}
