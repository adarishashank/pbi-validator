import { html, useApi, useState, setStore, fmtAgo, fmtDate, go, api } from '../lib.js';
import { Badge, Modal, Field, Check, act, confirmDialog, Empty } from '../ui.js';
import { Topbar, SummaryChips } from './common.js';

const SCENARIOS = [
  ['pageRender', 'Page render', 'Full-page screenshot pixel diff + render health (visual errors)'],
  ['structure', 'Layout & inventory', 'Missing / extra / moved / resized / retitled visuals'],
  ['visuals', 'Every visual', 'Per-visual screenshot diff + extracted data (cards, tables, matrices, chart points)'],
  ['buttons', 'Buttons & navigators', 'Clicks action buttons, page/bookmark navigators; verifies destination & resulting state'],
  ['slicers', 'Slicers', 'Applies slicer values and compares the whole filtered page + data'],
  ['drill', 'Hierarchy drill', 'Drill down / expand-all / next-level on hierarchical visuals'],
  ['matrixExpand', 'Matrix +/- expand', 'Expands matrix row groups and compares the expanded data'],
  ['crossFilter', 'Cross-filtering', 'Clicks data points and compares how the rest of the page reacts'],
  ['tooltips', 'Tooltips', 'Hovers data points and compares tooltip content'],
];
const LIMITS = [
  ['slicerValues', 'Values per slicer', 0, 20], ['buttonsPerPage', 'Buttons per page', 0, 100], ['drillPerPage', 'Drill visuals per page', 0, 50],
  ['crossFilterPerPage', 'Cross-filter visuals per page', 0, 50], ['tooltipsPerPage', 'Tooltip visuals per page', 0, 50], ['matrixExpandRows', 'Matrix rows to expand', 1, 20],
];

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function SuiteEditor({ suite, reports, defaults, onDone }) {
  const base = structuredClone(suite?.config || defaults);
  const [f, setF] = useState({
    name: suite?.name || '', description: suite?.description || '', mode: suite?.mode || 'compare',
    report_a_id: suite?.report_a_id || '', report_b_id: suite?.report_b_id || '', schedule: suite?.schedule || '',
  });
  const [c, setC] = useState(base);
  const [txt, setTxt] = useState({
    include: base.pages.include.join('\n'), exclude: base.pages.exclude.join('\n'),
    visualTypes: base.ignore.visualTypes.join('\n'), visualTitles: base.ignore.visualTitles.join('\n'),
    textPatterns: base.ignore.textPatterns.join('\n'), maskSelectors: base.ignore.maskSelectors.join('\n'),
    selectors: Object.keys(base.selectors || {}).length ? JSON.stringify(base.selectors, null, 2) : '',
  });
  const [tab, setTab] = useState('basics');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setIn = (sec, k, v) => setC({ ...c, [sec]: { ...c[sec], [k]: v } });
  const num = (sec, k) => (e) => setIn(sec, k, Number(e.target.value));

  const save = async () => {
    let selectors = {};
    if (txt.selectors.trim()) {
      try { selectors = JSON.parse(txt.selectors); } catch { return act(() => { throw new Error('Selector overrides must be valid JSON'); }); }
    }
    const config = {
      ...c,
      pages: { include: lines(txt.include), exclude: lines(txt.exclude) },
      ignore: { visualTypes: lines(txt.visualTypes), visualTitles: lines(txt.visualTitles), textPatterns: lines(txt.textPatterns), maskSelectors: lines(txt.maskSelectors) },
      selectors,
    };
    const body = { ...f, report_a_id: Number(f.report_a_id), report_b_id: f.mode === 'compare' ? Number(f.report_b_id) || null : null, config };
    const r = await act(() => api(suite?.id ? `/suites/${suite.id}` : '/suites', { method: suite?.id ? 'PUT' : 'POST', body }), 'Suite saved');
    if (r) { setStore({ modal: null }); onDone(r); }
  };

  const T = (id, label) => html`<button class=${tab === id ? 'on' : ''} onClick=${() => setTab(id)}>${label}</button>`;
  return html`<${Modal} size="wide" title=${suite?.id ? `Edit suite · ${suite.name}` : 'New test suite'} onClose=${() => setStore({ modal: null })}
    footer=${html`<button class="btn" onClick=${() => setStore({ modal: null })}>Cancel</button><button class="btn primary" onClick=${save}>Save suite</button>`}>
    <div class="tabs">${T('basics', 'Basics')}${T('scenarios', 'Scenarios')}${T('tolerances', 'Tolerances & ignores')}${T('advanced', 'Advanced')}</div>

    ${tab === 'basics' && html`<div class="form-grid">
      <${Field} label="Suite name"><input type="text" value=${f.name} onInput=${set('name')} placeholder="Sales report · DEV vs PROD" /></${Field}>
      <${Field} label="Mode"><div class="btn-group">
        <button class="btn ${f.mode === 'compare' ? 'on' : ''}" onClick=${() => setF({ ...f, mode: 'compare' })}>Compare A ⇄ B</button>
        <button class="btn ${f.mode === 'single' ? 'on' : ''}" onClick=${() => setF({ ...f, mode: 'single' })}>Validate single report</button></div></${Field}>
      <${Field} label="Report A (baseline)"><select value=${f.report_a_id} onChange=${set('report_a_id')}><option value="">Select…</option>
        ${reports.map((r) => html`<option value=${r.id}>${r.name}${r.environment ? ` · ${r.environment}` : ''}</option>`)}</select></${Field}>
      ${f.mode === 'compare' ? html`<${Field} label="Report B (candidate)"><select value=${f.report_b_id} onChange=${set('report_b_id')}><option value="">Select…</option>
        ${reports.map((r) => html`<option value=${r.id}>${r.name}${r.environment ? ` · ${r.environment}` : ''}</option>`)}</select></${Field}>`
        : html`<div class="callout info small">Single mode checks rendering health, visual errors and that every interaction works — with screenshots of each state.</div>`}
      <${Field} label="Description" full><input type="text" value=${f.description} onInput=${set('description')} placeholder="What is this suite protecting?" /></${Field}>
      <${Field} label="Schedule (cron, optional)" hint="e.g. 0 6 * * 1-5 = weekdays 06:00 (server time). Leave empty for manual/CI runs."><input type="text" value=${f.schedule} onInput=${set('schedule')} placeholder="0 6 * * 1-5" /></${Field}>
      <${Field} label="Pages to include" hint="One per line; exact name or /regex/. Empty = all pages."><textarea value=${txt.include} onInput=${(e) => setTxt({ ...txt, include: e.target.value })}></textarea></${Field}>
      <${Field} label="Pages to exclude" full hint="One per line; exact name or /regex/ (e.g. /^Tooltip/ for tooltip pages)."><textarea value=${txt.exclude} onInput=${(e) => setTxt({ ...txt, exclude: e.target.value })} style="min-height:60px"></textarea></${Field}>
    </div>`}

    ${tab === 'scenarios' && html`<div class="stack">
      <div class="grid g2">${SCENARIOS.map(([k, label, desc]) => html`<${Check} label=${label} desc=${desc} checked=${c.scenarios[k]} onChange=${(v) => setIn('scenarios', k, v)} />`)}</div>
      <div class="fieldset"><h4>Coverage limits</h4><div class="form-grid g3">
        ${LIMITS.map(([k, label, min, max]) => html`<${Field} label=${label}><input type="number" min=${min} max=${max} value=${c.limits[k]} onInput=${num('limits', k)} /></${Field}>`)}
      </div></div>
      <div class="fieldset"><h4>🤖 AI analysis (NVIDIA open models)</h4><div class="grid g2">
        <${Check} label="AI summary, triage & data-anomaly review" desc="Runs automatically after each run when NVIDIA_API_KEY is set." checked=${c.ai?.enabled !== false} onChange=${(v) => setC({ ...c, ai: { ...c.ai, enabled: v } })} />
        <${Check} label="Explain screenshot differences" desc="Sends the A/B screenshots of the top differences to the vision model." checked=${c.ai?.vision !== false} onChange=${(v) => setC({ ...c, ai: { ...c.ai, vision: v } })} />
      </div><div class="form-grid g3" style="margin-top:10px"><${Field} label="Max screenshots to explain per run"><input type="number" min="0" max="50" value=${c.ai?.maxVisionItems ?? 8} onInput=${(e) => setC({ ...c, ai: { ...c.ai, maxVisionItems: Number(e.target.value) } })} /></${Field}></div></div>
      <${Check} label="Reset to default on load" desc="Service only — clicks “Reset to default” so personal/persistent filters never skew results." checked=${c.resetToDefaultOnLoad} onChange=${(v) => setC({ ...c, resetToDefaultOnLoad: v })} />
    </div>`}

    ${tab === 'tolerances' && html`<div class="stack">
      <div class="fieldset"><h4>Thresholds</h4><div class="form-grid g3">
        <${Field} label="Max differing pixels (%)" hint="Above this a screenshot is a diff."><input type="number" step="0.01" min="0" max="100" value=${+(c.thresholds.maxDiffRatio * 100).toFixed(4)} onInput=${(e) => setIn('thresholds', 'maxDiffRatio', Number(e.target.value) / 100)} /></${Field}>
        <${Field} label="Per-pixel colour tolerance" hint="0 = exact, 0.1 = default, 0.3 = lenient."><input type="number" step="0.01" min="0" max="1" value=${c.thresholds.pixelThreshold} onInput=${num('thresholds', 'pixelThreshold')} /></${Field}>
        <${Field} label="Layout jitter tolerance (px)" hint="Ignores sub-pixel text/axis shifts."><input type="number" min="0" max="3" value=${c.thresholds.shiftTolerancePx} onInput=${num('thresholds', 'shiftTolerancePx')} /></${Field}>
        <${Field} label="Position / size tolerance (px)"><input type="number" min="0" max="200" value=${c.thresholds.positionTolerancePx} onInput=${num('thresholds', 'positionTolerancePx')} /></${Field}>
        <${Field} label="Numeric tolerance (relative)" hint="0.001 = values within 0.1% are equal."><input type="number" step="0.0001" min="0" value=${c.thresholds.numericTolerance} onInput=${num('thresholds', 'numericTolerance')} /></${Field}>
        <${Field} label="Retries per scenario"><input type="number" min="0" max="3" value=${c.retries} onInput=${(e) => setC({ ...c, retries: Number(e.target.value) })} /></${Field}>
      </div></div>
      <div class="form-grid">
        <${Field} label="Ignore visual types" hint="Visual type tokens excluded from per-visual checks (still in page screenshots)."><textarea value=${txt.visualTypes} onInput=${(e) => setTxt({ ...txt, visualTypes: e.target.value })}></textarea></${Field}>
        <${Field} label="Ignore visuals by title" hint="Exact title or /regex/, one per line."><textarea value=${txt.visualTitles} onInput=${(e) => setTxt({ ...txt, visualTitles: e.target.value })} placeholder="/last refresh/i"></textarea></${Field}>
        <${Field} label="Ignore text patterns" hint="Regex removed from extracted data before comparing (dates, refresh stamps…)."><textarea value=${txt.textPatterns} onInput=${(e) => setTxt({ ...txt, textPatterns: e.target.value })} placeholder="Last refreshed: .*"></textarea></${Field}>
        <${Field} label="Mask in screenshots" hint="CSS selectors painted magenta in both screenshots."><textarea value=${txt.maskSelectors} onInput=${(e) => setTxt({ ...txt, maskSelectors: e.target.value })}></textarea></${Field}>
      </div>
    </div>`}

    ${tab === 'advanced' && html`<div class="stack">
      <div class="fieldset"><h4>Browser</h4><div class="form-grid g3">
        <${Field} label="Viewport width"><input type="number" value=${c.viewport.width} onInput=${num('viewport', 'width')} /></${Field}>
        <${Field} label="Viewport height"><input type="number" value=${c.viewport.height} onInput=${num('viewport', 'height')} /></${Field}>
        <${Field} label="Locale"><input type="text" value=${c.locale} onInput=${(e) => setC({ ...c, locale: e.target.value })} /></${Field}>
        <${Field} label="Time zone"><input type="text" value=${c.timezone} onInput=${(e) => setC({ ...c, timezone: e.target.value })} /></${Field}>
        <${Field} label="Load timeout (ms)"><input type="number" value=${c.timing.loadTimeoutMs} onInput=${num('timing', 'loadTimeoutMs')} /></${Field}>
        <${Field} label="Render-settle timeout (ms)"><input type="number" value=${c.timing.stableTimeoutMs} onInput=${num('timing', 'stableTimeoutMs')} /></${Field}>
        <${Field} label="Settle delay (ms)"><input type="number" value=${c.timing.settleMs} onInput=${num('timing', 'settleMs')} /></${Field}>
        <${Field} label="Action timeout (ms)"><input type="number" value=${c.timing.actionTimeoutMs} onInput=${num('timing', 'actionTimeoutMs')} /></${Field}>
        <${Field} label="Max visuals per page"><input type="number" value=${c.limits.maxVisualsPerPage} onInput=${num('limits', 'maxVisualsPerPage')} /></${Field}>
      </div></div>
      <${Field} label="Selector overrides (JSON)" hint="Patch the Power BI DOM contract without a code change if Microsoft changes markup. Keys: canvas, visualContainer, pageItems, slicerItem, dataPoint, headerButtonLabels, contextMenuLabels…">
        <textarea style="min-height:160px" value=${txt.selectors} onInput=${(e) => setTxt({ ...txt, selectors: e.target.value })} placeholder='{ "pageItems": ["[data-testid=\\"pages-navigation-list-items\\"]"] }'></textarea></${Field}>
    </div>`}
  </${Modal}>`;
}

