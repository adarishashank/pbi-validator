import { html, useState, useEffect, api, pct, STATUS_LABEL, SCENARIO_LABEL } from '../lib.js';
import { Badge, Spinner } from '../ui.js';
import { ActionItems } from './ai.js';

// "What changed" for a comparison run: report → page → visual → value.
// Level colours are one blue ramp (more change = darker) and always carry a
// text label, so they never rely on colour alone.

const LEVEL = { none: 'No change', low: 'Low', medium: 'Medium', high: 'High' };
const OP = { chg: 'Changed', add: 'Only in B', del: 'Only in A' };
const STATE = { removed: 'Only in A', added: 'Only in B' };

function PageTile({ p, on, onClick }) {
  const label = STATE[p.state] || LEVEL[p.level];
  return html`<button class="chg-tile lvl-${p.level} ${on ? 'on' : ''}" onClick=${onClick} aria-pressed=${on}>
    <div class="chg-name">${p.name}${p.renamedTo && html`<span class="small"> → ${p.renamedTo}</span>`}</div>
    <div class="chg-lvl">${label}</div>
    <div class="chg-facts small">
      ${p.problems ? html`<span>${p.problems} need attention</span>` : html`<span>nothing to review</span>`}
      ${p.valuesChanged > 0 && html`<span>${p.valuesChanged} value${p.valuesChanged === 1 ? '' : 's'}</span>`}
      ${p.layout.length > 0 && html`<span>${p.layout.length} layout</span>`}
      ${p.interactions.length > 0 && html`<span>${p.interactions.length} interaction${p.interactions.length === 1 ? '' : 's'}</span>`}
    </div>
  </button>`;
}

function ValueTable({ changes }) {
  return html`<table class="t dt-vals"><thead><tr><th>Change</th><th>A (before)</th><th>B (after)</th></tr></thead><tbody>
    ${changes.slice(0, 50).map((c) => html`<tr><td class="small">${OP[c.op] || c.op}</td><td class="mono ${c.op !== 'add' ? 'del' : ''}">${c.a ?? ''}</td><td class="mono ${c.op !== 'del' ? 'add' : ''}">${c.b ?? ''}</td></tr>`)}
    ${changes.length > 50 && html`<tr><td colspan="3" class="small muted">${changes.length - 50} more: open the check for all of them</td></tr>`}
  </tbody></table>`;
}

function PageDetail({ p, onOpen }) {
  const [openVisual, setOpenVisual] = useState(null);
  if (p.state === 'added') return html`<div class="panel panel-b"><b>${p.name}</b> exists only in B (a new page). It wasn't compared.</div>`;
  const visuals = new Map();
  for (const v of p.visualsChanged) visuals.set(v.resultId, { ...v, changes: [] });
  for (const v of p.values) visuals.set(v.resultId, { ...(visuals.get(v.resultId) || { resultId: v.resultId, title: v.visual, status: v.status }), changes: v.changes });
  const list = [...visuals.values()];
  return html`<div class="stack" style="gap:12px">
    ${p.state === 'removed' && html`<div class="callout err">This page exists only in A: it was removed or hidden in B.</div>`}
    ${p.layout.length > 0 && html`<div class="panel panel-b"><h3>Layout</h3><table class="t"><thead><tr><th>Visual</th><th>Change</th></tr></thead><tbody>
      ${p.layout.map((l) => html`<tr><td>${l.visual}</td><td><b>${l.change}</b>${l.change === 'retitled' ? html` <span class="small muted">"${l.a}" → "${l.b}"</span>` : ''}</td></tr>`)}</tbody></table></div>`}
    <div class="panel panel-b"><h3>Visuals ${list.length ? `(${list.length} changed)` : ''}</h3>
      ${list.length === 0 ? html`<div class="small muted">No visual on this page shows a different picture or different data.</div>` : list.map((v) => html`
        <div class="chg-visual">
          <div class="row" style="gap:8px">
            <${Badge} s=${v.status} />
            <button class="linkish" onClick=${() => setOpenVisual(openVisual === v.resultId ? null : v.resultId)} aria-expanded=${openVisual === v.resultId}>${openVisual === v.resultId ? '▾' : '▸'} ${v.title}</button>
            <span class="small muted">${v.missingIn ? `missing in ${v.missingIn}` : v.changes.length ? `${v.changes.length} value change${v.changes.length === 1 ? '' : 's'}` : v.pixel != null ? `${pct(v.pixel)} pixels differ` : ''}</span>
            <span class="spacer"></span><button class="btn sm" onClick=${() => onOpen(v.resultId)}>Open check</button>
          </div>
          ${openVisual === v.resultId && (v.changes.length ? html`<${ValueTable} changes=${v.changes} />` : html`<div class="small muted" style="margin:6px 0 0 28px">No data change: the difference is visual only (open the check for screenshots).</div>`)}
        </div>`)}
    </div>
    ${p.interactions.length > 0 && html`<div class="panel panel-b"><h3>Interactions that behave differently</h3>
      ${p.interactions.map((i) => html`<div class="chg-visual row" style="gap:8px"><${Badge} s=${i.status} /><span class="tag">${SCENARIO_LABEL[i.scenario] || i.scenario}</span>
        <span>${i.title}</span><span class="small muted">${i.summary}</span><span class="spacer"></span><button class="btn sm" onClick=${() => onOpen(i.resultId)}>Open check</button></div>`)}</div>`}
    ${p.health.length > 0 && html`<div class="panel panel-b"><h3>Visual errors</h3>${p.health.map((e) => html`<div class="small"><b>${e.side}</b> · ${e.visual}: ${e.error}</div>`)}</div>`}
  </div>`;
}

