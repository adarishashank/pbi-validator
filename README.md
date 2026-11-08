# Power BI Validator

A self-hosted website for **end-to-end validation of Power BI reports**. Add report links, pair them in a test suite (e.g. **DEV ⇄ PROD**, or before/after a dataset change), and a headless Chromium validates both reports scenario by scenario. Every difference comes with screenshots (A, B, pixel diff, and B with the differing regions outlined) plus a data diff.

## What gets validated

| Scenario | What happens | Flags |
|---|---|---|
| **Pages** | Discovers every page in A and B | missing / extra / renamed / re-ordered pages |
| **Health** | Scans every visual for error states | "Can't display this visual", data load failures |
| **Page render** | Full-canvas screenshot of each page | pixel differences above threshold |
| **Layout & inventory** | Matches visuals by type + title, then position | missing, extra, moved, resized, retitled visuals |
| **Every visual** | Cropped screenshot + extracted content: card values, table/matrix cells, chart data points and axis labels, slicer items | pixel and **data** differences (line-level diff) |
| **Buttons & navigators** | Clicks action buttons, page/bookmark navigator items | different destination page, popup vs none, different resulting state |
| **Slicers** | Applies values (spread across the list) in A and B | different filtered page / data; value missing in B |
| **Hierarchy drill** | *Expand all down one level*, *Go to next level*, right-click → *Drill down*, drill-mode | different drilled visual / data, control missing in B |
| **Matrix +/-** | Expands row groups | different expanded rows / values |
| **Cross-filtering** | Clicks data points | different reaction of the rest of the page |
| **Tooltips** | Hovers data points | different tooltip content / rendering |

Each interaction runs in **lock-step** on both reports, then the page is restored to its initial state. Undo is tried first; if the page still doesn't match its baseline screenshot, it's reloaded. Failed scenarios are retried and screenshotted. **Single mode** validates one report on its own: health checks, plus confirming every interaction actually changes the page, with screenshots of each state.

