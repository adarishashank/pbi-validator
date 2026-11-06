import { html } from '../lib.js';

export const Topbar = ({ title, sub, children }) => html`<div class="topbar">
  <div><h1>${title}</h1>${sub && html`<div class="sub">${sub}</div>`}</div>
  <div class="row">${children}</div></div>`;

export const SummaryChips = ({ byStatus = {} }) => {
  const order = ['fail', 'error', 'missing', 'diff', 'warn', 'pass', 'skipped'];
  const items = order.filter((s) => byStatus[s]);
  if (!items.length) return html`<span class="muted small">—</span>`;
  return html`<span class="row" style="gap:4px">${items.map((s) => html`<span class="badge b-${s}" title=${s}>${byStatus[s]} ${s}</span>`)}</span>`;
};
