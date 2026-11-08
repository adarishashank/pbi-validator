// Builds the user guide in two formats from one source:
//   docs/PBI-Report-Test-User-Guide.docx  (Word)
//   docs/USER-GUIDE.md                    (Markdown, shown on GitHub)
// Run:  npm --prefix docs/guide-source install && node docs/guide-source/build.js
// Screenshots live in docs/images (JPEG).
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, ShadingType,
  AlignmentType, HeadingLevel, LevelFormat, BorderStyle, PageBreak, Header, Footer, PageNumber, TabStopType,
} = require('docx');

const DOCS = path.join(__dirname, '..');
const IMG = path.join(DOCS, 'images');
const md = []; // Markdown blocks, collected in document order by the helpers below
const mdCell = (t) => String(t).replace(/\|/g, '\\|').split('\n').join('<br>');
const SITE = 'https://pbireporttest.adarishashank-klu.workers.dev';
const FONT = 'Arial';
const MONO = 'Consolas';
const CONTENT_W = 9026; // A4 width 11906 minus 2 × 1440 margins (DXA)
const BLUE = '1D4ED8', DARK = '111827', GREY = '6B7686';

// ------------------------------------------------------------- helpers
/** Inline markup: **bold**, `code`. */
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), font: FONT, ...base }));
    const t = m[0];
    if (t.startsWith('**')) out.push(new TextRun({ text: t.slice(2, -2), bold: true, font: FONT, ...base }));
    else out.push(new TextRun({ text: t.slice(1, -1), font: MONO, size: (base.size || 21) - 1, color: '0F3E8A', ...base, bold: false }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), font: FONT, ...base }));
  return out;
}
const P = (text, opts = {}) => { md.push(text); return new Paragraph({ children: runs(text, opts.run), spacing: { after: 120, line: 288 }, ...opts.para }); };
const H1 = (t) => { md.push(`## ${t}`); return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t })] }); };
const H2 = (t) => { md.push(`### ${t}`); return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t })] }); };
const H3 = (t) => { md.push(`#### ${t}`); return new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t })] }); };
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

let mdStep = 0;
const bullets = (items, level = 0) => (md.push(items.map((t) => `${level ? '   '.repeat(level) : ''}- ${t}`).join('\n')), items).map((t) => new Paragraph({
  numbering: { reference: 'bullets', level }, children: runs(t), spacing: { after: 60, line: 276 },
}));
let listInstance = 0;
/** Numbered steps; each call restarts at 1 (stepsCont continues the previous list). */
function steps(items) {
  listInstance += 1;
  mdStep = 0;
  md.push(items.map((t) => `${++mdStep}. ${t}`).join('\n'));
  return items.map((t) => new Paragraph({
    numbering: { reference: 'steps', level: 0, instance: listInstance }, children: runs(t), spacing: { after: 80, line: 276 },
  }));
}

function stepsCont(items) {
  md.push(items.map((t) => `${++mdStep}. ${t}`).join('\n'));
  return items.map((t) => new Paragraph({
    numbering: { reference: 'steps', level: 0, instance: listInstance }, children: runs(t), spacing: { after: 80, line: 276 },
  }));
}

const KIND = {
  tip: { fill: 'E9F7EE', border: '15803D', label: 'Tip' },
  note: { fill: 'E8EFFF', border: '2563EB', label: 'Note' },
  warn: { fill: 'FEF7D7', border: 'A16207', label: 'Important' },
};
function callout(kind, text) {
  const k = KIND[kind];
  md.push(`> **${k.label}:** ${text}`);
  return new Paragraph({
    children: [new TextRun({ text: `${k.label}: `, bold: true, font: FONT, color: k.border }), ...runs(text)],
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: k.fill },
    border: { left: { style: BorderStyle.SINGLE, size: 24, color: k.border, space: 8 } },
    indent: { left: 160, right: 160 },
    spacing: { before: 120, after: 180, line: 276 },
  });
}

/** Width/height of a JPEG from its SOF marker. */
function jpegSize(b) {
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1], len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('Not a JPEG');
}
let figNo = 0;
function figure(file, caption, maxW = 600) {
  figNo += 1;
  const jpg = file.replace(/\.png$/, '.jpg');
  const f = path.join(IMG, jpg);
  const data = fs.readFileSync(f);
  const { w, h } = jpegSize(data);
  md.push(`![${caption}](images/${jpg})\n*Figure ${figNo}. ${caption}*`);
  const width = maxW, height = Math.round(maxW * h / w);
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, keepNext: true,
      children: [new ImageRun({ type: 'jpg', data, transformation: { width, height },
        altText: { title: caption, description: caption, name: file } })],
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE5', space: 2 }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE5', space: 2 },
        left: { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE5', space: 2 }, right: { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE5', space: 2 } },
    }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [new TextRun({ text: `Figure ${figNo}. ${caption}`, italics: true, size: 18, color: GREY, font: FONT })] }),
  ];
}

const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE5' };
const borders = { top: border, bottom: border, left: border, right: border };
/** rows[0] is the header. widths in DXA, must sum to CONTENT_W. */
function table(rows, widths) {
  md.push([`| ${rows[0].map(mdCell).join(' | ')} |`, `|${rows[0].map(() => '---').join('|')}|`, ...rows.slice(1).map((row) => `| ${row.map(mdCell).join(' | ')} |`)].join('\n'));
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum !== CONTENT_W) throw new Error(`table widths ${sum} != ${CONTENT_W}`);
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map((r, ri) => new TableRow({
      tableHeader: ri === 0,
      cantSplit: true,
      children: r.map((cell, ci) => new TableCell({
        borders,
        width: { size: widths[ci], type: WidthType.DXA },
        shading: ri === 0 ? { type: ShadingType.CLEAR, color: 'auto', fill: '1F2937' } : (ri % 2 === 0 ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F6F7F9' } : undefined),
        margins: { top: 70, bottom: 70, left: 110, right: 110 },
        children: String(cell).split('\n').map((line) => new Paragraph({
          spacing: { after: 20, line: 264 },
          children: runs(line, ri === 0 ? { bold: true, color: 'FFFFFF', size: 19 } : { size: 19 }),
        })),
      })),
    })),
  });
}
const gap = () => new Paragraph({ spacing: { after: 120 }, children: [] });