const KIND = { table: 'Tables', column: 'Columns', measure: 'Measures (DAX)', relationship: 'Relationships', role: 'Security roles (RLS)', parameter: 'Parameters & shared queries' };
const CHANGE = { added: 'Added in B', removed: 'Missing in B', changed: 'Changed' };

function ModelPanel({ m, onOpen }) {
  const [open, setOpen] = useState(null);
  if (!m.compared) {
    return html`<div class="panel panel-b"><h3>Data model</h3><div class="small muted">${m.note}</div></div>`;
  }
  const info = m.info || {};
  const st = info.stats || {};
  const groups = {};
  for (const c of m.changes) (groups[c.kind] ??= []).push(c);
  const row = (label, f) => html`<tr><td>${label}</td><td>${f(st.A)}</td><td>${f(st.B)}</td></tr>`;
  return html`<div class="panel panel-b">
    <div class="row"><h3 style="margin:0">Data model</h3><${Badge} s=${m.status} /><span class="spacer"></span>
      <button class="btn sm" onClick=${() => onOpen(m.resultId)}>Open check</button></div>
    <div class="grid g2" style="margin-top:8px;gap:16px">
      <table class="t"><thead><tr><th></th><th>A</th><th>B</th></tr></thead><tbody>
        ${row('Tables', (x) => x?.tables ?? '—')}${row('Columns', (x) => x?.columns ?? '—')}${row('Measures', (x) => x?.measures ?? '—')}
        ${row('Relationships', (x) => x?.relationships ?? '—')}${row('Security roles', (x) => x?.roles ?? '—')}
      </tbody></table>
      <div class="small">
        <div><b>Read from</b></div><div>A: ${info.sources?.A || '—'}</div><div>B: ${info.sources?.B || '—'}</div>
        ${(info.lastRefresh?.A || info.lastRefresh?.B) && html`<div style="margin-top:6px"><b>Last data refresh</b></div><div>A: ${info.lastRefresh?.A ? new Date(info.lastRefresh.A).toLocaleString() : '—'}</div><div>B: ${info.lastRefresh?.B ? new Date(info.lastRefresh.B).toLocaleString() : '—'}</div>`}
      </div>
    </div>
    ${m.changes.length === 0 ? html`<div class="callout ok" style="margin-top:10px">The two data models are identical.</div>` : Object.entries(groups).map(([kind, list]) => html`
      <div style="margin-top:12px"><button class="linkish" onClick=${() => setOpen(open === kind ? null : kind)} aria-expanded=${open === kind}>${open === kind ? '▾' : '▸'} <b>${KIND[kind] || kind}</b></button>
        <span class="small muted"> ${[['changed', 'changed'], ['added', 'added in B'], ['removed', 'missing in B']].map(([c, l]) => { const n = list.filter((x) => x.change === c).length; return n ? `${n} ${l}` : ''; }).filter(Boolean).join(' · ')}</span>
        ${open === kind && list.map((c) => html`<div class="chg-visual row" style="gap:8px;margin-left:18px"><${Badge} s=${c.status} />
          <span class="mono">${c.table && kind !== 'table' && kind !== 'relationship' ? `${c.table} · ` : ''}${c.label || c.name}</span>
          <span class="small muted">${CHANGE[c.change]}${c.change === 'changed' && c.fields?.length ? `: ${c.fields.map((f) => f.label).join(', ')}` : ''}</span>
          <span class="spacer"></span><button class="btn sm" onClick=${() => onOpen(c.resultId)}>${c.fields?.some((f) => /DAX|Expression|Source|filter/i.test(f.label)) || c.change !== 'changed' ? 'Show the difference' : 'Open check'}</button></div>`)}
      </div>`)}
  </div>`;
}

