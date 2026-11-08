import { html, useState, useEffect, useRef, useApi, go, fmtDate, fmtDur } from '../lib.js';
import { Spinner, Empty } from '../ui.js';
import { Topbar } from './common.js';

// Trend charts. Colours are state colours (validated for colour-blind
// separation): passed = good, accepted = blue, needs attention = critical.
// Identity never relies on colour alone: legend, tooltip and table view.
const SERIES = [
  { key: 'passed', label: 'Passed', color: '#0ca30c' },
  { key: 'accepted', label: 'Accepted as expected', color: '#0284c7' },
  { key: 'problems', label: 'Needs attention', color: '#d03b3b' },
];
const PROBLEM = ['diff', 'fail', 'missing', 'error', 'warn'];
const RUN_LABEL = { passed: 'Passed', diffs: 'Differences found', failed: 'Failed', error: 'Error', cancelled: 'Cancelled' };

export function splitRun(r) {
  const b = r.byStatus || {};
  return {
    passed: (b.pass || 0) + (b.skipped || 0),
    accepted: b.accepted || 0,
    problems: PROBLEM.reduce((n, s) => n + (b[s] || 0), 0),
  };
}

/** Clean axis ticks: 0 … max in 1/2/5 × 10^n steps. */
function ticks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count, pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
const fmtTick = (v) => (v >= 10000 ? `${Math.round(v / 1000)}K` : v.toLocaleString());

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const Legend = ({ items }) => html`<div class="legend">${items.map((s) => html`<span><i style=${`background:${s.color}`}></i>${s.label}</span>`)}</div>`;

function Tooltip({ tip }) {
  if (!tip) return null;
  return html`<div class="chart-tip" style=${`left:${tip.x}px;top:${tip.y}px`}>${tip.body}</div>`;
}