// ------------------------------------------------------------- content
md.push('# PBI Report Test: onboarding and user guide', '*For everyone joining the team, viewers and editors. Also available as [Word](PBI-Report-Test-User-Guide.docx) and [PDF](PBI-Report-Test-User-Guide.pdf).*');
const title = [
  new Paragraph({ spacing: { before: 2400, after: 120 }, children: [new TextRun({ text: 'PBI Report Test', font: FONT, size: 60, bold: true, color: DARK })] }),
  new Paragraph({ spacing: { after: 360 }, children: [new TextRun({ text: 'Onboarding and user guide for viewers and editors', font: FONT, size: 32, color: '374151' })],
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: 'F2C811', space: 12 } } }),
  P('Automated end-to-end testing of Power BI reports: pages, visuals, numbers and interactions, with screenshots, data differences, AI explanations and PDF/Excel exports.', { run: { size: 22, color: '374151' } }),
  gap(),
  table([
    ['Item', 'Details'],
    ['Website', `\`${SITE}\``],
    ['Who this is for', 'Everyone joining the team (onboarding), viewers, and editors'],
    ['Administrator', 'Shashank Adari (shashank.adari@cliffitsolutions.com)'],
    ['Version', 'PBI Report Test 1.0 · November 2026'],
  ], [2200, CONTENT_W - 2200]),
  gap(),
  H2('Contents'),
  ...bullets([
    '**1. Welcome**: what PBI Report Test does, roles, key terms',
    '**2. Onboarding**: getting access, first sign-in, finding your way around, your account',
    '**3. Viewer guide**: dashboard, runs, reviewing results, AI insights, exporting, trends, what changed',
    '**4. Editor guide**: Power BI sign-ins, report links, test suites and schedules, running and reviewing tests, accepting expected differences, sharing, data models and deeper drilling',
    '**5. Troubleshooting**',
    '**6. Glossary**',
  ]),
  pageBreak(),
];

const welcome = [
  H1('1. Welcome'),
  P('PBI Report Test checks Power BI reports for you. It opens each report in a real browser, goes through every page, reads every visual and its numbers, clicks buttons, applies slicers, drills into hierarchies and hovers tooltips. It compares two versions of a report, for example **PROD** against **DEV**, and reports every difference with screenshots, the changed values and a plain-English AI explanation.'),
  P('Typical uses:'),
  ...bullets([
    'Before a release: confirm the DEV/UAT version of a report matches PROD, or that only the intended changes are there.',
    'After a dataset refresh or a DAX/measure change: spot numbers that moved unexpectedly.',
    'Regular health checks: catch visual errors, broken buttons and missing pages early.',
    'Sharing evidence: send a PDF or Excel report of a run to managers and stakeholders.',
  ]),
  H2('1.1 Roles'),
  P('Everyone signs in with their own account. Your role decides what you can do:'),
  table([
    ['Role', 'What you can do', 'Typical person'],
    ['**Viewer**', 'See the dashboard, runs, screenshots, data differences and AI analysis. Ask the AI questions about a run. Download PDF, Excel and other exports.\nCannot change anything or start runs.', 'Managers, stakeholders, report consumers'],
    ['**Editor**', 'Everything a viewer can, plus: add report links, connect Power BI sign-ins, create and edit test suites, start, cancel and delete runs, run AI analysis and publish results.', 'BI developers, testers'],
    ['**Admin**', 'Everything an editor can, plus: add and manage users, settings and the audit log.', 'Team lead / owner'],
  ], [1500, 5226, 2300]),
  gap(),
  H2('1.2 Key terms'),
  table([
    ['Term', 'Meaning'],
    ['**Report link**', 'A saved Power BI report address (for example the PROD or the DEV version), with a friendly name and label.'],
    ['**Report A / Report B**', 'In a comparison, A is the baseline (usually PROD) and B is the candidate being checked (usually DEV or UAT).'],
    ['**Test suite**', 'A saved test: which reports to compare and which checks to run, with tolerances. You run a suite as often as you like.'],
    ['**Run**', 'One execution of a suite. A run produces many checks and a result (Passed, Differences found, Failed…).'],
    ['**Check (result)**', 'One individual test inside a run, for example "Card · Total Sales" or "Click button · Go to Details".'],
    ['**Power BI sign-in**', 'The Microsoft account the tool uses to open secured reports. Not related to how you sign in to this website.'],
  ], [2300, CONTENT_W - 2300]),
  pageBreak(),
];

