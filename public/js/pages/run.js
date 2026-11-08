import { html, useState, useEffect, useMemo, useRef, useCallback, api, go, downloadFile, fmtDate, fmtDur, runDuration, pct, setStore, STATUS_ORDER, STATUS_LABEL, SCENARIO_LABEL } from '../lib.js';
import { Badge, Progress, Modal, Menu, act, confirmDialog, zoom, Spinner } from '../ui.js';
import { Topbar } from './common.js';
import { AiInsights, AiChat, VisionPanel } from './ai.js';
import { PublishControl } from './publish.js';

const PROBLEM = new Set(['fail', 'error', 'missing', 'diff', 'warn']);
const img = (runId, f) => `/artifacts/runs/${runId}/${f}`;

// ------------------------------------------------------------ comparison
function Swipe({ a, b }) {
  const [pos, setPos] = useState(50);
  const [w, setW] = useState(0);
  return html`<div class="swipe">
    <img src=${b} alt="B" onLoad=${(e) => setW(e.target.clientWidth)} />
    <div class="top" style=${`width:${pos}%`}><img src=${a} alt="A" style=${w ? `width:${w}px` : ''} /></div>
    <span class="lbl" style="left:6px">A</span><span class="lbl" style="right:6px">B</span>
    <input type="range" min="0" max="100" value=${pos} onInput=${(e) => setPos(Number(e.target.value))} aria-label="Swipe between A and B" />
  </div>`;
}

const Fig = ({ src, cap, badge }) => html`<div class="fig"><div class="cap">${cap}${badge}</div><img src=${src} onClick=${() => zoom(src)} alt=${cap} loading="lazy" /></div>`;

function DiffTable({ data, aLabel = 'A', bLabel = 'B' }) {
  if (!data?.ops?.length) return null;
  return html`<table class="dt"><thead><tr><th>${aLabel}</th><th>${bLabel}</th></tr></thead><tbody>
    ${data.ops.map((o) => (o.op === 'skip'
      ? html`<tr class="skip"><td colspan="2">… ${o.count} identical line(s) …</td></tr>`
      : html`<tr class=${o.op}><td>${o.a ?? ''}</td><td>${o.b ?? ''}</td></tr>`))}
  </tbody></table>`;
}

function Outcome({ o, name }) {
  if (!o) return html`<span class="muted">—</span>`;
  return html`<span><b>${name}:</b> ${o.popups?.length ? `opened ${o.popups.join(', ')}` : o.navigated ? `navigated to page “${o.page}”` : 'stayed on the same page'}</span>`;
}

