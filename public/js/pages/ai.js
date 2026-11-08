import { html, useState, useRef, useEffect, api, downloadFile } from '../lib.js';
import { Badge, Spinner, act } from '../ui.js';

const SEV = { critical: 'fail', high: 'fail', medium: 'diff', low: 'warn', info: 'skipped', none: 'pass' };
const RISK = { critical: 'fail', high: 'fail', medium: 'diff', low: 'warn', none: 'pass' };

/** Renders "#12" references as links that open the matching result. */
function Refs({ refs, onOpen }) {
  if (!refs?.length) return null;
  return html`<span class="row" style="gap:4px;display:inline-flex">${refs.slice(0, 12).map((n) => html`<a href="javascript:void 0" class="tag" onClick=${(e) => { e.preventDefault(); onOpen(n); }}>#${n}</a>`)}</span>`;
}

/** Light markdown: paragraphs, bullets, bold, inline code, #refs. */
function Md({ text, onOpen }) {
  const inline = (s) => {
    const parts = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|#\d+)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('**')) parts.push(html`<b>${t.slice(2, -2)}</b>`);
      else if (t.startsWith('`')) parts.push(html`<code>${t.slice(1, -1)}</code>`);
      else parts.push(html`<a href="javascript:void 0" onClick=${(e) => { e.preventDefault(); onOpen?.(Number(t.slice(1))); }}>${t}</a>`);
      last = m.index + t.length;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };
  const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
  return html`<div class="md">${blocks.map((b) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      return html`<ul>${lines.map((l) => html`<li>${inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>`)}</ul>`;
    }
    if (/^#{1,4}\s/.test(b)) return html`<h4>${inline(b.replace(/^#+\s*/, ''))}</h4>`;
    return html`<p>${lines.map((l, i) => html`${i ? html`<br />` : ''}${inline(l)}`)}</p>`;
  })}</div>`;
}

export function AiNotConfigured({ status }) {
  return html`<div class="callout info">🤖 <div><b>AI analysis is not configured.</b> Add a free NVIDIA API key to <code>.env</code> and restart:
    <pre class="json" style="margin:8px 0">NVIDIA_API_KEY=nvapi-…   # https://build.nvidia.com → Get API Key</pre>
    Uses open models on ${status?.baseUrl || 'integrate.api.nvidia.com'}: <code>${status?.textModel}</code> (analysis) and <code>${status?.visionModel}</code> (screenshots). Set <code>AI_BASE_URL</code> to a self-hosted NVIDIA NIM to keep report data inside your network.</div></div>`;
}

export function AiInsights({ run, ai, onOpenRef, reload }) {
  const st = ai?.status;
  if (!st?.configured) return html`<${AiNotConfigured} status=${st} />`;
  const live = ['queued', 'running'].includes(run.status);
  const S = ai.summary?.status === 'done' ? ai.summary.content : null;
  const A = ai.anomalies?.status === 'done' ? ai.anomalies.content : null;
  const running = ai.running || ai.summary?.status === 'running';
  const analyze = async () => { await act(() => api(`/runs/${run.id}/ai/analyze`, { method: 'POST', body: {} }), 'AI analysis started'); setTimeout(reload, 800); };
  const visionCount = Object.values(ai.vision || {}).filter((v) => v.status === 'done').length;

  return html`<div class="stack">
    <div class="row">
      <span class="muted small">Models: <code>${st.textModel}</code> · vision <code>${st.visionModel}</code> · ${st.provider}</span><span class="spacer"></span>
      ${S && !running && html`<button class="btn sm" onClick=${() => downloadFile(`/runs/${run.id}/report.pdf?download=1`, { busy: 'Building the PDF report…' })}>⇩ Download as PDF</button>
        <button class="btn sm ghost" onClick=${() => downloadFile(`/runs/${run.id}/export.xlsx`, { busy: 'Building the Excel workbook…' })}>⇩ Excel</button>`}
      ${running ? html`<span class="row small"><${Spinner} /> Analysing…</span>` : html`<button class="btn ed sm" disabled=${live} onClick=${analyze}>${S ? '↻ Re-analyse' : '🤖 Analyse with AI'}</button>`}
    </div>
    ${!S && !running && !ai.summary?.error && html`<div class="panel"><div class="empty"><h3>No AI analysis yet</h3>${live ? 'It starts automatically when the run finishes.' : 'Click “Analyse with AI” for an executive summary, root-cause triage, data-anomaly review and screenshot explanations.'}</div></div>`}
    ${ai.summary?.status === 'error' && html`<div class="callout err">AI summary failed: ${ai.summary.error}</div>`}

    ${S && html`<div class="panel ai-panel"><div class="panel-b stack">
      <div class="row"><h2 style="flex:1">${S.headline}</h2><${Badge} s=${RISK[S.risk] || 'skipped'} label=${`${S.risk || '?'} risk`} /></div>
      <p style="margin:0">${S.summary}</p>
      ${S.rootCauses?.length > 0 && html`<div><h3 style="margin-bottom:6px">Likely root causes</h3>
        ${S.rootCauses.map((c) => html`<div class="ai-item"><b>${c.cause}</b> <span class="tag">${c.confidence} confidence</span><div class="small muted">${c.evidence}</div><${Refs} refs=${c.resultRefs} onOpen=${onOpenRef} /></div>`)}</div>`}
      ${S.nextSteps?.length > 0 && html`<div><h3 style="margin-bottom:6px">Next steps</h3><ol style="margin:0;padding-left:20px">${S.nextSteps.map((n) => html`<li>${n}</li>`)}</ol></div>`}
      <div class="small muted">Generated by ${ai.summary.model} in ${Math.round((ai.summary.duration_ms || 0) / 1000)}s · AI output can be wrong; verify against the screenshots and data diffs.</div>
    </div></div>`}

    ${S?.findings?.length > 0 && html`<div class="panel"><div class="panel-h"><h2>Triaged findings</h2><span class="muted small">${S.findings.length} grouped from the failing checks</span></div>
      <table class="t"><thead><tr><th>Severity</th><th>Finding</th><th>Category</th><th>Checks</th></tr></thead><tbody>
      ${[...S.findings].sort((a, b) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low', 'info'].indexOf(b.severity)).map((f) => html`<tr>
        <td><${Badge} s=${SEV[f.severity] || 'skipped'} label=${f.severity} /></td>
        <td><b>${f.title}</b><div class="small">${f.explanation}</div>${f.recommendation && html`<div class="small" style="color:var(--accent-2)">→ ${f.recommendation}</div>`}</td>
        <td><span class="tag">${f.category}</span></td><td><${Refs} refs=${f.resultRefs} onOpen=${onOpenRef} /></td></tr>`)}
      </tbody></table></div>`}

    ${S?.noise?.length > 0 && html`<div class="panel panel-b"><h3 style="margin-bottom:6px">Probably noise</h3>${S.noise.map((n) => html`<div class="small">${n.reason} <${Refs} refs=${n.resultRefs} onOpen=${onOpenRef} /></div>`)}</div>`}

    ${ai.anomalies?.status === 'running' && html`<div class="row small"><${Spinner} /> Reviewing extracted data for anomalies…</div>`}
    ${ai.anomalies?.status === 'error' && html`<div class="callout err">Data-anomaly analysis failed: ${ai.anomalies.error}</div>`}
    ${A && html`<div class="panel"><div class="panel-h"><h2>Data anomalies</h2><span class="muted small">${A.assessment}</span></div>
      ${(A.anomalies || []).length === 0 ? html`<div class="panel-b" style="color:var(--pass)">✔ No anomalies found in the extracted values.</div>` : html`
      <table class="t"><thead><tr><th>Severity</th><th>Where</th><th>Issue</th><th>Evidence</th><th></th></tr></thead><tbody>
        ${A.anomalies.map((a) => html`<tr><td><${Badge} s=${SEV[a.severity] || 'warn'} label=${a.severity} /></td><td><b>${a.visual}</b><div class="small muted">${a.page}</div></td>
          <td>${a.issue}</td><td class="small mono">${a.evidence}</td><td><${Refs} refs=${a.resultRefs} onOpen=${onOpenRef} /></td></tr>`)}</tbody></table>`}
      ${(A.reconciliation || []).length > 0 && html`<div class="panel-b"><h3 style="margin-bottom:6px">Reconciliation checks</h3>${A.reconciliation.map((c) => html`<div class="small"><${Badge} s=${c.status === 'consistent' ? 'pass' : c.status === 'inconsistent' ? 'fail' : 'skipped'} label=${c.status} /> <b>${c.check}</b> — ${c.detail}</div>`)}</div>`}
    </div>`}
    ${visionCount > 0 && html`<div class="small muted">🖼 ${visionCount} screenshot difference(s) explained by the vision model — open a result to read it.</div>`}
  </div>`;
}

export function AiChat({ run, ai, onOpenRef }) {
  const [history, setHistory] = useState(() => (ai?.chat || []).map((c) => ({ question: c.question, answer: c.answer })));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [history, busy]);
  if (!ai?.status?.configured) return html`<${AiNotConfigured} status=${ai?.status} />`;
  const ask = async (question) => {
    if (!question.trim() || busy) return;
    setBusy(true); setQ('');
    setHistory((h) => [...h, { question, answer: null }]);
    const r = await act(() => api(`/runs/${run.id}/ai/ask`, { method: 'POST', body: { question, history: history.filter((h) => h.answer) } }));
    setHistory((h) => [...h.slice(0, -1), { question, answer: r ? r.answer : '⚠ The AI request failed — see the error message.' }]);
    setBusy(false);
  };
  const SUGGEST = ['Summarise what changed between A and B', 'Which differences are real data regressions vs rendering noise?', 'Which buttons or slicers behave differently?', 'Do the totals reconcile with their breakdowns?'];
  return html`<div class="panel"><div class="panel-b stack">
    ${history.length === 0 && html`<div class="row">${SUGGEST.map((s) => html`<button class="btn sm" onClick=${() => ask(s)}>${s}</button>`)}</div>`}
    <div class="chat">${history.map((h) => html`<div class="msg user"><div>${h.question}</div></div>
      <div class="msg bot"><div>${h.answer == null ? html`<${Spinner} /> Thinking…` : html`<${Md} text=${h.answer} onOpen=${onOpenRef} />`}</div></div>`)}<div ref=${end}></div></div>
    <form class="row" onSubmit=${(e) => { e.preventDefault(); ask(q); }}>
      <input type="text" style="flex:1" placeholder="Ask about this run — e.g. “Why did the Region slicer fail?”" value=${q} onInput=${(e) => setQ(e.target.value)} disabled=${busy} />
      <button class="btn primary" disabled=${busy || !q.trim()}>Ask</button>
    </form>
    <div class="small muted">Answers are grounded in this run's results and extracted values (${ai.status.textModel}). Cite #numbers open the referenced check.</div>
  </div></div>`;
}

export function VisionPanel({ result, ai, onUpdated }) {
  const v = ai?.vision?.[result.id];
  const [busy, setBusy] = useState(false);
  const hasImg = result.images?.a || result.images?.b;
  if (!ai?.status?.configured || !hasImg) return null;
  const explain = async () => {
    setBusy(true);
    const r = await act(() => api(`/results/${result.id}/ai/explain`, { method: 'POST', body: {} }));
    setBusy(false);
    if (r) onUpdated?.();
  };
  const c = v?.status === 'done' ? v.content : null;
  return html`<div class="panel ai-panel"><div class="panel-b stack" style="gap:6px">
    <div class="row"><b>🤖 AI screenshot analysis</b>${c && html`<${Badge} s=${c.likelyNoise ? 'skipped' : SEV[c.severity] || 'diff'} label=${c.likelyNoise ? 'likely noise' : `${c.severity} · ${c.category}`} />`}
      <span class="spacer"></span>
      ${!ai.status.imagesAllowed ? html`<span class="small muted">Disabled (AI_ALLOW_IMAGES=false)</span>`
        : html`<button class="btn ed sm" disabled=${busy} onClick=${explain}>${busy ? html`<${Spinner} /> Looking…` : c ? '↻ Re-explain' : 'Explain with AI'}</button>`}</div>
    ${v?.status === 'error' && html`<div class="small" style="color:var(--fail)">${v.error}</div>`}
    ${v?.status === 'running' && !busy && html`<div class="small muted"><${Spinner} /> Analysing…</div>`}
    ${c && html`<div>${c.whatChanged}</div>${c.details?.length > 0 && html`<ul style="margin:0;padding-left:20px">${c.details.map((d) => html`<li class="small">${d}</li>`)}</ul>`}
      <div class="small muted">${v.model} · ${c.confidence} confidence</div>`}
  </div></div>`;
}