const onboarding = [
  H1('2. Onboarding: getting started'),
  H2('2.1 How you get access'),
  P('An administrator creates your account. You receive **sign-in instructions** by Teams or email with three things:'),
  ...bullets([
    `The sign-in address: \`${SITE}\``,
    'Your email address (this is your user name)',
    'A **temporary password**, for example `Kp7m-Wq4x-Hr9t-Bz3c`',
  ]),
  callout('warn', 'The temporary password works **once** and **expires after 72 hours**. If it has expired, ask your administrator for a new one. There is no self-registration.'),
  H2('2.2 Your first sign-in'),
  ...steps([
    'Open the sign-in address in Chrome, Edge, Safari or Firefox. Bookmark it.',
    'If you see **"PBI Report Test is waking up"**, wait: the site sleeps when nobody uses it and takes up to a minute to start. The page refreshes by itself.',
    'Enter your email and the temporary password, then click **Sign in** (Figure 1). Click **Show** to check what you typed; a warning appears if Caps Lock is on.',
    'Choose your own password (Figure 2). It must have **at least 10 characters**, must not be a common password, and must not contain the part of your email before the @. The checklist turns green when it is acceptable.',
    'Click **Save password and continue**. You arrive on the **Dashboard** (Figure 3).',
  ]),
  ...figure('01-sign-in.png', 'The sign-in page'),
  ...figure('02-choose-password.png', 'Choosing your own password at first sign-in'),
  ...figure('03-dashboard-viewer.png', 'The dashboard, as a viewer sees it'),
  H2('2.3 Finding your way around'),
  P('The menu on the left takes you everywhere:'),
  table([
    ['Menu item', 'What it is for'],
    ['**Dashboard**', 'Totals, pass rate of the last 50 runs, recent runs, and warnings that need attention.'],
    ['**Report links**', 'The Power BI reports the team tests (PROD, DEV, UAT…).'],
    ['**Test suites**', 'Saved tests: which reports to compare and what to check. Editors start runs here.'],
    ['**Runs**', 'Every test run with its result. Open a run to see screenshots, differences and AI analysis.'],
    ['**Power BI sign-ins**', 'The Microsoft accounts used to open secured reports (editors manage these).'],
    ['**Admin**', 'Users, settings and audit log (administrators only).'],
  ], [2300, CONTENT_W - 2300]),
  gap(),
  P('At the bottom of the menu you see your name and role (click it to open **My account**), **Sign out**, whether a test is running ("Idle · ready" or "Validation running") and whether AI analysis is available. Viewers also see a "Read-only access" note.'),
  H2('2.4 My account'),
  P('Click your name at the bottom of the menu (Figure 4). There you can:'),
  ...bullets([
    '**Change your display name.**',
    '**Change your password.** Other devices are signed out when you do.',
    '**See signed-in devices** and sign them out, for example a computer you no longer use.',
    '**Create personal API keys** for automation (editors, see 4.10). A key is shown only once.',
  ]),
  ...figure('15-my-account.png', 'My account: profile, password, devices and API keys'),
  H2('2.5 Staying signed in, and security'),
  ...bullets([
    '**Keep me signed in** is ticked by default. Untick it on shared or public computers: you are then signed out when the browser closes.',
    'You are signed out automatically after **72 hours without activity**, and after **30 days** at most.',
    'After several wrong passwords, sign-in is blocked for **15 minutes**.',
    'Never share your password. Each person must have their own account; ask your administrator to add colleagues.',
    'Everything you change is recorded in an audit log (who, what, when, from where).',
  ]),
  H2('2.6 Forgotten password'),
  P('Click **Forgot password?** on the sign-in page for a reminder, then ask your administrator. They click **Reset password** next to your name and send you a new temporary password; sign in with it and choose a new password as in 2.2.'),
  H2('2.7 For administrators: adding a team member'),
  ...steps([
    'Go to **Admin → Users** and click **+ Add user** (Figure 5).',
    'Enter the person\'s work email and name, and choose the role: **Viewer** (read-only), **Editor** or **Admin**.',
    'Click **Add user and generate password**. A temporary password is created automatically (Figure 6).',
    'Click **Copy sign-in instructions** and send the message by Teams or email. It contains the address, email, temporary password and expiry.',
  ]),
  ...figure('16-add-user.png', 'Adding a user: the temporary password is generated automatically', 560),
  ...figure('17-user-added.png', 'The new user\'s temporary password and ready-to-send sign-in instructions', 560),
  ...bullets([
    'The Users list shows **Invited · expires in 3 days**, **Temp password expired** or **Active**.',
    '**New temporary password** issues a fresh one (the old one stops working immediately).',
    '**Edit** changes the role; **Disable** blocks access without deleting history; **Delete** removes the account (runs they started are kept).',
  ]),
  pageBreak(),
];