function ResultView({ r, run, ai, reloadAi }) {
  const d = r.details || {};
  const im = r.images || {};
  const names = run.snapshot?.reports || {};
  const capA = `A · ${names.A?.name || 'report A'}`, capB = `B · ${names.B?.name || 'report B'}`;
  const hasPair = im.a && im.b;
  const [mode, setMode] = useState(hasPair ? 'side' : 'single');
  const M = (id, label, dis) => html`<button class="btn sm ${mode === id ? 'on' : ''}" disabled=${dis} onClick=${() => setMode(id)}>${label}</button>`;

  return html`<div class="stack">
    <div class="row">
      <${Badge} s=${r.status} /><span class="tag">${SCENARIO_LABEL[r.scenario] || r.scenario}</span>
      ${r.page && html`<span class="muted">Page: <b>${r.page}</b></span>`}
      ${r.diff_ratio != null && html`<span class="muted">· ${pct(r.diff_ratio)} pixels differ (${(r.diff_pixels || 0).toLocaleString()} px${d.pixel?.regions ? `, ${d.pixel.regions} region(s)` : ''})</span>`}
      ${r.duration_ms != null && html`<span class="muted">· ${fmtDur(r.duration_ms)}</span>`}
    </div>
    ${d.note && html`<div class="callout ${r.status === 'fail' ? 'err' : 'warn'}">${d.note}</div>`}
    ${d.error && typeof d.error === 'string' && html`<div class="callout err"><pre style="margin:0;white-space:pre-wrap">${d.error}</pre></div>`}
    ${d.missingIn && html`<div class="callout err">This ${r.scenario === 'page_render' ? 'page' : 'visual'} does not exist in report ${d.missingIn}.</div>`}

    ${hasPair && html`<div class="row"><div class="btn-group">${M('side', 'Side by side')}${M('swipe', 'Swipe')}${M('diff', 'Pixel diff', !im.diff)}${M('annot', 'Outlined differences', !im.annotated)}</div>
      ${d.pixel?.sizeMismatch && html`<span class="badge b-diff">size ${d.pixel.sizeA.w}×${d.pixel.sizeA.h} vs ${d.pixel.sizeB.w}×${d.pixel.sizeB.h}</span>`}</div>`}
    ${mode === 'side' && hasPair && html`<div class="cmp-grid"><${Fig} src=${img(run.id, im.a)} cap=${capA} /><${Fig} src=${img(run.id, im.b)} cap=${capB} />
      ${im.annotated && html`<${Fig} src=${img(run.id, im.annotated)} cap="B with differences outlined" />`}</div>`}
    ${mode === 'swipe' && hasPair && html`<${Swipe} a=${img(run.id, im.a)} b=${img(run.id, im.b)} />`}
    ${mode === 'diff' && im.diff && html`<${Fig} src=${img(run.id, im.diff)} cap="Pixel diff (red = different)" />`}
    ${mode === 'annot' && im.annotated && html`<${Fig} src=${img(run.id, im.annotated)} cap="B with differing regions outlined" />`}
    ${!hasPair && (im.a || im.b) && html`<div class="cmp-grid">${im.a && html`<${Fig} src=${img(run.id, im.a)} cap=${capA} />`}${im.b && html`<${Fig} src=${img(run.id, im.b)} cap=${capB} />`}</div>`}

    <${VisionPanel} result=${r} ai=${ai} onUpdated=${reloadAi} />
    ${d.outcome && html`<div class="panel panel-b stack" style="gap:4px"><b>Button outcome</b><${Outcome} o=${d.outcome.A} name="A" />${d.outcome.B && html`<${Outcome} o=${d.outcome.B} name="B" />`}</div>`}
    ${d.value && html`<div class="muted">Slicer value applied: <b>${d.value}</b></div>`}
    ${d.dataPoint && html`<div class="muted">Data point clicked: A <code>${d.dataPoint.A}</code>${d.dataPoint.B !== undefined ? html` · B <code>${d.dataPoint.B}</code>` : ''}</div>`}

    ${d.data && !d.data.equal && html`<div><h3 style="margin-bottom:6px">Data differences <span class="muted small">(+${d.data.added} / −${d.data.removed} lines)</span></h3><${DiffTable} data=${d.data} aLabel=${capA} bLabel=${capB} /></div>`}
    ${d.data?.equal && html`<div class="small" style="color:var(--pass)">✔ Extracted data identical (${d.data.totalA} lines)</div>`}
    ${d.dataDiffs && (d.dataDiffs.length ? html`<div><h3 style="margin-bottom:6px">${d.dataDiffs.length} visual(s) show different data after this interaction</h3>
      ${d.dataDiffs.map((x) => html`<details open=${d.dataDiffs.length <= 3} style="margin-bottom:6px"><summary><b>${x.visual}</b> ${x.only ? html`<${Badge} s="missing" label=${`only in ${x.only}`} />` : html`<span class="muted small">+${x.added} / −${x.removed}</span>`}</summary>${x.ops && html`<${DiffTable} data=${{ ops: x.ops }} aLabel=${capA} bLabel=${capB} />`}</details>`)}</div>`
      : html`<div class="small" style="color:var(--pass)">✔ All visuals show identical data after the interaction</div>`)}
    ${d.issues?.length > 0 && html`<div><h3 style="margin-bottom:6px">Structural issues</h3><table class="t"><thead><tr><th>Issue</th><th>Visual</th><th>A</th><th>B</th></tr></thead><tbody>
      ${d.issues.map((i) => html`<tr><td><${Badge} s=${i.kind.startsWith('missing') || i.kind.startsWith('extra') ? 'missing' : 'diff'} label=${i.kind.replace(/_/g, ' ')} /></td><td>${i.visual}</td>
        <td class="mono">${i.a === undefined ? '' : typeof i.a === 'object' ? `${i.a.x},${i.a.y} ${i.a.w}×${i.a.h}` : String(i.a)}</td><td class="mono">${i.b === undefined ? '' : typeof i.b === 'object' ? `${i.b.x},${i.b.y} ${i.b.w}×${i.b.h}` : String(i.b)}</td></tr>`)}</tbody></table></div>`}
    ${d.errors && Object.values(d.errors).some((e) => e.length) && html`<div><h3 style="margin-bottom:6px">Visual errors</h3>${Object.entries(d.errors).map(([side, errs]) => errs.map((e) => html`<div class="small"><b>${side}</b> · ${e.visual}: <span style="color:var(--fail)">${e.error}</span></div>`))}</div>`}
    ${(d.linesA || d.lines) && !d.data && html`<details><summary>Extracted content</summary><pre class="json">${(d.linesA || d.lines).join('\n')}</pre></details>`}
    ${d.pagesA && html`<div class="grid g2"><div><b>Pages in A</b><ol>${d.pagesA.map((p) => html`<li style=${d.onlyInA.includes(p) ? 'color:var(--missing);font-weight:600' : ''}>${p}</li>`)}</ol></div>
      ${d.pagesB && html`<div><b>Pages in B</b><ol>${d.pagesB.map((p) => html`<li style=${d.onlyInB.includes(p) ? 'color:var(--missing);font-weight:600' : ''}>${p}</li>`)}</ol></div>`}</div>
      ${d.renamed?.length > 0 && html`<div class="callout warn">Renamed: ${d.renamed.map((x) => `“${x.a}” → “${x.b}”`).join(', ')}</div>`}
      ${d.orderChanged && html`<div class="callout warn">Page order differs between A and B.</div>`}`}
    <details><summary class="small muted">Raw details (JSON)</summary><pre class="json">${JSON.stringify(d, null, 2)}</pre></details>
  </div>`;
}

