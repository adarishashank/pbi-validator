# Host PBI Report Test on Cloudflare (workers.dev)

Result: **https://pbireporttest.&lt;your-subdomain&gt;.workers.dev**, running entirely
on Cloudflare: a Worker in front, the app (Node + headless Chromium) in a
Cloudflare Container, and its data in R2.

```
browser ──HTTPS──▶ Cloudflare edge: static web app (assets, never wakes the container)
        └─ /api/* and /artifacts/* ─▶ Worker (src/worker.js) ──▶ Container: PBI Report Test + Chromium
                                                   │  restore on start, save every 30 s / on shutdown
                                                   ▼
                                            R2 bucket pbireporttest-data
```

## What it costs
- **Workers Paid plan: $5/month** (Cloudflare Containers require it).
- **Container usage** on top, billed only while it's awake. It sleeps after
  30 minutes without visitors (never during a validation run). Light use
  (an hour or two a day) stays at roughly **$1–3/month extra**; kept awake 24/7
  it would be about $30/month.
- **R2 storage:** free up to 10 GB.

## One-time setup in the Cloudflare dashboard (5 minutes)
1. **Workers Paid:** *Workers & Pages → Plans* → upgrade to **Workers Paid**.
2. **R2:** *R2 Object Storage* → enable it (asks for a payment method; the free tier covers this app).
3. **R2 keys:** *R2 Object Storage → Manage API tokens → Create Account API token*
   → Permissions **Object Read & Write** → *Specify bucket* `pbireporttest-data`
   (create the bucket first with `npx wrangler r2 bucket create pbireporttest-data`, or pick "all buckets")
   → **Create** → copy the **Access Key ID** and **Secret Access Key**.
4. **workers.dev subdomain:** *Workers & Pages* shows your `*.workers.dev`
   subdomain; choose one if asked (e.g. `adarishashank` → `pbireporttest.adarishashank.workers.dev`).

## Deploy (one command, from your Mac with Docker Desktop running)
```bash
./deploy/cloudflare/deploy.sh          # asks for the R2 keys the first time
./deploy/cloudflare/deploy.sh --seed   # same, and copies this Mac's accounts, reports and runs
```
It creates the bucket, stores the secrets in Cloudflare, builds the web app files
(`npm run build:static` in the repository root, into `deploy/cloudflare/.static`,
git-ignored; this needs `npm ci` in the root, which the script runs if needed),
builds the image, deploys, wakes the app and prints the address. Run it again to
deploy updates. If you run `wrangler deploy` yourself, run `npm run build:static`
in the repository root first, or the deploy fails for lack of the assets folder.

To avoid typing the keys, create `deploy/cloudflare/.r2-credentials` (git-ignored):
```
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

## Automatic deploys from GitHub
`.github/workflows/deploy-cloudflare.yml` deploys every push to `main` once the
tests pass (and on demand: *Actions → Deploy to Cloudflare → Run workflow*).
Pushes that only change Markdown, `docs/` or `deploy/oracle/` since the last
successful run of that workflow are skipped; a manual run always deploys. (If the
workflow ran before the secrets existed it "succeeded" without deploying, so run it
manually once after adding them.)
Add these repository secrets (*Settings → Secrets and variables → Actions*):

| Secret | Where it comes from |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → *My Profile → API Tokens → Create Token* → template **Edit Cloudflare Workers** (account-scoped) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → *Workers & Pages* → Account details |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the R2 API token from step 3 above |
| `APP_API_TOKEN` | any long random string (admin Bearer token and first-run setup token) |
| `NVIDIA_API_KEY` | optional, enables AI analysis |
| `PBI_TENANT_ID`, `PBI_CLIENT_ID`, `PBI_CLIENT_SECRET` | optional: an Entra ID app (service principal) with *Build* access to the semantic models, for data model comparison through the Power BI API |

Until they're all set the workflow skips with a notice. To start with your
existing accounts and runs, copy them once: `./deploy/cloudflare/deploy.sh --seed-only`.

## First sign-in
- With `--seed`: sign in with your existing account.
- Without: open the address and create the administrator. You'll be asked for
  the **setup token**, saved by the script in `deploy/cloudflare/.api-token`.

## Good to know
- **Waking up:** the web app's files come from Cloudflare's edge, so the page itself
  loads instantly even while the container sleeps. API calls made while it sleeps get
  `503 {"waking": true}` with `Retry-After: 4` (and start the container); the app retries.
  Requests with an `Authorization: Bearer` header (API/CI clients) wait for the container instead.
  Restoring data from R2 can take a little while: the database and sign-ins come first,
  run screenshots and discovery thumbnails follow in the background (older screenshots
  may appear a few seconds late after a wake-up).
- **`/api/health`** answers `{"ok":true,"asleep":true,"busy":false}` from the Worker
  without waking the app, and does not extend its sleep timer when the app is running.
  To wake the app from a script, call any other endpoint, e.g. `/api/auth/config`
  (retry on 503 until 200).
- **Scheduled suites work while the app sleeps.** A Cloudflare cron trigger checks
  every minute (at no real cost) whether a suite is due and wakes the app only then;
  the app starts the due runs, catching up any it missed (up to 24 h late). Cron
  times use `TIMEZONE` in `wrangler.jsonc` (default `Asia/Kolkata`).
- **Power BI sign-in:** the container has no screen. Sign in on your Mac, then
  **Import** the session on the *Power BI sign-ins* page (or deploy with `--seed`).
- **Data safety:** the database is saved to R2 every 30 seconds when it changes,
  on every shutdown, plus one copy per day (the first save of the day) under `db/daily/` in the bucket. The database is
  uploaded only when it changed. If R2 can't be read at start, the container refuses to
  start instead of coming up empty. Deletions are only copied to R2 for a folder after its
  restore finished; until then new files are uploaded but nothing is deleted. If the
  final save on shutdown fails, the container logs an `ERROR` and exits non-zero.
- **Logs:** `cd deploy/cloudflare && npx wrangler tail`; container status in the
  dashboard under *Workers & Pages → Containers*.
- **Bigger machine:** change `instance_type` in `wrangler.jsonc` to `standard-2`
  (1 vCPU, 6 GiB) for faster runs, then redeploy.
