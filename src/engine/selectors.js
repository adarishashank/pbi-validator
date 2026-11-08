/**
 * Power BI DOM contract.
 *
 * Verified against the live Power BI renderer (publish-to-web, Nov 2026) and
 * kept with fallbacks for app.powerbi.com (service / apps) and embedded
 * reports. Every key can be overridden per suite via `config.selectors`, so a
 * Microsoft DOM change can be patched from the UI without a code release.
 */
export const DEFAULT_SELECTORS = {
  // Report canvas (screenshots are clipped to this, so service chrome such as
  // workspace names / headers never pollutes the comparison).
  canvas: ['[data-testid="display-area"]', '.displayArea', 'exploration-container', '.explorationContainer'],
  visualContainer: 'visual-container',
  visualBox: ['[data-testid="visual-container"]', '.visualContainer', 'transform'],
  visualGroup: '.visualContainer[role="group"], [aria-roledescription]',
  visualContent: '[data-testid="visual-content-desc"], .visual',
  visualTitle: '[data-testid="visual-title"], .visualTitle',
  spinner: ['[data-testid="spinner"]', '.powerbi-spinner', '.circle-spinner', 'spinner', '.loadingVisual'],

  // Page navigation, tried in order.
  pageItems: [
    '[data-testid="pages-navigation-list-items"]',
    'button.sectionItem',
    '.pagesNav [role="tab"]',
    '[data-testid="pages-pane"] [role="tab"]',
    '[aria-label="Pages"] [role="tab"]',
    '.pageNavigation [role="tab"]',
  ],
  pageItemActive: '.selected, [aria-selected="true"], [aria-current="page"], [aria-current="true"], .isActive, .active',
  pageListToggle: ['.navigation-wrapper .middleText', '[data-testid="pages-navigation-toggle"]', 'button[aria-label*="Pages" i][aria-expanded="false"]'],
  nextPage: ['button[aria-label="Next Page"]', 'button[aria-label="Next page"]', '[data-testid="next-page-button"]'],
  prevPage: ['button[aria-label="Previous Page"]', 'button[aria-label="Previous page"]', '[data-testid="previous-page-button"]'],
  pageCounter: '.navigation-wrapper .middleText',

  // Interaction affordances.
  dataPoint: 'svg [role="option"][aria-label]:not(text), svg .bar[role="option"], svg path[role="option"], svg circle[role="option"]',
  slicerItem: '.slicerItemContainer',
  slicerDropdown: '[data-testid="slicer-dropdown"], .slicer-dropdown-menu',
  slicerClear: '.slicer-header-clear, [aria-label="Clear selections"]',
  slicerHeader: '.slicer-header-text',
  slicerRangeInputs: 'input.date-slicer-input, .date-slicer input, input[type="text"].sliderInput, .slider input',
  matrixExpander: '[role="grid"] [aria-expanded="false"], [role="treegrid"] [aria-expanded="false"], .expandCollapseButton[aria-expanded="false"]',
  contextMenuItem: '[role="menuitem"], [role="menuitemcheckbox"]',
  tooltip: ['.tooltip-container', '[data-testid="visual-tooltip"]', '.visual-tooltip', '[role="tooltip"].tooltip-container'],
  resetToDefault: ['button[aria-label="Reset to default"]', '[data-testid="reset-to-default-btn"]'],
  resetConfirm: ['button[data-testid="dailog-ok-btn"]', 'button[aria-label="Reset"]', '.mat-dialog-actions button.primary', 'button:has-text("Reset")'],

  // Header affordances (visible on hover). Matched by accessible name, which
  // is far more stable than class names.
  headerButtonLabels: {
    drillUp: '^drill up',
    nextLevel: 'go to the next level|next level in the hierarchy',
    expandAll: 'expand all down one level|expand all',
    drillMode: 'turn on drill down|drill down',
  },
  contextMenuLabels: {
    drillDown: '^(drill down|drill-down)$',
    drillUp: '^(drill up|drill-up)$',
    expandNext: '^(expand to next level|show next level|expand)$',
    drillThrough: '^drill ?-?through$',
  },

  // Detects report-level / visual-level failures.
  reportErrorText: "this content isn't available|we couldn't load the report|couldn't connect to the report|report not found|you don't have access|access denied|something went wrong",
  visualErrorText: "can't display this visual|couldn't load the data|couldn't retrieve the data|something went wrong|visual has exceeded the available resources|cannot display the visual|error fetching data|couldn't load this visual|see details",
  loginUrl: 'login\\.microsoftonline\\.com|login\\.windows\\.net|login\\.live\\.com|/signin|/singleSignOn',

  // Visual classification by type token (`visual-<type>` class).
  types: {
    button: ['actionButton', 'button'],
    navigator: ['pageNavigator', 'bookmarkNavigator'],
    slicer: ['slicer', 'advancedSlicerVisual', 'listSlicer', 'textSlicer', 'buttonSlicer'],
    table: ['tableEx', 'table'],
    matrix: ['pivotTable', 'matrix'],
    card: ['card', 'multiRowCard', 'cardVisual', 'kpi', 'gauge'],
    decorative: ['shape', 'image', 'basicShape', 'textbox', 'actionButtonShape'],
  },
};

export function resolveSelectors(overrides = {}) {
  const merged = structuredClone(DEFAULT_SELECTORS);
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof merged[k] === 'object' && !Array.isArray(merged[k])) {
      merged[k] = { ...merged[k], ...v };
    } else if (v !== undefined && v !== null && v !== '') {
      merged[k] = v;
    }
  }
  return merged;
}

export const asList = (s) => (Array.isArray(s) ? s : [s]);
export const joinSel = (s) => asList(s).join(', ');