function ResultModal({ list, index, run, onClose, loadAi }) {
  const [i, setI] = useState(index);
  const [ai, setAi] = useState(null);
  const reloadAi = useCallback(async () => { try { setAi(await loadAi()); } catch { /* ignore */ } }, [loadAi]);
  useEffect(() => { reloadAi(); }, [reloadAi]);
  const r = list[i];
  useEffect(() => {
    const k = (e) => {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowRight' || e.key === 'j') setI((x) => Math.min(list.length - 1, x + 1));
      if (e.key === 'ArrowLeft' || e.key === 'k') setI((x) => Math.max(0, x - 1));
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [list.length]);
  if (!r) return null;
  return html`<${Modal} size="full" title=${r.title} onClose=${onClose} footer=${html`
    <span class="muted small" style="margin-right:auto">${i + 1} / ${list.length} · <kbd>←</kbd> <kbd>→</kbd> to navigate</span>
    <button class="btn" disabled=${i === 0} onClick=${() => setI(i - 1)}>‹ Previous</button>
    <button class="btn" disabled=${i === list.length - 1} onClick=${() => setI(i + 1)}>Next ›</button>`}>
    <${ResultView} key=${r.id} r=${r} run=${run} ai=${ai} reloadAi=${reloadAi} /></${Modal}>`;
}

// ---------------------------------------------------------------- export
const EXPORTS = {
  pdf: { path: (id) => `/runs/${id}/report.pdf?download=1`, busy: 'Building the PDF report…' },
  xlsx: { path: (id) => `/runs/${id}/export.xlsx`, busy: 'Building the Excel workbook…' },
  zip: { path: (id) => `/runs/${id}/export.zip`, busy: 'Packing the HTML report…' },
  json: { path: (id) => `/runs/${id}/export.json` },
  junit: { path: (id) => `/runs/${id}/junit.xml` },
};
export const exportRun = (id, kind) => downloadFile(EXPORTS[kind].path(id), { busy: EXPORTS[kind].busy || 'Preparing download…' });
const exportItems = (id) => [
  { icon: '📄', label: 'PDF report', desc: 'Summary, AI analysis, issues with screenshots, all checks', onClick: () => exportRun(id, 'pdf') },
  { icon: '📊', label: 'Excel workbook (.xlsx)', desc: 'Every check, AI findings and Q&A in sheets', onClick: () => exportRun(id, 'xlsx') },
  { icon: '🌐', label: 'Interactive HTML (.zip)', desc: 'Offline report with all screenshots', onClick: () => exportRun(id, 'zip') },
  'divider',
  { icon: '{ }', label: 'JSON', desc: 'Raw data for scripts', onClick: () => exportRun(id, 'json') },
  { icon: '✓', label: 'JUnit XML', desc: 'For CI test dashboards', onClick: () => exportRun(id, 'junit') },
];

// ------------------------------------------------------------------ page
export function RunDetail({ id }) {
  const [run, setRun] = useState(null);
  const [results, setResults] = useState([]);
  const [logs, setLogs] = useState([]);
  const [ai, setAi] = useState(null);
  const loadAi = useCallback(() => api(`/runs/${id}/ai`), [id]);
  const reloadAi = useCallback(async () => { try { setAi(await loadAi()); } catch { /* ignore */ } }, [loadAi]);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('results');
  const [f, setF] = useState({ status: '', scenario: '', page: '', q: '', problems: false });
  const logRef = useRef(null);
  const live = run && ['queued', 'running'].includes(run.status);

  const loadAll = useCallback(async () => {
    try {
      const [r, rs, lg] = await Promise.all([api(`/runs/${id}`), api(`/runs/${id}/results`), api(`/runs/${id}/logs`)]);
      setRun(r); setResults(rs); setLogs(lg);
      if (!['queued', 'running'].includes(r.status) && rs.some((x) => PROBLEM.has(x.status))) setF((x) => ({ ...x, problems: true }));
    } catch (e) { setErr(e.message); }
  }, [id]);
  useEffect(() => { loadAll(); reloadAi(); }, [loadAll, reloadAi]);
  // Poll while AI analysis is running.
  useEffect(() => {
    if (!ai?.running && ai?.summary?.status !== 'running') return undefined;
    const t = setInterval(reloadAi, 3000);
    return () => clearInterval(t);
  }, [ai, reloadAi]);

  // Live updates while running.
  useEffect(() => {
    if (!live) return undefined;
    const es = new EventSource(`/api/runs/${id}/events`);
    let pending = false;
    es.addEventListener('progress', (e) => { const d = JSON.parse(e.data); setRun((r) => r && ({ ...r, status: 'running', progress: d.progress, phase: d.phase, summary: d.counts })); });
    es.addEventListener('log', (e) => { const d = JSON.parse(e.data); setLogs((l) => [...l.slice(-4000), { id: `${Date.now()}${Math.random()}`, ...d }]); });
    es.addEventListener('result', () => {
      if (pending) return;
      pending = true;
      setTimeout(async () => { pending = false; try { setResults(await api(`/runs/${id}/results`)); } catch { /* ignore */ } }, 1500);
    });
    es.addEventListener('done', () => { es.close(); setTimeout(() => { loadAll(); reloadAi(); }, 300); });
    const t = setInterval(async () => { try { const r = await api(`/runs/${id}`); setRun((x) => ({ ...x, ...r })); if (!['queued', 'running'].includes(r.status)) loadAll(); } catch { /* ignore */ } }, 8000);
    return () => { es.close(); clearInterval(t); };
  }, [id, live, loadAll, reloadAi]);

  useEffect(() => { if (tab === 'logs' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs, tab]);

  const pages = useMemo(() => [...new Set(results.map((r) => r.page))], [results]);
  const scenarios = useMemo(() => [...new Set(results.map((r) => r.scenario))], [results]);
  const counts = useMemo(() => results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {}), [results]);
  const filtered = useMemo(() => results.filter((r) => (!f.status || r.status === f.status) && (!f.scenario || r.scenario === f.scenario)
    && (f.page === '' || r.page === f.page) && (!f.problems || PROBLEM.has(r.status))
    && (!f.q || `${r.title} ${r.page} ${r.target}`.toLowerCase().includes(f.q.toLowerCase()))), [results, f]);
  const byScenario = useMemo(() => {
    const m = {};
    for (const r of results) { m[r.scenario] ??= {}; m[r.scenario][r.status] = (m[r.scenario][r.status] || 0) + 1; }
    return m;
  }, [results]);

  if (err) return html`<div class="content"><div class="callout err">${err}</div></div>`;
  if (!run) return html`<div class="content"><${Spinner} /></div>`;
  const snap = run.snapshot || {};
  const reps = snap.reports || {};
  const openResult = (r, list = filtered) => setStore({ modal: html`<${ResultModal} list=${list} index=${Math.max(0, list.indexOf(r))} run=${run} loadAi=${loadAi} onClose=${() => { setStore({ modal: null }); reloadAi(); }} />` });
  const openRef = (seq) => { const r = results.find((x) => x.seq === seq); if (r) openResult(r, results); };
  const cancel = async () => { if (await confirmDialog({ title: 'Cancel run?', message: 'Stop this run? Results captured so far are kept.', okLabel: 'Cancel run', danger: true })) { await act(() => api(`/runs/${id}/cancel`, { method: 'POST' }), 'Cancelling…'); } };
  const rerun = async () => { const r = await act(() => api(`/runs/${id}/rerun`, { method: 'POST' }), 'Run queued'); if (r) go(`/runs/${r.runId}`); };
  const del = async () => { if (await confirmDialog({ title: 'Delete run?', message: `Delete run #${id} and all its screenshots?`, okLabel: 'Delete', danger: true })) { const ok = await act(() => api(`/runs/${id}`, { method: 'DELETE' }), 'Run deleted'); if (ok !== undefined) go('/runs'); } };

  let lastPage = null;
  return html`
    <${Topbar} title=${html`Run #${run.id} · ${run.suite_name}`} sub=${html`<span class="row" style="gap:8px"><${Badge} s=${run.status} /><span>${run.trigger}${run.triggered_by ? ` by ${run.triggered_by}` : ''}</span><span>· started ${fmtDate(run.started_at || run.queued_at)}</span><span>· ${runDuration(run)}</span></span>`}>
      ${live && html`<button class="btn ed danger" onClick=${cancel}>Cancel</button>`}
      ${!live && run.suite_id && html`<button class="btn ed" onClick=${rerun}>↻ Re-run</button>`}
      ${!live && html`<button class="btn primary" onClick=${() => exportRun(id, 'pdf')}>⇩ Download PDF</button>
        <${Menu} label="Export" items=${exportItems(id)} />
        <${PublishControl} run=${run} />
        <button class="btn ed ghost danger" onClick=${del}>Delete</button>`}
    </${Topbar}>
    <div class="content stack">
      <div class="panel panel-b stack" style="gap:10px">
        <div class="vs"><span class="side-pill" title=${reps.A?.url}><b>A</b>${reps.A?.name}${reps.A?.environment ? ` · ${reps.A.environment}` : ''}</span>
          ${reps.B && html`<span>⇄</span><span class="side-pill" title=${reps.B?.url}><b>B</b>${reps.B.name}${reps.B.environment ? ` · ${reps.B.environment}` : ''}</span>`}
          <span class="spacer"></span>${run.summary?.loadMs && html`<span class="small muted">Load: ${Object.entries(run.summary.loadMs).map(([k, v]) => `${k} ${fmtDur(v)}`).join(' · ')}</span>`}</div>
        ${live && html`<div><div class="row small" style="margin-bottom:6px"><${Spinner} /><b>${run.phase || 'Starting'}</b><span class="spacer"></span>${Math.round((run.progress || 0) * 100)}%</div><${Progress} value=${run.progress} /></div>`}
        ${run.error && html`<div class="callout err">✖ <div>${run.error}${/sign-in|expired/i.test(run.error) ? html` — <a href="#/profiles">open Power BI sign-ins</a>` : ''}</div></div>`}
        <div class="row">
          <span class="chip ${!f.status && !f.problems ? 'on' : ''}" onClick=${() => setF({ ...f, status: '', problems: false })}>All <span class="n">${results.length}</span></span>
          <span class="chip ${f.problems && !f.status ? 'on' : ''}" onClick=${() => setF({ ...f, status: '', problems: true })}>Problems <span class="n">${results.filter((r) => PROBLEM.has(r.status)).length}</span></span>
          ${STATUS_ORDER.filter((s) => counts[s]).map((s) => html`<span class="chip ${f.status === s ? 'on' : ''}" onClick=${() => setF({ ...f, status: f.status === s ? '' : s, problems: false })}><span class="badge b-${s}">${STATUS_LABEL[s]}</span><span class="n">${counts[s]}</span></span>`)}
        </div>
      </div>

      <div class="tabs" style="margin:0">
        <button class=${tab === 'results' ? 'on' : ''} onClick=${() => setTab('results')}>Results</button>
        <button class=${tab === 'ai' ? 'on' : ''} onClick=${() => setTab('ai')}>🤖 AI insights${ai?.summary?.content?.risk ? ` · ${ai.summary.content.risk}` : ''}</button>
        <button class=${tab === 'ask' ? 'on' : ''} onClick=${() => setTab('ask')}>Ask AI</button>
        <button class=${tab === 'matrix' ? 'on' : ''} onClick=${() => setTab('matrix')}>Coverage</button>
        <button class=${tab === 'logs' ? 'on' : ''} onClick=${() => setTab('logs')}>Log (${logs.length})</button>
      </div>

      ${tab === 'results' && html`<div>
        <div class="row" style="margin-bottom:6px">
          <select style="width:auto" value=${f.scenario} onChange=${(e) => setF({ ...f, scenario: e.target.value })}><option value="">All scenarios</option>${scenarios.map((s) => html`<option value=${s}>${SCENARIO_LABEL[s] || s}</option>`)}</select>
          <select style="width:auto;max-width:280px" value=${f.page} onChange=${(e) => setF({ ...f, page: e.target.value })}><option value="">All pages</option>${pages.map((p) => html`<option value=${p}>${p || '(report level)'}</option>`)}</select>
          <input type="search" style="max-width:320px" placeholder="Search titles…" value=${f.q} onInput=${(e) => setF({ ...f, q: e.target.value })} />
          <span class="spacer"></span><span class="small muted">${filtered.length} shown</span>
        </div>
        ${filtered.length === 0 && html`<div class="panel"><div class="empty">${results.length ? (f.problems ? html`<h3 style="color:var(--pass)">✔ No problems</h3>Every check passed. Switch to “All” to browse the screenshots.` : 'No results match the filters.') : live ? html`<${Spinner} /> Waiting for first results…` : 'No results.'}</div></div>`}
        ${filtered.map((r) => {
          const header = r.page !== lastPage ? html`<div class="page-group"><h3>${r.page || 'Report'}</h3></div>` : null;
          lastPage = r.page;
          const im = r.images || {};
          const thumbs = [im.a, im.b, im.annotated].filter(Boolean).slice(0, 3);
          return html`${header}<div class="res" onClick=${() => openResult(r)}>
            <div><${Badge} s=${r.status} /></div>
            <div><span class="tag">${SCENARIO_LABEL[r.scenario] || r.scenario}</span></div>
            <div class="title"><div>${r.title}</div>${r.details?.note && html`<div class="small muted">${r.details.note}</div>`}</div>
            <div class="thumbs">${thumbs.map((t) => html`<img src=${img(run.id, t)} loading="lazy" alt="" />`)}</div>
            <div class="pct">${r.diff_ratio != null ? pct(r.diff_ratio) : ''}</div></div>`;
        })}
      </div>`}

      ${tab === 'matrix' && html`<div class="panel"><table class="t"><thead><tr><th>Scenario</th>${STATUS_ORDER.map((s) => html`<th>${STATUS_LABEL[s]}</th>`)}<th>Total</th></tr></thead><tbody>
        ${Object.entries(byScenario).map(([sc, m]) => html`<tr class="click" onClick=${() => { setF({ status: '', scenario: sc, page: '', q: '', problems: false }); setTab('results'); }}>
          <td><b>${SCENARIO_LABEL[sc] || sc}</b></td>${STATUS_ORDER.map((s) => html`<td>${m[s] ? html`<span class="badge b-${s}">${m[s]}</span>` : html`<span class="muted">·</span>`}</td>`)}
          <td>${Object.values(m).reduce((a, b) => a + b, 0)}</td></tr>`)}
      </tbody></table></div>`}

      ${tab === 'ai' && html`<${AiInsights} run=${run} ai=${ai} onOpenRef=${openRef} reload=${reloadAi} />`}
      ${tab === 'ask' && html`<${AiChat} run=${run} ai=${ai} onOpenRef=${openRef} />`}
      ${tab === 'logs' && html`<div class="logs" ref=${logRef}>${logs.map((l) => html`<div class=${l.level}><span class="ts">${(l.ts || '').slice(11, 19)}</span>${l.message}</div>`)}</div>`}
    </div>`;
}
