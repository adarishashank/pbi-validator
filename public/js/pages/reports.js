import { html, useApi, useState, setStore, fmtAgo, fmtDur, api } from '../lib.js';
import { Badge, Modal, Field, act, confirmDialog, Empty, Spinner, zoom } from '../ui.js';
import { Topbar } from './common.js';

function ReportForm({ report, profiles, onDone }) {
  const [f, setF] = useState({
    name: report?.name || '', url: report?.url || '', environment: report?.environment || '',
    auth_profile_id: report ? report.auth_profile_id || null : (profiles.length === 1 ? profiles[0].id : null), tags: report?.tags || '', notes: report?.notes || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const body = { ...f, auth_profile_id: f.auth_profile_id ? Number(f.auth_profile_id) : null };
    const r = await act(() => api(report ? `/reports/${report.id}` : '/reports', { method: report ? 'PUT' : 'POST', body }), 'Report saved');
    if (r) { setStore({ modal: null }); onDone(r); }
  };
  const isPublic = /\/view\?r=/i.test(f.url);
  return html`<${Modal} title=${report ? 'Edit report link' : 'Add report link'} onClose=${() => setStore({ modal: null })}
    footer=${html`<button class="btn" onClick=${() => setStore({ modal: null })}>Cancel</button><button class="btn primary" onClick=${save}>Save</button>`}>
    <div class="form-grid">
      <${Field} label="Name"><input type="text" value=${f.name} onInput=${set('name')} placeholder="Sales Overview" /></${Field}>
      <${Field} label="Environment / label"><input type="text" value=${f.environment} onInput=${set('environment')} placeholder="DEV, UAT, PROD…" /></${Field}>
      <${Field} label="Report URL" full hint="Service link (app.powerbi.com/groups/…/reports/…), app link, embed link (reportEmbed?…), or publish-to-web link (view?r=…). Any page works — all pages are discovered.">
        <input type="url" value=${f.url} onInput=${set('url')} placeholder="https://app.powerbi.com/groups/…/reports/…" /></${Field}>
      <${Field} label="Power BI sign-in" hint=${isPublic ? 'Publish-to-web links are public — no profile needed.' : 'Session used to open this report.'}>
        <select value=${f.auth_profile_id || ''} onChange=${set('auth_profile_id')}>
          <option value="">— None (public / anonymous) —</option>
          ${profiles.map((p) => html`<option value=${p.id}>${p.name}${p.status !== 'active' ? ` (${p.status.replace('_', ' ')})` : ''}</option>`)}
        </select></${Field}>
      <${Field} label="Tags"><input type="text" value=${f.tags} onInput=${set('tags')} placeholder="finance, monthly" /></${Field}>
      <${Field} label="Notes" full><textarea value=${f.notes} onInput=${set('notes')} style="min-height:60px;font-family:inherit"></textarea></${Field}>
    </div></${Modal}>`;
}

function Discovery({ report, result }) {
  if (!result) return null;
  return html`<${Modal} size="wide" title=${`Discovery · ${report.name}`} onClose=${() => setStore({ modal: null })}>
    ${!result.ok ? html`<div class="callout err">✖ <div><b>${result.code === 'AUTH_REQUIRED' ? 'Sign-in required' : 'Could not open the report'}</b><div>${result.error}</div></div></div>` : html`
    <div class="stack">
      <div class="row"><${Badge} s="pass" label="Reachable" /><span class="muted">Loaded in ${fmtDur(result.loadMs)} · ${result.pages.length} page(s) · navigation: <code>${result.navigation}</code></span></div>
      <div class="thumbs-grid">${result.pages.map((p) => html`<div class="thumb-card">
        ${p.thumbnail ? html`<img src=${`${p.thumbnail}?t=${encodeURIComponent(result.at)}`} onClick=${() => zoom(`${p.thumbnail}?t=${encodeURIComponent(result.at)}`)} alt=${p.name} />` : null}
        <div class="meta"><b>${p.index + 1}. ${p.name}</b>
          ${p.error ? html`<div class="small" style="color:var(--fail)">${p.error}</div>` : html`
          <div class="muted">${p.visuals} visuals · ${fmtDur(p.renderMs)}</div>
          <div class="row" style="margin-top:6px;gap:4px">
            ${p.interactive.buttons > 0 && html`<span class="tag">${p.interactive.buttons} buttons</span>`}
            ${p.interactive.slicers > 0 && html`<span class="tag">${p.interactive.slicers} slicers</span>`}
            ${p.interactive.charts > 0 && html`<span class="tag">${p.interactive.charts} charts</span>`}
            ${p.interactive.matrices > 0 && html`<span class="tag">${p.interactive.matrices} matrices</span>`}
          </div>
          ${p.errors?.length > 0 && html`<div class="small" style="color:var(--fail);margin-top:6px">${p.errors.length} visual error(s): ${p.errors.slice(0, 3).join('; ')}</div>`}`}
        </div></div>`)}</div>
    </div>`}
  </${Modal}>`;
}

/** Secured app.powerbi.com links need a sign-in; publish-to-web (…/view?r=) links don't. */
const needsSignIn = (url) => /app\.powerbi\.com|app\.fabric\.microsoft\.com/i.test(url || '') && !/\/view\?r=/i.test(url || '');
const hasIds = (url) => /\/groups\/[\w-]+\/reports\/[0-9a-f-]{36}/i.test(url || '') || /reportEmbed.*reportId=/i.test(url || '');

/** Uploads a data-model file (.pbit, model.bim, .tmdl or zipped TMDL folder) for a report link. */
async function uploadModel(r, file) {
  const res = await fetch(`/api/reports/${r.id}/model?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

function ModelCell({ r, reload }) {
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pbit,.bim,.json,.tmdl,.zip';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (await act(() => uploadModel(r, f), `Data model read from ${f.name}`)) reload();
    };
    input.click();
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Remove model file?', message: `Stop using "${r.model_file}" for "${r.name}"?${hasIds(r.url) ? ' The model will be read from Power BI instead.' : ''}`, okLabel: 'Remove', danger: true }))) return;
    if ((await act(() => api(`/reports/${r.id}/model`, { method: 'DELETE' }), 'Model file removed')) !== undefined) reload();
  };
  const st = r.model_stats;
  return html`<div class="small">
    ${r.model_file ? html`<div><b class="truncate" title=${r.model_file}>${r.model_file}</b></div>
      ${st && html`<div class="muted">${[[st.tables, 'table'], [st.measures, 'measure'], [st.relationships, 'relationship']].map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(' · ')}</div>`}
      <div class="muted">uploaded ${fmtAgo(r.model_uploaded_at)}</div>`
    : hasIds(r.url) ? html`<div class="muted" title="Read through the Power BI REST API during each run (needs Build permission on the semantic model)">From Power BI</div>`
    : html`<div class="muted" title="Publish-to-web links don't identify the semantic model">Not available: upload a file</div>`}
    <div class="row" style="gap:4px;margin-top:4px">
      <button class="btn ed sm ghost" onClick=${pick} title="Upload a .pbit template, model.bim, .tmdl file or a .zip of a TMDL folder">${r.model_file ? 'Replace' : 'Upload model'}</button>
      ${r.model_file && html`<button class="btn ed sm ghost danger" onClick=${remove}>Remove</button>`}
    </div></div>`;
}

export function Reports() {
  const { data, reload } = useApi('/reports');
  const profiles = useApi('/profiles');
  const [busy, setBusy] = useState({});
  const list = data || [];
  const edit = (r) => setStore({ modal: html`<${ReportForm} report=${r} profiles=${profiles.data || []} onDone=${reload} />` });
  const discover = async (r) => {
    setBusy((b) => ({ ...b, [r.id]: true }));
    const res = await act(() => api(`/reports/${r.id}/discover`, { method: 'POST' }));
    setBusy((b) => ({ ...b, [r.id]: false }));
    reload();
    if (res) setStore({ modal: html`<${Discovery} report=${r} result=${res} />` });
  };
  const del = async (r) => {
    if (!(await confirmDialog({ title: 'Delete report link?', message: `Delete "${r.name}"? Suites using it will also be deleted.`, okLabel: 'Delete', danger: true }))) return;
    await act(() => api(`/reports/${r.id}?force=1`, { method: 'DELETE' }), 'Report deleted');
    reload();
  };

  return html`
    <${Topbar} title="Report links" sub="Every Power BI report you want to validate. Pair two of them in a test suite to compare A ⇄ B.">
      <button class="btn ed primary" onClick=${() => edit(null)}>+ Add report link</button>
    </${Topbar}>
    <div class="content">
      ${list.length === 0 ? html`<div class="panel"><${Empty} title="No report links yet">Add the report you want to validate — typically two copies (e.g. DEV and PROD, or before/after a dataset change).</${Empty}></div>` : html`
      <div class="panel"><table class="t"><thead><tr><th>Report</th><th>Environment</th><th>Auth</th><th>Data model</th><th>Last discovery</th><th></th></tr></thead><tbody>
        ${list.map((r) => {
          const d = r.last_discovery;
          return html`<tr>
            <td style="max-width:420px"><b>${r.name}</b><div class="small muted truncate" title=${r.url}>${r.url}</div>
              ${r.tags && html`<div class="row" style="gap:4px;margin-top:4px">${r.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t) => html`<span class="tag">${t}</span>`)}</div>`}</td>
            <td>${r.environment ? html`<span class="tag">${r.environment}</span>` : html`<span class="muted">—</span>`}</td>
            <td>${r.auth_profile_name ? html`<div class="row" style="gap:6px">${r.auth_profile_name}<${Badge} s=${r.auth_profile_status} /></div>`
              : needsSignIn(r.url) ? html`<span class="small" style="color:var(--fail)" title="This link opens a secured report: edit it and choose a Power BI sign-in">⚠ No sign-in selected</span>`
              : html`<span class="muted small">Anonymous</span>`}</td>
            <td style="max-width:220px"><${ModelCell} r=${r} reload=${reload} /></td>
            <td>${!d ? html`<span class="muted small">Never</span>` : d.ok
              ? html`<span class="row" style="gap:6px"><${Badge} s="pass" label="OK" /><span class="small muted">${d.pages.length} pages · ${fmtAgo(d.at)}</span></span>`
              : html`<span class="row" style="gap:6px"><${Badge} s="fail" label="Failed" /><span class="small muted truncate" style="max-width:240px" title=${d.error}>${d.error}</span></span>`}</td>
            <td style="text-align:right"><div class="row" style="justify-content:flex-end">
              <button class="btn ed sm" onClick=${() => discover(r)} disabled=${busy[r.id]}>${busy[r.id] ? html`<${Spinner} /> Discovering…` : 'Discover'}</button>
              ${d && html`<button class="btn sm ghost" onClick=${() => setStore({ modal: html`<${Discovery} report=${r} result=${d} />` })}>View</button>`}
              <a class="btn sm ghost" href=${r.url} target="_blank" rel="noopener noreferrer">Open ↗</a>
              <button class="btn ed sm ghost" onClick=${() => edit(r)}>Edit</button>
              <button class="btn ed sm ghost danger" onClick=${() => del(r)}>Delete</button></div></td></tr>`;
        })}
      </tbody></table></div>`}
    </div>`;
}