export function Suites() {
  const { data, reload } = useApi('/suites', { poll: 5000 });
  const reports = useApi('/reports');
  const meta = useApi('/meta');
  const list = data || [];
  const repName = (id) => (reports.data || []).find((r) => r.id === id);
  const open = (s) => {
    if (!(reports.data || []).length) return act(() => { throw new Error('Add report links first'); });
    setStore({ modal: html`<${SuiteEditor} suite=${s} reports=${reports.data} defaults=${meta.data?.defaults} onDone=${reload} />` });
  };
  const run = async (s) => { const r = await act(() => api(`/suites/${s.id}/run`, { method: 'POST' }), 'Run queued'); if (r) go(`/runs/${r.runId}`); };
  const del = async (s) => {
    if (!(await confirmDialog({ title: 'Delete suite?', message: `Delete "${s.name}"? Past runs are kept.`, okLabel: 'Delete', danger: true }))) return;
    await act(() => api(`/suites/${s.id}`, { method: 'DELETE' }), 'Suite deleted');
    reload();
  };
  const dup = (s) => open({ ...s, id: null, name: `${s.name} (copy)` });

  return html`
    <${Topbar} title="Test suites" sub="A suite pairs report A with report B (or validates one report) and defines what to check.">
      <button class="btn primary" onClick=${() => open(null)}>+ New suite</button>
    </${Topbar}>
    <div class="content">
      ${list.length === 0 ? html`<div class="panel"><${Empty} title="No suites yet">Create a suite to compare two report links end-to-end.</${Empty}></div>` : html`
      <div class="grid g2">${list.map((s) => {
        const a = repName(s.report_a_id), b = repName(s.report_b_id);
        const lr = s.last_run;
        return html`<div class="panel suite-card">
          <div class="row"><h3>${s.name}</h3><span class="tag">${s.mode === 'compare' ? 'A ⇄ B' : 'Single'}</span><span class="spacer"></span>${lr && html`<${Badge} s=${lr.status} />`}</div>
          ${s.description && html`<div class="muted small">${s.description}</div>`}
          <div class="vs"><span class="side-pill" title=${a?.url}><b>A</b>${a?.name || '?'}${a?.environment ? ` · ${a.environment}` : ''}</span>
            ${s.mode === 'compare' && html`<span>⇄</span><span class="side-pill" title=${b?.url}><b>B</b>${b?.name || '?'}${b?.environment ? ` · ${b.environment}` : ''}</span>`}</div>
          <div class="row small muted">
            ${Object.entries(s.config.scenarios).filter(([, v]) => v).length}/9 scenarios ·
            ${s.schedule ? html`<span>⏱ <code>${s.schedule}</code> next ${fmtDate(s.next_run)}</span>` : 'manual / CI'}
          </div>
          ${lr && html`<div class="row small"><a href=${`#/runs/${lr.id}`}>Last run #${lr.id}</a><span class="muted">${fmtAgo(lr.finished_at)}</span><${SummaryChips} byStatus=${lr.summary?.byStatus} /></div>`}
          <div class="row" style="margin-top:4px">
            <button class="btn primary sm" onClick=${() => run(s)}>▶ Run now</button>
            <a class="btn sm" href=${`#/runs?suite=${s.id}`}>History</a>
            <button class="btn sm ghost" onClick=${() => open(s)}>Edit</button>
            <button class="btn sm ghost" onClick=${() => dup(s)}>Duplicate</button>
            <span class="spacer"></span>
            <button class="btn sm ghost danger" onClick=${() => del(s)}>Delete</button>
          </div></div>`;
      })}</div>`}
    </div>`;
}
