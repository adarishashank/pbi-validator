import { html, useApi, go, fmtDate, runDuration, downloadFile } from '../lib.js';
import { Badge, Progress, Empty } from '../ui.js';
import { Topbar, SummaryChips } from './common.js';

const RESULTS = [['passed', 'Passed'], ['diffs', 'Differences found'], ['failed', 'Failed'], ['error', 'Error'], ['running', 'Running'], ['queued', 'Queued'], ['cancelled', 'Cancelled']];

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
      <select style="width:auto;max-width:220px" value=${suite} onChange=${(e) => setQ('suite', e.target.value)}>
        <option value="">All suites</option>${(suites.data || []).map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select>
      <select style="width:auto;max-width:170px" value=${status} onChange=${(e) => setQ('status', e.target.value)}>
        <option value="">Any result</option>${RESULTS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
      ${suite && html`<a class="btn" href=${`#/trends/${suite}`}>Trends</a>`}
      <button class="btn" disabled=${!list.length} title="Download this list as an Excel workbook"
        onClick=${() => downloadFile(`/runs/export.xlsx?${new URLSearchParams({ ...(suite && { suite }), ...(status && { status }) })}`, { busy: 'Building the Excel workbook…' })}>⇩ Export to Excel</button>
    </${Topbar}>
    <div class="content">
      ${list.length === 0 ? html`<div class="panel"><${Empty} title="No runs">Start one from <a href="#/suites">Test suites</a>.</${Empty}></div>` : html`
      <div class="panel"><table class="t"><thead><tr><th>Run</th><th>Suite</th><th>Status</th><th>Results</th><th>Trigger</th><th>Started</th><th>Duration</th><th></th></tr></thead><tbody>
        ${list.map((r) => html`<tr class="click" onClick=${() => go(`/runs/${r.id}`)}>
          <td><b>#${r.id}</b></td><td>${r.suite_name}</td>
          <td>${['running', 'queued'].includes(r.status) ? html`<div style="min-width:140px"><div class="row"><${Badge} s=${r.status} /><span class="small muted">${Math.round(r.progress * 100)}%</span></div><div style="margin-top:4px"><${Progress} value=${r.progress} sm /></div></div>` : html`<${Badge} s=${r.status} />`}</td>
          <td><${SummaryChips} byStatus=${r.summary?.byStatus} /></td><td><span class="tag">${r.trigger}</span>${r.triggered_by && html`<div class="small muted truncate" style="max-width:180px">${r.triggered_by}</div>`}</td>
          <td class="muted">${fmtDate(r.started_at || r.queued_at)}</td><td class="muted">${runDuration(r)}</td>
          <td style="text-align:right">${!['running', 'queued'].includes(r.status) && html`<button class="btn sm ghost" title="Download the PDF report for this run"
            onClick=${(e) => { e.stopPropagation(); downloadFile(`/runs/${r.id}/report.pdf?download=1`, { busy: `Building the PDF for run #${r.id}…` }); }}>⇩ PDF</button>`}</td></tr>`)}
      </tbody></table></div>`}
    </div>`;
}