const viewer = [
  H1('3. Viewer guide'),
  P('As a viewer you can look at everything and share results, but you cannot change settings or start tests. Buttons for editing are hidden for you.'),
  H2('3.1 The dashboard'),
  P('The dashboard (Figure 3) shows the number of report links, test suites and runs, the **pass rate** of the last 50 runs, and the most recent runs. A yellow banner means a Power BI sign-in needs attention; this is for editors to fix and does not affect what you can see. Click a run to open it, or **All runs →** for the full list.'),
  H2('3.2 The Runs page'),
  P('The Runs page (Figure 7) lists every run, newest first, with its suite, result, counts per status, who started it, when, and how long it took.'),
  ...bullets([
    'Use **All suites** and **Any result** at the top to filter.',
    '**Export to Excel** downloads the list as a workbook.',
    '**⇩ PDF** on a row downloads that run\'s PDF report directly.',
    'Click a row to open the run.',
  ]),
  ...figure('04-runs.png', 'The Runs page'),
  P('A run ends with one of these results:'),
  table([
    ['Run result', 'Meaning'],
    ['**Passed**', 'Every check passed (warnings and skipped checks allowed).'],
    ['**Differences found**', 'Only visual or data differences were found. Review them: they may be intended changes.'],
    ['**Failed**', 'At least one check failed, something is missing, or a visual errored. Needs attention.'],
    ['**Error**', 'The run could not finish, for example the report could not be opened. The message on the run page explains why.'],
    ['**Cancelled**', 'Someone stopped the run. Results captured until then are kept.'],
  ], [2300, CONTENT_W - 2300]),
  gap(),
  H2('3.3 Reviewing a run'),
  P('The run page (Figure 8) shows the result, who started it and when at the top, then the two reports compared (A ⇄ B) and a row of filter chips.'),
  ...bullets([
    'The run opens on **Problems**: only the checks that need attention. Click **All** to see every check, or a status chip (Fail, Missing, Diff…) to see only those.',
    'Below the chips, filter by **scenario** (Visual, Button, Slicer…), by **page**, or search titles.',
    'Checks are grouped by report page. Each row shows the status, the scenario, the title, small screenshots and the percentage of pixels that differ.',
    'The tabs switch between **What changed** (comparisons only, see 3.8), **Results**, **AI insights**, **Ask AI**, **Coverage** (a table of statuses per scenario) and **Log** (technical progress messages).',
  ]),
  ...figure('05-run-problems.png', 'A run, filtered to the checks that need attention'),
  P('Each check has a status:'),
  table([
    ['Status', 'Meaning', 'What to do'],
    ['**Pass**', 'A and B match (within the suite\'s tolerances).', 'Nothing.'],
    ['**Diff**', 'Screenshots or values differ.', 'Look at the images and data: intended change or a mistake?'],
    ['**Fail**', 'Behaviour differs, for example a button goes to a different page.', 'Investigate; usually a defect.'],
    ['**Missing**', 'A page or visual exists on one side only.', 'Check whether it was removed or renamed on purpose.'],
    ['**Warning**', 'Something unusual that is not a definite failure, for example an interaction with no visible effect.', 'Review when convenient.'],
    ['**Error**', 'The check could not be completed, or a visual shows an error.', 'Investigate; may also be a report error.'],
    ['**Accepted**', 'A difference an editor marked as expected (for example an intended change). Shown for transparency; it does not count as a problem.', 'Nothing. Open it to see who accepted it and why.'],
    ['**Skipped**', 'Not applicable or turned off.', 'Nothing.'],
  ], [1400, 4126, 3500]),
  gap(),
  H2('3.4 Looking at one check'),
  P('Click a check to open it (Figure 9):'),
  ...bullets([
    '**Side by side**: A, B, and B with the differing areas outlined in red.',
    '**Swipe**: drag the slider to wipe between A and B. Good for small shifts.',
    '**Pixel diff**: differing pixels highlighted in red.',
    '**Outlined differences**: B with red boxes around each differing region.',
    'Click any image to enlarge it.',
    '**Data differences**: a table of the values read from the visual in A and B. Added lines are green, removed lines red, changed lines yellow.',
    '**AI screenshot analysis**: a short description of what changed, its severity, and whether it is probably just rendering noise.',
    'Use the **← →** arrow keys (or Previous / Next) to step through checks. **Esc** closes the window.',
  ]),
  ...figure('06-result-detail.png', 'One check: side-by-side screenshots and the AI explanation'),
  H2('3.5 AI insights and Ask AI'),
  P('When AI analysis is available, the **AI insights** tab summarises the run (Figure 10):'),
  ...bullets([
    'A one-line **verdict** and a **risk level** (none, low, medium, high, critical).',
    'A short **summary** written for a release manager.',
    '**Likely root causes**, for example "Dataset refresh or measure/DAX change", with confidence and the checks behind them. Click a number like **#11** to open that check.',
    '**Next steps**, **Triaged findings** grouped by severity, **Data anomalies** (numbers that look inconsistent), and **Probably noise** (differences that are likely harmless).',
  ]),
  ...figure('07-ai-insights.png', 'AI insights: verdict, risk, summary and likely root causes'),
  P('On the **Ask AI** tab you can ask questions in plain English, for example "Which numbers changed on the Overview page?" or "Why did the Region slicer check fail?". Answers refer to the checks they are based on.'),
  callout('warn', 'AI output can be wrong. Treat it as a helpful starting point and confirm important conclusions with the screenshots and data differences.'),
  H2('3.6 Exporting and sharing'),
  P('On a run page, click **⇩ Download PDF**, or open **Export** for other formats (Figure 11). The AI insights tab also has **Download as PDF** and **Excel** buttons.'),
  ...figure('08-export-menu.png', 'Export options on the run page'),
  table([
    ['Format', 'Contains', 'Best for'],
    ['**PDF report**', 'Cover with result and AI risk, summary, AI findings and root causes, every check needing attention with screenshots, questions asked to the AI, and a list of all checks.', 'Managers and stakeholders; release evidence'],
    ['**Excel workbook (.xlsx)**', 'Sheets: Summary, Checks (every check with what went wrong), AI analysis, AI questions.', 'Filtering, sorting, tracking fixes'],
    ['**Interactive HTML (.zip)**', 'An offline copy of the run with all screenshots; open index.html after unzipping.', 'Sharing the full detail with someone without an account'],
    ['**JSON / JUnit XML**', 'Raw data and test results in standard formats.', 'Scripts and CI dashboards'],
  ], [2300, 4426, 2300]),
  gap(),
  callout('tip', 'Building a PDF takes a few seconds; a message appears while it is prepared and when it has downloaded.'),
  H2('3.7 Trends'),
  P('To see how a suite is doing over time, click **Trends** on its card in **Test suites**, or on the Runs page when it is filtered to one suite (Figure 12). The dashboard also shows a chart of the last 30 runs once there are at least two.'),
  ...bullets([
    'The tiles show the number of runs, the share that passed, how many checks needed attention in the last run (and whether that went up or down), and the average run time.',
    '**Check outcomes per run**: one column per run, split into **Passed** (green), **Accepted as expected** (blue) and **Needs attention** (red). Hover a column for the numbers; click it to open the run.',
    '**Run time**: how long each run took.',
    'Choose the last 10, 30 or 90 runs at the top, or tick **Show as table** to see the same numbers as a table.',
  ]),
  ...figure('f6-trends.png', 'Trends for one suite, with a column\'s details on hover'),
  H2('3.8 What changed'),
  P('For a comparison run, the **What changed** tab answers "what is different in B?" from the top down: the whole report, then each page, then each visual, then the exact values (Figure 13).'),
  ...bullets([
    '**The headline** sums it up in one line, for example "pages: 1 removed, 1 renamed · visuals: 1 added, 1 removed · 4 value changes in 2 visuals · data model: 5 changes".',
    '**The tiles** count pages changed, visuals added or removed, values changed and interactions that behave differently (buttons, slicers, drills, cross-filters, tooltips).',
    '**Data model** compares the two semantic models: tables, columns, measures (DAX), relationships and security roles. Click a group, for example **Measures (DAX)**, to list what was added, removed or changed, and **Show the difference** to see the old and new DAX side by side. If the model could not be read, the panel says why; editors can fix that (4.12).',
    '**Pages** is a heatmap with one tile per page, from **No change** (grey) to **High** (dark blue). The level is always written on the tile too. "Only in A" means the page was removed or hidden in B; "Trends → Trend Analysis" means it was renamed.',
  ]),
  ...figure('f7-what-changed.png', 'What changed: headline, totals, data model and the page heatmap'),
  P('Click a page tile to open that page (Figure 14):'),
  ...bullets([
    '**Layout**: visuals added, removed, moved, resized or retitled.',
    '**Visuals**: every visual that looks or reads differently. Click its name to see each changed value, **A (before)** in red and **B (after)** in green. "No data change" means only the picture differs.',
    '**Interactions that behave differently**: for example a button that goes to another page, or a drill that shows other numbers at level 2.',
    '**Open check** opens the full evidence: screenshots, data and the AI explanation. Click **Report** in the breadcrumb to go back to all pages.',
  ]),
  ...figure('f8-what-changed-page.png', 'One page: the changed value of a card, and the interactions that differ'),
  callout('tip', 'The PDF report has the same summary near the top, and the Excel export adds the sheets **What changed**, **Value changes** and **Model changes**.'),
  pageBreak(),
];

