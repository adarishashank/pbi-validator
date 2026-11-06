import { html, render, useRoute, useApi, useEffect, setStore } from './lib.js';
import { Toasts, Lightbox, ModalHost, TokenPrompt } from './ui.js';
import { Dashboard } from './pages/dashboard.js';
import { Reports } from './pages/reports.js';
import { Suites } from './pages/suites.js';
import { Runs } from './pages/runs.js';
import { RunDetail } from './pages/run.js';
import { Profiles } from './pages/profiles.js';

const NAV = [
  ['', '◧', 'Dashboard'],
  ['reports', '⧉', 'Report links'],
  ['suites', '⇄', 'Test suites'],
  ['runs', '▶', 'Runs'],
  ['profiles', '⚿', 'Auth profiles'],
];

function Health() {
  const { data, error } = useApi('/health', { poll: 10000 });
  if (error) return html`<span><span class="dot off"></span>Server unreachable</span>`;
  if (!data) return html`<span>…</span>`;
  return html`<span><span class="dot ${data.busy ? 'busy' : ''}"></span>${data.busy ? 'Validation running' : 'Idle · ready'}</span>`;
}

function AiBadge() {
  const { data } = useApi('/ai/status');
  if (!data) return null;
  return html`<div style="margin-top:6px" title=${data.configured ? `${data.textModel} · ${data.visionModel}` : 'Set NVIDIA_API_KEY to enable'}>🤖 AI: ${data.configured ? html`<span style="color:#a78bfa">NVIDIA ${data.textModel.split('/').pop()}</span>` : 'not configured'}</div>`;
}

function App() {
  const { parts, query } = useRoute();
  const top = parts[0] || '';
  const routeKey = parts.join('/');
  useEffect(() => { setStore({ modal: null, lightbox: null }); }, [routeKey]);
  let page;
  if (top === 'reports') page = html`<${Reports} />`;
  else if (top === 'suites') page = html`<${Suites} editId=${parts[1]} />`;
  else if (top === 'runs' && parts[1]) page = html`<${RunDetail} id=${parts[1]} query=${query} />`;
  else if (top === 'runs') page = html`<${Runs} query=${query} />`;
  else if (top === 'profiles') page = html`<${Profiles} />`;
  else page = html`<${Dashboard} />`;
  return html`<div class="shell">
    <aside class="side">
      <div class="brand"><div class="brand-mark">▮</div><div>PBI Validator<small>Report regression testing</small></div></div>
      <nav class="nav">${NAV.map(([p, ico, label]) => html`<a href=${`#/${p}`} class=${top === p ? 'active' : ''}><span class="ico">${ico}</span>${label}</a>`)}</nav>
      <div class="side-foot"><${Health} /><${AiBadge} /></div>
    </aside>
    <main class="main">${page}</main>
    <${ModalHost} /><${Lightbox} /><${Toasts} /><${TokenPrompt} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