/** Stacked columns per run: passed / accepted / needs attention. Click → run. */
export function OutcomeChart({ runs, height = 240 }) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState(null);
  const pad = { l: 40, r: 8, t: 10, b: 26 };
  const data = runs.map((r) => ({ ...r, parts: splitRun(r) }));
  const max = Math.max(1, ...data.map((d) => d.parts.passed + d.parts.accepted + d.parts.problems));
  const ys = ticks(max);
  const top = ys[ys.length - 1];
  const iw = Math.max(0, width - pad.l - pad.r), ih = height - pad.t - pad.b;
  const slot = data.length ? iw / data.length : 0;
  const barW = Math.max(3, Math.min(28, slot - 2)); // 2px surface gap between bars
  const y = (v) => pad.t + ih - (v / top) * ih;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(iw / 44))));
  const show = (d, i, e) => {
    const box = ref.current.getBoundingClientRect();
    setTip({
      x: Math.min(Math.max(8, e.clientX - box.left + 12), width - 220), y: Math.max(0, e.clientY - box.top - 10),
      body: html`<b>Run #${d.id}</b> · ${RUN_LABEL[d.status] || d.status}<div class="muted">${d.suite} · ${fmtDate(d.startedAt)}</div>
        ${SERIES.map((s) => html`<div class="tip-row"><i style=${`background:${s.color}`}></i>${s.label}<b>${d.parts[s.key]}</b></div>`)}
        <div class="muted small">Click to open the run</div>`,
    });
  };
  return html`<div class="chart" ref=${ref} onMouseLeave=${() => setTip(null)}>
    <${Legend} items=${SERIES} />
    ${width > 0 && html`<svg width=${width} height=${height} role="img" aria-label=${`Check outcomes for the last ${data.length} runs`}>
      ${ys.map((v) => html`<g><line x1=${pad.l} x2=${width - pad.r} y1=${y(v)} y2=${y(v)} class=${v === 0 ? 'axis' : 'grid'} />
        <text x=${pad.l - 6} y=${y(v) + 4} text-anchor="end" class="tick">${fmtTick(v)}</text></g>`)}
      ${data.map((d, i) => {
        const x = pad.l + i * slot + (slot - barW) / 2;
        let acc = 0;
        const segs = SERIES.filter((s) => d.parts[s.key] > 0);
        const total = d.parts.passed + d.parts.accepted + d.parts.problems;
        return html`<g class="col" onMouseMove=${(e) => show(d, i, e)} onClick=${() => go(`/runs/${d.id}`)}>
          <rect x=${pad.l + i * slot} y=${pad.t} width=${slot} height=${ih} fill="transparent" />
          ${total === 0 && html`<rect x=${x} y=${y(0) - 3} width=${barW} height="3" rx="1.5" fill="#c3c2b7" />`}
          ${segs.map((s, si) => {
            const v = d.parts[s.key];
            const y1 = y(acc + v), h = y(acc) - y1 - (si > 0 ? 0 : 0);
            acc += v;
            const isTop = si === segs.length - 1;
            const gap = si < segs.length - 1 ? 2 : 0; // 2px surface gap between segments
            return isTop
              ? html`<path d=${roundedTop(x, y1, barW, Math.max(0, h - gap), Math.min(4, barW / 2))} fill=${s.color} />`
              : html`<rect x=${x} y=${y1 + gap} width=${barW} height=${Math.max(0, h - gap)} fill=${s.color} />`;
          })}
          ${i % labelEvery === 0 && html`<text x=${x + barW / 2} y=${height - 8} text-anchor="middle" class="tick">#${d.id}</text>`}
        </g>`;
      })}
    </svg>`}
    <${Tooltip} tip=${tip} />
  </div>`;
}

/** Rect with rounded top corners only (data end), square baseline. */
function roundedTop(x, y, w, h, r) {
  if (h <= 0) return '';
  const rr = Math.min(r, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

/** Run duration over time: one series, 2px line, hover crosshair. */
export function DurationChart({ runs, height = 180 }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = { l: 48, r: 12, t: 10, b: 26 };
  const data = runs.filter((r) => r.durationMs != null);
  if (data.length < 2) return html`<div class="small muted">Not enough finished runs yet.</div>`;
  const maxMin = Math.max(1, ...data.map((d) => d.durationMs / 60000));
  const ys = ticks(maxMin, 3);
  const top = ys[ys.length - 1];
  const iw = Math.max(0, width - pad.l - pad.r), ih = height - pad.t - pad.b;
  const x = (i) => pad.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (min) => pad.t + ih - (min / top) * ih;
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.durationMs / 60000)}`).join(' ');
  const onMove = (e) => {
    const box = ref.current.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / iw) * (data.length - 1))));
    setHover(i);
  };
  const h = hover != null ? data[hover] : null;
  return html`<div class="chart" ref=${ref} onMouseLeave=${() => setHover(null)}>
    ${width > 0 && html`<svg width=${width} height=${height} role="img" aria-label="Run duration over time" onMouseMove=${onMove}
        onClick=${() => h && go(`/runs/${h.id}`)} style="cursor:${h ? 'pointer' : 'default'}">
      ${ys.map((v) => html`<g><line x1=${pad.l} x2=${width - pad.r} y1=${y(v)} y2=${y(v)} class=${v === 0 ? 'axis' : 'grid'} />
        <text x=${pad.l - 6} y=${y(v) + 4} text-anchor="end" class="tick">${v} min</text></g>`)}
      <path d=${path} fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${h && html`<g><line x1=${x(hover)} x2=${x(hover)} y1=${pad.t} y2=${pad.t + ih} class="crosshair" />
        <circle cx=${x(hover)} cy=${y(h.durationMs / 60000)} r="5" fill="#2563eb" stroke="#ffffff" stroke-width="2" /></g>`}
      <rect x=${pad.l} y=${pad.t} width=${iw} height=${ih} fill="transparent" />
    </svg>`}
    ${h && html`<div class="chart-tip" style=${`left:${Math.min(Math.max(8, x(hover) + 12), width - 200)}px;top:4px`}>
      <b>Run #${h.id}</b> · ${fmtDur(h.durationMs)}<div class="muted">${fmtDate(h.startedAt)}</div></div>`}
  </div>`;
}

function TrendTable({ runs }) {
  return html`<table class="t"><thead><tr><th>Run</th><th>Started</th><th>Result</th><th>Passed</th><th>Accepted</th><th>Needs attention</th><th>Duration</th></tr></thead><tbody>
    ${[...runs].reverse().map((r) => { const p = splitRun(r); return html`<tr class="click" onClick=${() => go(`/runs/${r.id}`)}>
      <td><b>#${r.id}</b></td><td class="muted">${fmtDate(r.startedAt)}</td><td>${RUN_LABEL[r.status] || r.status}</td>
      <td>${p.passed}</td><td>${p.accepted}</td><td>${p.problems}</td><td class="muted">${fmtDur(r.durationMs)}</td></tr>`; })}
  </tbody></table>`;
}

const RANGES = [[10, 'Last 10 runs'], [30, 'Last 30 runs'], [90, 'Last 90 runs']];

export function Trends({ suiteId }) {
  const [limit, setLimit] = useState(30);
  const [asTable, setAsTable] = useState(false);
  const { data, error } = useApi(`/suites/${suiteId}/trend?limit=${limit}`, { deps: [limit] });
  if (error) return html`<div class="content"><div class="callout err">${error}</div></div>`;
  if (!data) return html`<div class="content"><${Spinner} /></div>`;
  const runs = data.runs;
  const n = runs.length;
  const passedRuns = runs.filter((r) => r.status === 'passed').length;
  const avgProblems = n ? runs.reduce((a, r) => a + splitRun(r).problems, 0) / n : 0;
  const durs = runs.filter((r) => r.durationMs != null);
  const avgDur = durs.length ? durs.reduce((a, r) => a + r.durationMs, 0) / durs.length : null;
  const last = runs[n - 1], prev = runs[n - 2];
  const lastP = last ? splitRun(last).problems : null;
  const delta = last && prev ? lastP - splitRun(prev).problems : null;
  return html`
    <${Topbar} title=${html`Trends · ${data.suite.name}`} sub="How this suite's results change over time. Click a column to open that run.">
      <a class="btn" href=${`#/runs?suite=${suiteId}`}>All runs</a>
    </${Topbar}>
    <div class="content stack">
      <div class="row">
        <select style="width:auto" value=${limit} onChange=${(e) => setLimit(Number(e.target.value))}>${RANGES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
        <span class="spacer"></span>
        <label class="row small" style="gap:6px"><input type="checkbox" checked=${asTable} onChange=${(e) => setAsTable(e.target.checked)} /> Show as table</label>
      </div>
      ${n === 0 ? html`<div class="panel"><${Empty} title="No finished runs yet">Run this suite to start building its history.</${Empty}></div>` : html`
      <div class="grid g4">
        <div class="panel kpi"><div class="l">Runs</div><div class="v">${n}</div><div class="small muted">in this view</div></div>
        <div class="panel kpi"><div class="l">Runs passed</div><div class="v">${Math.round((passedRuns / n) * 100)}%</div><div class="small muted">${passedRuns} of ${n}</div></div>
        <div class="panel kpi"><div class="l">Needs attention (last run)</div><div class="v">${lastP}</div>
          <div class="small muted">${delta == null ? '' : delta === 0 ? 'same as previous run' : delta < 0 ? `▼ ${-delta} fewer than previous run` : `▲ ${delta} more than previous run`}</div></div>
        <div class="panel kpi"><div class="l">Average run time</div><div class="v">${fmtDur(avgDur)}</div><div class="small muted">avg ${avgProblems.toFixed(1)} checks need attention</div></div>
      </div>
      ${asTable ? html`<div class="panel"><${TrendTable} runs=${runs} /></div>` : html`
      <div class="panel"><div class="panel-h"><h3>Check outcomes per run</h3></div><div class="panel-b"><${OutcomeChart} runs=${runs} /></div></div>
      <div class="panel"><div class="panel-h"><h3>Run time</h3></div><div class="panel-b"><${DurationChart} runs=${runs} /></div></div>`}`}
    </div>`;
}