const editor = [
  H1('4. Editor guide'),
  P('Editors set up and run the tests. Everything in the viewer guide applies to you too.'),
  H2('4.1 The workflow at a glance'),
  ...steps([
    '**Connect a Power BI sign-in** for secured reports (not needed for public "publish to web" links).',
    '**Add report links** for each version you want to test, for example PROD and DEV.',
    '**Create a test suite** that compares A (baseline) with B (candidate) and chooses the checks.',
    '**Run** the suite and follow its progress.',
    '**Review** the problems, with help from the AI insights.',
    '**Share** the result as a PDF or Excel file, then fix and re-run as needed.',
  ]),
  H2('4.2 Power BI sign-ins'),
  P('Secured reports on app.powerbi.com need a Microsoft account to open them. A **Power BI sign-in** stores that session so tests can run unattended (Figure 15).'),
  ...steps([
    'Go to **Power BI sign-ins** and click **+ New sign-in**. Give it a clear name, for example "Contoso · QA account".',
    'Click **Sign in**. A window shows the Microsoft sign-in page, live, from a browser running on the PBI Report Test server (Figure 16). Click into the page and sign in as usual: email, password, then MFA (for example approve the number in Microsoft Authenticator). Tick **Stay signed in** when asked.',
    'When Power BI opens, the session is saved and the window closes by itself. Click **Check** to confirm the status is **Active**.',
  ]),
  ...figure('14-powerbi-signins.png', 'Power BI sign-ins'),
  ...figure('f11-web-signin.png', 'Signing in from the website: the sign-in page is shown live; click and type into it'),
  ...bullets([
    'What you type goes to that browser over an encrypted connection and is not stored or logged. Only the resulting Power BI session is saved.',
    'If typing doesn\'t reach the page (for example on a phone or with a password manager), open **Typing doesn\'t work?** under the picture, click the field in the page, then type in the box and click **Send**.',
    'The window closes after 5 minutes without activity; click **Sign in** again to restart.',
    'Alternative: on a computer with PBI Report Test installed, run `npm run login -- "Contoso · QA account"`, then click **Import** next to the sign-in and choose the file it produced.',
  ]),
  ...bullets([
    'Use a dedicated test account where possible, not your personal account.',
    'If reports A and B live in different tenants, create one sign-in for each.',
    'Sessions expire. When one does, the dashboard shows a warning and runs report "Redirected to sign-in"; sign in or import again.',
  ]),
  H2('4.3 Report links'),
  P('Go to **Report links** and click **+ Add report link** (Figures 17 and 18):'),
  table([
    ['Field', 'What to enter'],
    ['**Name**', 'A friendly name, for example "Sales Overview".'],
    ['**Environment / label**', 'PROD, DEV, UAT… Shown next to the name everywhere.'],
    ['**Report URL**', 'Any Power BI address: service link (app.powerbi.com/groups/…/reports/…), app link, embed link or publish-to-web link (…/view?r=…). Any page of the report works; all pages are found automatically.'],
    ['**Power BI sign-in**', 'The sign-in to use. Choose "None" for public publish-to-web links.'],
    ['**Tags / Notes**', 'Optional, for your own organisation.'],
  ], [2300, CONTENT_W - 2300]),
  gap(),
  P('Click **Discover** on a report link to check it before testing: the tool opens the report and lists its pages with thumbnails, the number of visuals, and the buttons, slicers and charts it found. If it cannot open the report, the message tells you why, for example "Sign-in required".'),
  ...figure('09-report-links.png', 'Report links'),
  ...figure('10-add-report-link.png', 'Adding a report link', 560),
  H2('4.4 Test suites'),
  P('Go to **Test suites** and click **+ New suite** (Figures 19 to 21). The editor has four tabs.'),
  H3('Basics'),
  ...bullets([
    '**Suite name** and an optional **description** ("what is this suite protecting?").',
    '**Mode**: **Compare A ⇄ B** compares a baseline (A) with a candidate (B). **Validate single report** checks one report\'s rendering, visual errors and interactions on its own.',
    '**Report A (baseline)** and **Report B (candidate)**: choose from your report links.',
    '**Schedule (optional)**: a cron expression, for example `0 6 * * 1-5` for weekdays at 06:00 India Standard Time. Leave empty to run on demand.',
    '**Pages to include / exclude**: one per line, exact page names or a pattern like `/^Tooltip/`. Empty means all pages.',
  ]),
  callout('note', 'Schedules work even while the website is asleep: it wakes up by itself when a suite is due, runs it, and goes back to sleep. Times are **India Standard Time (Asia/Kolkata)**. If a scheduled run was missed (for example during maintenance), it runs once as soon as possible, unless it is more than 24 hours late. The suite card shows when the next run is due.'),
  ...figure('12-new-suite.png', 'A new test suite: Basics', 560),
  H3('Scenarios: what to check'),
  P('The page inventory (pages added, removed, renamed or reordered) is always checked. Turn the other scenarios on or off:'),
  table([
    ['Scenario', 'What it checks'],
    ['**Page render**', 'Full-page screenshot of every page, plus visual errors.'],
    ['**Layout & inventory**', 'Visuals missing, added, moved, resized or retitled.'],
    ['**Every visual**', 'A screenshot and the data of each visual (cards, tables, matrices, chart values).'],
    ['**Buttons & navigators**', 'Clicks buttons and page/bookmark navigators and checks where they go and what changes.'],
    ['**Slicers**', 'Applies slicer values and compares the filtered page and data.'],
    ['**Hierarchy drill**', 'Drills down, expands all and goes to the next level on hierarchical visuals, level by level (for example Year → Quarter → Month), and compares every level.'],
    ['**Drill-through**', 'Right-clicks a data point → Drill through to each target page, and compares the page each report lands on.'],
    ['**Matrix +/- expand**', 'Expands matrix row groups and compares the expanded data.'],
    ['**Cross-filtering**', 'Clicks data points and compares how the rest of the page reacts.'],
    ['**Tooltips**', 'Hovers data points and compares tooltip content.'],
    ['**Data model**', 'Compares the two semantic models: tables, columns, measures (DAX), relationships, security roles and shared queries (see 4.12).'],
  ], [2500, CONTENT_W - 2500]),
  gap(),
  ...figure('13-suite-scenarios.png', 'Choosing scenarios, coverage limits and AI options', 560),
  P('On the same tab, **coverage limits** set how much is tested (for example values per slicer, buttons per page, **drill depth** and **data points drilled per visual**): higher is more thorough but slower (see 4.12 for how much slower). **AI analysis** options turn on the automatic AI summary after each run and AI explanations of screenshot differences.'),
  H3('Tolerances & ignores'),
  ...bullets([
    '**Max differing pixels (%)**: above this a screenshot counts as different. Raise it slightly if harmless anti-aliasing creates Diff results.',
    '**Per-pixel colour tolerance**, **layout jitter (px)** and **position/size tolerance (px)**: ignore tiny rendering shifts.',
    '**Numeric tolerance**: for example `0.001` treats values within 0.1% as equal (useful for rounding).',
    '**Retries per scenario**: retry flaky interactions.',
    '**Ignore visual types / titles**, **ignore text patterns** (for example `Last refreshed: .*`) and **mask in screenshots** (areas painted over in both screenshots): use these for content that changes every time, such as refresh dates.',
  ]),
  H3('Advanced'),
  P('Browser size, language, time zone, timeouts and the maximum number of visuals per page. Leave these at their defaults unless a report needs more time to load.'),
  callout('tip', 'Start with the defaults and run once. To make sure a suite raises no false alarms, create a copy with the **same report as A and B**: it should pass. Then tune tolerances and ignores to remove noise.'),
  P('Each suite card (Figure 21) shows its last result and has **▶ Run now**, **History** (its runs), **Edit**, **Duplicate** and **Delete** (past runs are kept).'),
  ...figure('11-suites.png', 'Test suites'),
  H2('4.5 Running a test'),
  ...steps([
    'On **Test suites**, click **▶ Run now**. The run page opens.',
    'Watch the progress bar, the current phase and the **Log** tab. You can leave the page: the run continues in the background.',
    'When it finishes, the result and the **Download PDF** and **Export** buttons appear. If AI analysis is switched on, it starts automatically and takes a minute or two.',
  ]),
  ...bullets([
    '**Cancel** stops a run; results captured so far are kept.',
    '**Re-run** starts the same suite again, for example after a fix.',
    '**Delete** removes a run and its screenshots.',
    'A run takes from about a minute to ten minutes or more, depending on the number of pages, visuals and interactions. On the cloud website the app stays awake until a run has finished.',
  ]),
  H2('4.6 Reviewing and deciding'),
  ...steps([
    'Start with the **Problems** filter and the **AI insights** tab for an overview.',
    'Open each check: **Fail**, **Missing** and **Error** are almost always real issues; **Diff** needs your judgement.',
    'For each difference decide: **a defect** (raise it with the report developer) or **an intended change** (fine).',
    'If a difference is intended, **accept it as expected** (4.7). If many differences are harmless noise, adjust the suite\'s tolerances or ignores and re-run.',
    'Share the outcome (4.9) and re-run after fixes until the result is what you expect.',
  ]),
  H2('4.7 Accepting expected differences'),
  P('Some differences are intended: a new KPI, a renamed page, numbers restated on purpose. Accept them once so later runs of the suite stop flagging them, and reviewers only see what is new.'),
  ...steps([
    'Open the check in a run and click **✓ Accept as expected** (Figure 22).',
    'Choose what to accept:',
  ]),
  ...bullets([
    '**This exact difference** (recommended): later runs accept it while the difference stays the same. If the values, behaviour or missing items change again, it is flagged again.',
    '**Any difference in this check**: for content that legitimately changes every time, such as a visual showing today\'s figures. The check is not flagged for this suite until you stop accepting it.',
  ], 1),
  ...stepsCont([
    'Add a short reason, for example "New KPI added in release 4.2", and click **Accept**.',
  ]),
  ...figure('f2-accept-dialog.png', 'Accepting a difference as expected', 560),
  P('The check now shows **Accepted**, with who accepted it, when and why (Figure 23), and the run\'s result is recounted straight away. Accepted checks are listed separately in the PDF report and marked in the Excel workbook.'),
  ...figure('f3-accepted.png', 'An accepted check, with the reason and a Stop accepting button', 560),
  ...bullets([
    'To undo, click **Stop accepting** on the check, or open the suite (**Edit**) and use the **Accepted differences** tab, which lists every accepted difference with how often it has matched since.',
    'Undoing flags the check again in every run of the suite where it was accepted.',
    'Accept only what you have checked. When in doubt, ask the report developer first.',
  ]),
  H2('4.8 AI analysis'),
  ...bullets([
    'On the **AI insights** tab, click **Analyse with AI** (or **↻ Re-analyse** for a new analysis after changes).',
    'In a check, **Explain with AI** describes the screenshot difference; **↻ Re-explain** asks again.',
    'Viewers can read the analysis and use **Ask AI**, but only editors can start a new analysis.',
  ]),
  H2('4.9 Sharing results'),
  ...bullets([
    'Download the **PDF report** or **Excel workbook** (3.6) and attach it to an email, Teams message or ticket.',
    '**☁ Publish** sends a run to the team\'s read-only results website (when your administrator has set it up). Use **Update published copy** after re-analysing, or **Remove from results site**.',
    'Anyone with a PBI Report Test account can also be sent the run\'s address directly.',
  ]),
  H2('4.10 Good practice'),
  ...bullets([
    'Name report links and suites clearly: "Sales Overview · PROD vs DEV".',
    'Keep one suite per report pair, and duplicate a suite to try different settings.',
    'Use a dedicated Power BI test account with read access to the reports.',
    'Delete old or failed experiment runs you no longer need; runs older than 30 days are removed automatically.',
    'Check a suite\'s **Trends** now and then: a rising number of checks needing attention is an early warning.',
  ]),
  H2('4.11 Automation with API keys (optional)'),
  P('To start tests from a pipeline (for example after a deployment), create a key in **My account → + New API key**. The key acts as you, with your role, and is shown only once. Example:'),
  P(`\`curl -X POST -H "Authorization: Bearer pbiv_…" ${SITE}/api/suites/<suite-id>/run\``),
  P('The response contains the run number; open `/#/runs/<number>` on the website to follow it, or download its results from `/api/runs/<number>/report.pdf`. Delete keys you no longer use.'),
  H2('4.12 Data models and deeper drilling'),
  H3('Comparing the data models'),
  P('Many changes never show on screen: a measure\'s DAX, a relationship\'s direction, a security role\'s filter. With the **Data model** scenario on, every comparison run also compares the two semantic models. The model of each report link is read from the first source available:'),
  ...steps([
    '**A model file you upload** on the report link: in **Report links**, click **Upload model** in the Data model column (Figure 24). Accepted files: a Power BI template (**.pbit**: in Power BI Desktop, File → Export → Power BI template), a **model.bim**, a **.tmdl** file, or a **.zip** of a TMDL folder (a Power BI Project\'s "definition" folder). This works for every kind of link, including publish-to-web. Upload a new file whenever the model changes; **Replace** and **Remove** are next to it.',
    '**The Power BI service**, for app.powerbi.com links that contain the workspace and report (…/groups/…/reports/…): read with the administrator\'s service principal if one is set up, otherwise with the report link\'s Power BI sign-in. That account needs **Build** permission on the semantic model.',
  ]),
  ...figure('f9-model-upload.png', 'Report links with an uploaded model file for each report'),
  P('Each difference becomes its own check, so you can open it, see the old and new DAX side by side (Figure 25), and **Accept as expected** if it was intended. DAX that was only re-indented or re-spaced is not reported. Security roles are compared only when the account reading the model has administrator rights on it.'),
  ...figure('f10-dax-diff.png', 'A changed measure: the DAX in A and in B'),
  callout('note', 'A .pbix file can\'t be read directly: save it as a template (.pbit) and upload that. Data model checks compare the model\'s definition, not the data rows in it; the visual and interaction checks cover the numbers.'),
  H3('How deep does drilling go, and what does it cost?'),
  P('In the suite editor (**Scenarios** tab), three limits control drilling:'),
  table([
    ['Setting', 'Default', 'What it does'],
    ['**Drill depth (levels)**', '2', 'How many levels each drill follows, for example 3 for Year → Quarter → Month → Day. At each level the visual is compared again; if one report\'s hierarchy ends earlier, that is reported.'],
    ['**Data points drilled per visual**', '1', 'Drills on the first data point, or spreads across several (first, middle, last).'],
    ['**Drill-through targets per page**', '3', 'How many drill-through target pages are tried per page.'],
  ], [2600, 1000, CONTENT_W - 3600]),
  gap(),
  P('Each extra level is one more click and comparison per visual, roughly **3 to 10 seconds** on a real report (A and B drill at the same time). As a guide, for a page with 10 drillable visuals:'),
  table([
    ['Depth × data points', 'Extra time per page (approx.)'],
    ['1 × 1', 'under a minute'],
    ['2 × 1 (default)', '1 to 3 minutes'],
    ['3 × 3', '5 to 15 minutes'],
  ], [3500, CONTENT_W - 3500]),
  gap(),
  callout('tip', 'Keep the defaults for everyday suites. Raise depth and data points on a separate suite limited to the pages where hierarchies matter (Pages to include), and schedule it overnight.'),
  pageBreak(),
];

