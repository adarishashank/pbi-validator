import { html, useState, useEffect, useApi, api, can, fmtDate, toast } from '../lib.js';
import { Menu, Field, act, confirmDialog, Spinner } from '../ui.js';

/** Polls the results-site status quickly while a deploy is running. */
export function usePagesStatus() {
  const st = useApi('/pages/status');
  useEffect(() => {
    if (!st.data?.deploying) return undefined;
    const t = setInterval(st.reload, 2500);
    return () => clearInterval(t);
  }, [st.data?.deploying]);
  return st;
}

/** Waits for the background deploy to finish and reports the outcome. */
async function follow(reload, okMessage) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const s = await api('/pages/status').catch(() => null);
    if (s && !s.deploying) {
      reload();
      if (s.lastError) toast(`Results site: ${s.lastError}`, 'err'); else toast(okMessage, 'ok');
      return s;
    }
  }
  return null;
}

/** "Publish to results site" control for the run page. */
export function PublishControl({ run }) {
  const st = usePagesStatus();
  const s = st.data;
  if (!s || ['queued', 'running'].includes(run.status)) return null;
  const published = s.published.some((p) => p.id === run.id);
  if (s.deploying) return html`<span class="row small muted" style="gap:6px"><${Spinner} /> ${s.step || 'Updating results site…'}</span>`;
  const publish = async () => {
    const r = await act(() => api(`/runs/${run.id}/publish`, { method: 'POST' }), 'Publishing… this takes about a minute');
    if (r) { st.reload(); follow(st.reload, `Run #${run.id} is on the results site`); }
  };
  const unpublish = async () => {
    if (!await confirmDialog({ title: 'Remove from the results site?', message: `Run #${run.id} will no longer be visible on ${s.url || 'the results site'}.`, okLabel: 'Remove', danger: true })) return;
    const r = await act(() => api(`/runs/${run.id}/publish`, { method: 'DELETE' }), 'Removing…');
    if (r) { st.reload(); follow(st.reload, `Run #${run.id} removed from the results site`); }
  };
  if (!published) {
    return can('editor') ? html`<button class="btn" title="Share this run read-only on the free Cloudflare Pages results site" onClick=${publish}>☁ Publish</button>` : null;
  }
  const items = [
    s.url && { icon: '↗', label: 'Open on the results site', desc: s.url.replace('https://', ''), onClick: () => window.open(`${s.url}/runs/${run.id}/`, '_blank', 'noopener') },
    can('editor') && { icon: '↻', label: 'Update published copy', desc: 'Republish with the latest AI analysis', onClick: publish },
    can('editor') && { icon: '✕', label: 'Remove from results site', onClick: unpublish },
  ].filter(Boolean);
  return html`<${Menu} label=${html`<span style="color:var(--pass)">✓</span> Published`} items=${items} />`;
}

/** Admin → Settings panel for the results site. */
export function ResultsSiteSettings() {
  const st = usePagesStatus();
  const s = st.data;
  const [project, setProject] = useState(null);
  const [pw, setPw] = useState('');
  useEffect(() => { if (s && project === null) setProject(s.project); }, [s]);
  if (!s || project === null) return html`<div class="panel panel-b"><${Spinner} /></div>`;
  const run = async (body, msg) => {
    const r = await act(() => api('/admin/pages', { method: 'PUT', body }), 'Updating the results site…');
    if (r) { setPw(''); st.reload(); follow(st.reload, msg); }
  };
  const republish = async () => {
    const r = await act(() => api('/admin/pages/deploy', { method: 'POST' }), 'Republishing…');
    if (r) { st.reload(); follow(st.reload, 'Results site updated'); }
  };
  const removePw = async () => {
    if (!await confirmDialog({ title: 'Remove the password?', message: 'Anyone with the address will be able to see the published runs.', okLabel: 'Remove password', danger: true })) return;
    run({ removePassword: true }, 'Password removed; the results site is public');
  };
  return html`<div class="panel"><div class="panel-h"><div><h3>Results site (Cloudflare Pages, free)</h3>
      <div class="small muted">A read-only website with the runs you publish (report, screenshots, PDF, Excel). Publish from a run's page.</div></div>
      ${s.deploying ? html`<span class="row small"><${Spinner} /> ${s.step}</span>` : s.url ? html`<a class="btn sm" href=${s.url} target="_blank" rel="noopener">Open ↗</a>` : html`<span class="badge b-skipped">Not published yet</span>`}</div>
    <div class="panel-b stack">
      ${s.lastError && !s.deploying && html`<div class="callout err">✖ <div><b>Last update failed:</b> ${s.lastError}</div></div>`}
      <dl class="kv">
        <dt>Address</dt><dd>${s.url ? html`<a href=${s.url} target="_blank" rel="noopener">${s.url}</a>` : html`<span class="muted">https://${s.project}.pages.dev (after the first publish)</span>`}</dd>
        <dt>Protection</dt><dd>${s.passwordSet ? html`<span class="badge b-pass">Password required</span>` : html`<span class="badge b-warn">Public: anyone with the link</span>`}</dd>
        <dt>Published runs</dt><dd>${s.published.length ? s.published.map((p) => html`<a href=${`#/runs/${p.id}`} style="margin-right:10px">#${p.id} ${p.suite_name}</a>`) : html`<span class="muted">None</span>`}</dd>
        <dt>Last update</dt><dd>${s.lastDeployAt ? fmtDate(s.lastDeployAt) : '—'}</dd>
      </dl>
      <div class="form-grid">
        <${Field} label="Site password" hint=${s.passwordSet ? 'Enter a new one to change it. Visitors type it in the browser\'s sign-in box (any username).' : 'Recommended. Visitors type it in the browser\'s sign-in box (any username).'}>
          <div class="row" style="flex-wrap:nowrap"><input type="password" autocomplete="new-password" placeholder="At least 8 characters" value=${pw} onInput=${(e) => setPw(e.target.value)} />
          <button class="btn" disabled=${pw.length < 8 || s.deploying} onClick=${() => run({ password: pw }, 'Password set: the results site now asks for it')}>${s.passwordSet ? 'Change' : 'Set password'}</button></div></${Field}>
        <${Field} label="Project name" hint="Becomes <name>.pages.dev. Changing it creates a new site.">
          <div class="row" style="flex-wrap:nowrap"><input type="text" value=${project} onInput=${(e) => setProject(e.target.value.toLowerCase())} />
          <button class="btn" disabled=${project === s.project || s.deploying} onClick=${() => run({ project }, 'Results site moved')}>Save</button></div></${Field}>
      </div>
      <div class="row"><span class="small muted">Publishing uses Cloudflare's Wrangler tool, signed in on the machine running PBI Report Test.</span><span class="spacer"></span>
        ${s.passwordSet && html`<button class="btn ghost danger" disabled=${s.deploying} onClick=${removePw}>Remove password</button>`}
        <button class="btn" disabled=${s.deploying} onClick=${republish}>↻ Republish now</button></div>
    </div></div>`;
}