### Result statuses
`pass` · `diff` (visual/data difference) · `fail` (functional mismatch, e.g. a button going to a different page, or a visual error) · `missing` (page/visual exists on only one side) · `warn` (interaction had no visible effect) · `skipped` · `error` (the tool couldn't execute the step; details + screenshot attached).

Run status: **passed**, **diffs** (only visual/data differences), **failed** (fail/missing/error present), **error**, or **cancelled**.

## Accounts, sign-in & admin panel

| Feature | Details |
|---|---|
| **Sign-in page** | Email + password, show/hide password, Caps Lock warning, "Keep me signed in" (untick for a browser-session cookie on shared computers), "Forgot password?" help, clear message when a session expires. |
| **Passwords** | scrypt-hashed, minimum length and common-password checks with a live checklist and strength meter, automatically generated expiring temporary passwords for new users and resets (must be changed at first sign-in), sign-in throttling. |
| **Roles** | **Viewer**: read everything, export, ask AI. **Editor**: also manage report links, suites, Power BI sign-ins and run validations. **Admin**: also users, settings, audit log. Enforced by the server on every request; viewers don't see edit buttons. |
| **Admin panel** | *Users* (add, change role, disable, reset password, sign out everywhere, delete, with last-admin protection) · *Settings* (public URL, sign-in security overview) · *Audit log* (every sign-in, failure and change, with user, IP and result; filterable) · *System* (health, storage, sessions, AI status). |
| **My account** | Change password, see and sign out other devices, create personal **API keys** (`Authorization: Bearer pbiv_…`) for CI with an expiry. |
| **Security** | HttpOnly SameSite session cookies (Secure over HTTPS), idle and absolute session expiry, origin checks on all writes, HSTS behind HTTPS, private caching for screenshots, secrets never returned or logged. |

**First run:** open `http://127.0.0.1:4400` *on the machine running the validator* to create the first administrator (or `npm run cli -- create-admin you@company.com`). From another machine, the setup page asks for the `API_TOKEN` as a setup token.

**Adding people:** Admin → Users → *Add user*. A readable temporary password (e.g. `Kp7m-Wq4x-Hr9t-Bz3c`, no look-alike characters) is **generated automatically**, shown once with a *Copy sign-in instructions* button, and expires after `TEMP_PASSWORD_HOURS` (72 h). The person must choose their own password at first sign-in. Expired or forgotten? *New temporary password* / *Reset password* on the same page.

CLI: `npm run cli -- add-user <email> --role viewer|editor|admin`, `create-admin <email>`, `reset-password <email>` (each prints an automatically generated temporary password and its expiry), `users`. The `API_TOKEN` still works as an admin Bearer token for scripts.

## AI analysis (NVIDIA open models)

With a free [NVIDIA API key](https://build.nvidia.com) in `.env` (`NVIDIA_API_KEY=nvapi-…`), every finished run is analysed automatically:

| Feature | Model (default, configurable) | Where |
|---|---|---|
| **Executive summary & triage**: headline, risk level, findings grouped and ranked by severity, likely root causes (dataset refresh, DAX/measure change, filter/RLS, layout edit, broken navigation), what's probably noise, next steps | `nvidia/nemotron-3-ultra-550b-a55b` | Run → **AI insights** |
| **Data-anomaly review**: totals that don't reconcile with breakdowns, percentages that don't add up, unexpected blanks/zeros, implausible values, unusual A→B shifts | same | Run → **AI insights** |
| **Screenshot explanations**: a vision model compares the A/B screenshots of the top differences and describes what visibly changed, flagging likely rendering noise | `nvidia/nemotron-3.5-super-vl-120b-a12b` | Each result → **AI screenshot analysis** |
| **Ask AI**: chat with a run ("Which slicer values broke?", "Is the total difference real or rounding?"), with answers citing `#check` numbers you can click | text model | Run → **Ask AI** |

AI output is included in the PDF, Excel and HTML exports. It never changes a run's pass/fail verdict; the deterministic checks stay the source of truth.

**Data privacy:** the hosted NVIDIA endpoint receives run digests, extracted values and (for screenshot explanations) cropped screenshots. For confidential reports, either set `AI_ALLOW_IMAGES=false`, disable AI per suite, or set `AI_BASE_URL` to a **self-hosted NVIDIA NIM** (any OpenAI-compatible server such as NIM, vLLM or Ollama works) so nothing leaves your network.

## Quick start

```bash
npm install
npx playwright install chromium
npm start                         # http://127.0.0.1:4400
```

1. **Power BI sign-ins** → *New sign-in* → *Sign in*. A real browser window opens; complete SSO/MFA there and the session is captured. Tick "Stay signed in". Public *publish-to-web* links need no profile. Use separate profiles if A and B live in different tenants.
2. **Report links** → add each report URL and pick its profile. Click **Discover** to confirm the link opens and see every page with its visual counts.
3. **Test suites** → *New suite* → choose A and B, the scenarios, limits and tolerances.
4. **Run now** → watch it live, then review results (filter by status, scenario or page; press ← → to step through differences). **Download PDF** for a shareable report (summary, AI analysis, every issue with screenshots, appendix of all checks), or use **Export** for an **Excel workbook (.xlsx)**, a **standalone HTML report (.zip)**, **JSON** or **JUnit XML**. The Runs page exports the run list to Excel and has a PDF button per run.

Supported URL types: service reports (`app.powerbi.com/groups/…/reports/…`), app reports, `reportEmbed` links, publish-to-web (`view?r=…`), and pages that host a report in an iframe (the report frame is detected).

## CI/CD

```bash
npm run cli -- list
npm run cli -- run "Sales Overview · PROD vs DEV" --junit results.xml --html report.zip --fail-on diffs
npm run cli -- check "Contoso · QA account"     # exit 1 if the session expired
```
Exit codes: `0` passed · `1` differences/failures (`--fail-on diffs|failed|never`) · `2` run error.
Suites can also run on a **cron schedule** (set it in the suite editor).

## Tuning for noisy reports
* **Ignore text patterns** (regex) for "Last refreshed …" stamps, and **ignore visuals by title**, e.g. `/refresh/i`.
* **Mask in screenshots** (CSS selectors) for animated or custom visuals.
* **Max differing pixels %**, **per-pixel colour tolerance**, **layout-jitter tolerance**, which ignores the 1px anti-aliasing and sub-pixel text shifts Power BI produces between loads, and **numeric tolerance** for rounding.
* **Pages include/exclude** (name or `/regex/`), e.g. exclude tooltip or drill-through pages.
* **Selector overrides (JSON)**: if Microsoft changes the report DOM, patch the selectors per suite without a code change (`src/engine/selectors.js` lists every key).

## Hosting on Cloudflare (free plan)

The validator needs a real browser, disk storage and a sign-in window, so it runs on a machine you control. **Cloudflare Tunnel** publishes it over HTTPS with no open inbound ports, and **Cloudflare Access** (free up to 50 users) adds company SSO in front.

| Option | Command | Result |
|---|---|---|
| Instant link (testing) | `./scripts/cloudflare/quick-tunnel.sh` | `https://<random>.trycloudflare.com`; changes on every start; requires `API_TOKEN` |
| Permanent, on your domain | `./scripts/cloudflare/setup-named-tunnel.sh pbi.example.com` then `cloudflared tunnel run pbi-validator` | `https://pbi.example.com`; needs the domain's DNS on Cloudflare |
| Keep it running on this Mac | `./scripts/macos/install-service.sh` + `sudo cloudflared service install` | starts at login, restarts on crash |
| Cloud VM | `docker compose up -d` (see `docker-compose.yml`) | app + cloudflared containers; sign in on a workstation and **Import** the session |

Create the administrator account (locally) and set `API_TOKEN` before exposing the app: it holds Power BI sessions. If people use a permanent address, set it as **Public URL** (Admin → Settings). Cloudflare Access can be added in front as a second layer.

## Production deployment
* **Configuration**: `.env` (see `.env.example`). Binds to `127.0.0.1` by default. Everyone signs in with their own account (see *Accounts*); CI uses a personal API key or `API_TOKEN` as `Authorization: Bearer <token>`.
* **Docker**: `docker build -t pbi-validator . && docker run -p 4400:4400 -v pbi-data:/data -e API_TOKEN=… pbi-validator`. Containers have no display, so sign in on a workstation (`npm run login -- "<profile>"`) and use **Import** on the Power BI sign-ins page.
* **Data**: SQLite (WAL) plus PNG artifacts in `DATA_DIR`. Runs older than `RUN_RETENTION_DAYS` are purged nightly. Session files are written with `0600` permissions and refreshed after each successful run. Treat `DATA_DIR/auth` as a secret.
* **Robustness**: runs are snapshotted (later edits don't change history), queued (`MAX_PARALLEL_RUNS`), cancellable, and marked as interrupted if the server restarts. Sessions that hit the Microsoft login page fail fast with a clear "sign in again" message, and the profile is flagged.
* **Security**: CSP, `X-Frame-Options`, `nosniff`, `no-referrer`; inputs validated with zod; report URLs with `?r=` tokens are redacted in logs.

## Development
```bash
npm test          # unit, API, engine and whole-website browser tests (setup → users → run → PDF/Excel) against a local Power BI DOM replica
npm run dev       # auto-restart on changes
```
`test/fixtures/mock-report.html` reproduces the Power BI renderer's DOM contract. Its variant `?v=b` contains planted regressions; the e2e suite asserts every scenario catches them and that an A-vs-A run has zero false positives.

```
src/engine/   pbi.js (report driver) · runner.js (scenarios) · compare.js (pixel + data diff)
              matcher.js (page/visual matching) · inpage.js (in-browser extraction) · selectors.js
src/jobs/     queue.js · scheduler.js · discovery.js · export.js (HTML/JUnit/JSON) · report.js (PDF + Excel) · xlsx.js
src/auth/     profiles.js (Power BI sessions) · users.js · passwords.js · middleware.js (roles, CSRF, audit)
src/api/      routes.js (REST + SSE) · auth.js · admin.js      public/   Preact + htm UI (no build step)
```

## Known limits
* Data checks read what Power BI renders: visible table/matrix rows (virtualised rows beyond the viewport aren't scrolled), chart data-point labels, and card text. They don't read the dataset itself.
* Range/date slicers are captured in page and visual checks, but values aren't typed into them.
* Custom visuals that draw on `<canvas>` are compared by pixels only.