const trouble = [
  H1('5. Troubleshooting'),
  table([
    ['What you see', 'What to do'],
    ['**"PBI Report Test is waking up"**', 'Normal after a quiet period. Wait up to a minute; the page refreshes by itself. If it takes more than 3 minutes, refresh, then contact your administrator.'],
    ['**"Incorrect email or password"**', 'Check the email and watch for the Caps Lock warning. Still failing? Ask your administrator to reset your password.'],
    ['**"Too many failed attempts"**', 'Wait 15 minutes, then try again.'],
    ['**"Your temporary password has expired"**', 'Ask your administrator for a new temporary password.'],
    ['**"Your session ended"**', 'You were signed out (inactivity or a password change). Sign in again; you return to the page you were on.'],
    ['**I can\'t see buttons to add or run things**', 'You are a viewer. Ask your administrator for the editor role.'],
    ['**A run fails with "Redirected to sign-in"**', 'The Power BI sign-in expired. An editor signs in or imports it again (4.2), then re-runs.'],
    ['**Many tiny "Diff" results (fractions of a percent)**', 'Rendering noise. Raise "Max differing pixels" or "layout jitter", or mask the changing area, then re-run.'],
    ['**An intended change is flagged in every run**', 'Open the check and click **Accept as expected** (editors, see 4.7).'],
    ['**A check is "Accepted" but should not be**', 'Open it and click **Stop accepting**, or use the suite\'s Accepted differences tab.'],
    ['**A scheduled run did not happen**', 'Check the schedule on the suite card (times are India Standard Time). A run more than 24 hours late is skipped rather than run late.'],
    ['**Data model: "not compared" (Skipped)**', 'The model could not be identified, for example for a publish-to-web link. An editor uploads a .pbit, model.bim or TMDL file on the report link (4.12).'],
    ['**Data model: "Could not read the data model" (Warning)**', 'The account reading it lacks Build permission on the semantic model, or the sign-in expired. Grant access, sign in again, or upload a model file instead.'],
    ['**Runs got much slower**', 'Check the suite\'s drill depth and data points (4.12). Lower them, or limit the pages tested.'],
    ['**Microsoft blocks the sign-in ("You can\'t get there from here", device not compliant)**', 'Your organisation only allows sign-ins from managed devices. Use a test account that is allowed to sign in from servers, or ask an administrator to sign in with **npm run login** on a managed computer and **Import** the session.'],
    ['**Numbers differ only by rounding**', 'Set a numeric tolerance on the suite, for example 0.001.'],
    ['**A "last refreshed" date always differs**', 'Add an ignore text pattern such as `Last refreshed: .*`.'],
    ['**The AI tab says AI is not configured**', 'Ask your administrator to enable AI analysis.'],
    ['**A report can\'t be opened at all**', 'Use **Discover** on the report link to see the exact error: wrong address, missing permission, or sign-in needed.'],
  ], [3300, CONTENT_W - 3300]),
  gap(),
  P('For anything else, contact your administrator: **Shashank Adari** (shashank.adari@cliffitsolutions.com).'),
];

