# Host PBI Report Test on Cloudflare (workers.dev)

Result: **https://pbireporttest.&lt;your-subdomain&gt;.workers.dev**, running entirely
on Cloudflare: a Worker in front, the app (Node + headless Chromium) in a
Cloudflare Container, and its data in R2.

```
browser ──HTTPS──▶ Worker (src/worker.js) ──▶ Container: PBI Report Test + Chromium
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
It creates the bucket, stores the secrets in Cloudflare, builds the image,
deploys, wakes the app and prints the address. Run it again to deploy updates.

To avoid typing the keys, create `deploy/cloudflare/.r2-credentials` (git-ignored):
```
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

## Automatic deploys from GitHub
`.github/workflows/deploy-cloudflare.yml` deploys every push to `main` once the
tests pass (and on demand: *Actions → Deploy to Cloudflare → Run workflow*).
Add these repository secrets (*Settings → Secrets and variables → Actions*):

| Secret | Where it comes from |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → *My Profile → API Tokens → Create Token* → template **Edit Cloudflare Workers** (account-scoped) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → *Workers & Pages* → Account details |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the R2 API token from step 3 above |
| `APP_API_TOKEN` | any long random string (admin Bearer token and first-run setup token) |
| `NVIDIA_API_KEY` | optional, enables AI analysis |

Until they're all set the workflow skips with a notice. To start with your
existing accounts and runs, copy them once: `./deploy/cloudflare/deploy.sh --seed-only`.

## First sign-in
- With `--seed`: sign in with your existing account.
- Without: open the address and create the administrator. You'll be asked for
  the **setup token**, saved by the script in `deploy/cloudflare/.api-token`.

## Good to know
- **Waking up:** after sleeping, the first visit shows "PBI Report Test is waking up"
  for up to a minute while data is restored from R2.
- **Scheduled suites** only run while the app is awake. Start runs on demand, or
  from CI with an API key.
- **Power BI sign-in:** the container has no screen. Sign in on your Mac, then
  **Import** the session on the *Power BI sign-ins* page (or deploy with `--seed`).
- **Data safety:** the database is saved to R2 every 30 seconds when it changes,
  on every shutdown, plus one copy per day under `db/daily/` in the bucket. If R2
  can't be read at start, the container refuses to start instead of coming up empty.
- **Logs:** `cd deploy/cloudflare && npx wrangler tail`; container status in the
  dashboard under *Workers & Pages → Containers*.
- **Bigger machine:** change `instance_type` in `wrangler.jsonc` to `standard-2`
  (1 vCPU, 6 GiB) for faster runs, then redeploy.