export function WhatChanged({ run, version, onOpen, onOpenRef, ai }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [page, setPage] = useState(null);
  useEffect(() => { api(`/runs/${run.id}/changes`).then(setData, (e) => setErr(e.message)); }, [run.id, version]);
  if (err) return html`<div class="callout err">${err}</div>`;
  if (!data) return html`<${Spinner} />`;
  const t = data.report.totals;
  const sel = data.pages.find((p) => p.name === page);
  const changed = data.pages.filter((p) => p.state !== 'unchanged');
  return html`<div class="stack">
    <div class="callout ${changed.length ? 'info' : 'ok'}"><div><b>${data.report.headline}</b>
      ${data.report.renamed.length > 0 && html`<div class="small">Renamed: ${data.report.renamed.map((x) => `${x.a} → ${x.b}`).join(', ')}</div>`}</div></div>
    ${(() => {
      const S = ai?.summary?.status === 'done' ? ai.summary.content : null;
      return S?.actionItems?.length
        ? html`<${ActionItems} items=${S.actionItems} fromAi model=${ai.summary.model} onOpenRef=${onOpenRef} />`
        : html`<${ActionItems} items=${data.report.top} onOpenRef=${onOpenRef} />`;
    })()}
    <div class="grid g4">
      <div class="panel kpi"><div class="l">Pages changed</div><div class="v">${t.pagesChanged}</div><div class="small muted">of ${data.pages.length} page${data.pages.length === 1 ? '' : 's'}</div></div>
      <div class="panel kpi"><div class="l">Visuals added / removed</div><div class="v">${t.visualsAdded} / ${t.visualsRemoved}</div><div class="small muted">${t.visualsMoved} moved or resized</div></div>
      <div class="panel kpi"><div class="l">Values changed</div><div class="v">${t.valuesChanged}</div><div class="small muted">in ${t.visualsWithDataChanges} visual${t.visualsWithDataChanges === 1 ? '' : 's'}</div></div>
      <div class="panel kpi"><div class="l">Interactions that differ</div><div class="v">${t.interactionsChanged}</div><div class="small muted">buttons, slicers, drills, filters</div></div>
    </div>
    ${data.report.model && html`<${ModelPanel} m=${data.report.model} onOpen=${onOpen} />`}
    <div class="panel panel-b">
      <div class="row" style="margin-bottom:10px"><h3 style="margin:0">Pages</h3><span class="spacer"></span>
        <span class="legend small">${['none', 'low', 'medium', 'high'].map((l) => html`<span class="row" style="gap:4px"><i class="sw lvl-${l}"></i>${LEVEL[l]}</span>`)}</span></div>
      <div class="chg-grid">${data.pages.map((p) => html`<${PageTile} p=${p} on=${page === p.name} onClick=${() => setPage(page === p.name ? null : p.name)} />`)}</div>
      ${!sel && html`<div class="small muted" style="margin-top:8px">Click a page to see which visuals, values and interactions changed.</div>`}
    </div>
    ${sel && html`<div class="stack" style="gap:8px">
      <div class="crumbs small"><button class="linkish" onClick=${() => setPage(null)}>Report</button> › <b>${sel.name}</b></div>
      <${PageDetail} key=${sel.name} p=${sel} onOpen=${onOpen} />
    </div>`}
  </div>`;
}

export { LEVEL, STATUS_LABEL };
