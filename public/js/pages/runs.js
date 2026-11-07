import { html, useApi, go, fmtDate, runDuration } from '../lib.js';
import { Badge, Progress, Empty } from '../ui.js';
import { Topbar, SummaryChips } from './common.js';

export function Runs({ query }) {
  const suite = query.get('suite') || '';
  const status = query.get('status') || '';
  const qs = new URLSearchParams({ limit: '200', ...(suite && { suite }), ...(status && { status }) }).toString();
  const { data } = useApi(`/runs?${qs}`, { poll: 3000, deps: [qs] });
  const suites = useApi('/suites');
  const setQ = (k, v) => {
    const p = new URLSearchParams(query);
    if (v) p.set(k, v); else p.delete(k);
    go(`/runs?${p}`);
  };
  const list = data || [];
  return html`
    <${Topbar} title="Runs" sub="Every validation run with its outcome. Open one to review screenshots and differences.">
      <select style="width:auto" value=${suite} onChange=${(e) => setQ('suite', e.target.value)}>
        <option value="">All suites</option>${(suites.data || []).map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select>
      <select style="width:auto" value=${status} onChange=${(e) => setQ('status', e.target.value)}>
        <option value="">Any status</option>${['passed', 'diffs', 'failed', 'error', 'running', 'queued', 'cancelled'].map((s) => html`<option>${s}</option>`)}</select>
    </${Topbar}>
    <div class="content">
      ${list.length === 0 ? html`<div class="panel"><${Empty} title="No runs">Start one from <a href="#/suites">Test suites</a>.</${Empty}></div>` : html`
      <div class="panel"><table class="t"><thead><tr><th>Run</th><th>Suite</th><th>Status</th><th>Results</th><th>Trigger</th><th>Started</th><th>Duration</th></tr></thead><tbody>
        ${list.map((r) => html`<tr class="click" onClick=${() => go(`/runs/${r.id}`)}>
          <td><b>#${r.id}</b></td><td>${r.suite_name}</td>
          <td>${['running', 'queued'].includes(r.status) ? html`<div style="min-width:140px"><div class="row"><${Badge} s=${r.status} /><span class="small muted">${Math.round(r.progress * 100)}%</span></div><div style="margin-top:4px"><${Progress} value=${r.progress} sm /></div></div>` : html`<${Badge} s=${r.status} />`}</td>
          <td><${SummaryChips} byStatus=${r.summary?.byStatus} /></td><td><span class="tag">${r.trigger}</span>${r.triggered_by && html`<div class="small muted truncate" style="max-width:180px">${r.triggered_by}</div>`}</td>
          <td class="muted">${fmtDate(r.started_at || r.queued_at)}</td><td class="muted">${runDuration(r)}</td></tr>`)}
      </tbody></table></div>`}
    </div>`;
}