const glossary = [
  H1('6. Glossary'),
  table([
    ['Term', 'Meaning'],
    ['**A ⇄ B**', 'A comparison of a baseline report (A) with a candidate (B).'],
    ['**Accepted**', 'A difference an editor marked as expected; it no longer counts as a problem.'],
    ['**Audit log**', 'The record of sign-ins and changes, visible to administrators.'],
    ['**Baseline**', 'The version considered correct, usually PROD.'],
    ['**Candidate**', 'The version being checked, usually DEV or UAT.'],
    ['**Cross-filter**', 'Clicking a data point in one visual to filter the others on the page.'],
    ['**DAX**', 'The formula language of Power BI measures and calculated columns.'],
    ['**Data model / semantic model**', 'The tables, relationships, measures and security roles behind a report.'],
    ['**Drill down / expand**', 'Moving to a lower level of a hierarchy (for example Year → Month) in a visual. The drill depth sets how many levels are tested.'],
    ['**Drill-through**', 'Right-clicking a data point to open a detail page filtered to it.'],
    ['**Masking**', 'Painting over an area in both screenshots so it is not compared.'],
    ['**Noise**', 'Harmless differences such as anti-aliasing or a refresh timestamp.'],
    ['**Schedule**', 'A cron expression on a suite that starts it automatically, for example 0 6 * * 1-5 for weekdays at 06:00 India time.'],
    ['**Pixel diff**', 'The share of pixels that differ between two screenshots.'],
    ['**Publish to web**', 'A public Power BI link (…/view?r=…) that needs no sign-in.'],
    ['**Temporary password**', 'A generated password for first sign-in or a reset; works once and expires after 72 hours.'],
    ['**Trends**', 'Charts of a suite\'s results over time.'],
    ['**Tolerance**', 'How much difference is accepted before a check reports Diff.'],
  ], [2300, CONTENT_W - 2300]),
];

