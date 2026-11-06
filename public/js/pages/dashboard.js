import { html, useApi, go, fmtAgo, runDuration } from '../lib.js';
import { Badge, Progress } from '../ui.js';
import { Topbar, SummaryChips } from './common.js';

export function Dashboard() {
  const stats = useApi('/stats', { poll: 5000 });
  const runs = useApi('/runs?limit=12', { poll: 3000 });
  const profiles = useApi('/profiles');
  const s = stats.data || {};
  const active = (runs.data || []).filter((r) => ['queued', 'running'].includes(r.status));
  const needLogin = (profiles.data || []).filter((p) => p.status !== 'active');
  const fresh = s.reports === 0 || s.suites === 0;

  return html`
    <${Topbar} title="Dashboard" sub="End-to-end validation of Power BI reports: pages, visuals, data, buttons, slicers, hierarchies and interactions.">
      <a class="btn primary" href="#/suites">Run a suite</a>
    </${Topbar}>
    <div class="content stack">
      ${needLogin.length > 0 && html`<div class="callout warn">⚠ <div><b>${needLogin.length} auth profile(s) need sign-in:</b> ${needLogin.map((p) => p.name).join(', ')}. Runs that use them will be redirected to the Microsoft login page. <a href="#/profiles">Sign in →</a></div></div>`}
      <div class="grid g4">
        <div class="panel kpi"><div class="l">Report links</div><div class="v">${s.reports ?? '–'}</div></div>
        <div class="panel kpi"><div class="l">Test suites</div><div class="v">${s.suites ?? '–'}</div></div>
        <div class="panel kpi"><div class="l">Runs</div><div class="v">${s.runs ?? '–'}</div><div class="small muted">${s.active ? `${s.active} active` : 'none active'}</div></div>
        <div class="panel kpi"><div class="l">Pass rate (last 50)</div><div class="v">${s.passRate == null ? '–' : `${Math.round(s.passRate * 100)}%`}</div></div>
      </div>

      ${fresh && html`<div class="panel"><div class="panel-h"><h2>Get started</h2></div><div class="panel-b steps">
        <div class=${(profiles.data || []).length ? 'done' : ''}><div><b>Create an auth profile and sign in</b><div class="small muted">Captures your Microsoft session (SSO + MFA supported). Skip for public "publish to web" links.</div></div><span class="spacer"></span><a class="btn sm" href="#/profiles">Auth profiles</a></div>
        <div class=${s.reports ? 'done' : ''}><div><b>Add your Power BI report links</b><div class="small muted">e.g. the DEV and PROD copies of the same report. Use "Discover" to verify each link.</div></div><span class="spacer"></span><a class="btn sm" href="#/reports">Report links</a></div>
        <div class=${s.suites ? 'done' : ''}><div><b>Create a test suite (A ⇄ B)</b><div class="small muted">Pick which scenarios to validate and the tolerances.</div></div><span class="spacer"></span><a class="btn sm" href="#/suites">Test suites</a></div>
        <div><div><b>Run it and review the differences</b><div class="small muted">Side-by-side screenshots, pixel diffs, outlined regions and data diffs for every scenario.</div></div></div>
      </div></div>`}

      ${active.length > 0 && html`<div class="panel"><div class="panel-h"><h2>Active runs</h2></div><div class="panel-b stack">
        ${active.map((r) => html`<a href=${`#/runs/${r.id}`} style="color:inherit;text-decoration:none">
          <div class="row"><b>#${r.id} ${r.suite_name}</b><${Badge} s=${r.status} /><span class="muted small">${r.phase || ''}</span><span class="spacer"></span><span class="small">${Math.round((r.progress || 0) * 100)}%</span></div>
          <div style="margin-top:6px"><${Progress} value=${r.progress} /></div></a>`)}
      </div></div>`}

      <div class="panel"><div class="panel-h"><h2>Recent runs</h2><a href="#/runs" class="small">All runs →</a></div>
        ${(runs.data || []).length === 0 ? html`<div class="empty"><h3>No runs yet</h3>Create a suite and press Run.</div>` : html`
        <table class="t"><thead><tr><th>Run</th><th>Suite</th><th>Status</th><th>Results</th><th>Trigger</th><th>Started</th><th>Duration</th></tr></thead><tbody>
          ${runs.data.map((r) => html`<tr class="click" onClick=${() => go(`/runs/${r.id}`)}>
            <td><b>#${r.id}</b></td><td>${r.suite_name}</td><td><${Badge} s=${r.status} /></td>
            <td><${SummaryChips} byStatus=${r.summary?.byStatus} /></td><td><span class="tag">${r.trigger}</span></td>
            <td class="muted">${fmtAgo(r.started_at || r.queued_at)}</td><td class="muted">${runDuration(r)}</td></tr>`)}
        </tbody></table>`}
      </div>
    </div>`;
}