// ------------------------------------------------------------- document
const doc = new Document({
  creator: 'PBI Report Test',
  title: 'PBI Report Test: onboarding and user guide',
  description: 'Onboarding guide and usage guides for viewers and editors',
  styles: {
    default: { document: { run: { font: FONT, size: 21, color: '1F2937' } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 34, bold: true, color: DARK },
        paragraph: { spacing: { before: 120, after: 200 }, keepNext: true, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: 'F2C811', space: 6 } } } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 27, bold: true, color: BLUE },
        paragraph: { spacing: { before: 300, after: 120 }, keepNext: true, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 23, bold: true, color: DARK },
        paragraph: { spacing: { before: 200, after: 80 }, keepNext: true, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [
        { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } },
        { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 270 } } } },
      ] },
      { reference: 'steps', levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } }, run: { bold: true, color: BLUE } } },
      ] },
    ],
  },
  sections: [{
    properties: { page: { margin: { top: 1440, bottom: 1300, left: 1440, right: 1440 } } },
    headers: { default: new Header({ children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE5', space: 4 } },
      children: [new TextRun({ text: 'PBI Report Test', bold: true, size: 17, color: GREY, font: FONT }),
        new TextRun({ text: '\tOnboarding and user guide', size: 17, color: GREY, font: FONT })],
    })] }) },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 17, color: GREY, font: FONT })],
    })] }) },
    children: [...title, ...welcome, ...onboarding, ...viewer, ...editor, ...trouble, ...glossary],
  }],
});

const out = process.argv[2] || path.join(DOCS, 'PBI-Report-Test-User-Guide.docx');
fs.writeFileSync(path.join(DOCS, 'USER-GUIDE.md'), `${md.join('\n\n')}\n`);
console.log(`wrote ${path.join(DOCS, 'USER-GUIDE.md')} (${md.length} blocks)`);
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(out, buf); console.log(`wrote ${out} (${(buf.length / 1024).toFixed(0)} KB), ${figNo} figures`); });
