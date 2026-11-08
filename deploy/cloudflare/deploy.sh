#!/usr/bin/env bash
# Deploy PBI Report Test to Cloudflare: https://pbireporttest.<your-subdomain>.workers.dev
# (Worker + Container + R2). Run from your Mac with Docker Desktop running:
#
#   ./deploy/cloudflare/deploy.sh            first deploy (asks for R2 keys) and later updates
#   ./deploy/cloudflare/deploy.sh --seed     also copy this Mac's data/ (accounts, reports, runs) to Cloudflare
#   ./deploy/cloudflare/deploy.sh --seed-only  only copy the data to R2 (when GitHub Actions does the deploys)
#
# R2 keys can also come from the environment (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)
# or from deploy/cloudflare/.r2-credentials (two lines: KEY=VALUE, never committed).
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"; ROOT="$(cd ../.. && pwd)"
BUCKET="pbireporttest-data"
SEED=""; SEED_ONLY=""
case "${1:-}" in --seed) SEED=1 ;; --seed-only) SEED=1; SEED_ONLY=1 ;; esac

say()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
W() { npx --no-install wrangler "$@"; }

# ------------------------------------------------------------ prerequisites
say "Checking prerequisites"
docker info >/dev/null 2>&1 || die "Docker isn't running. Start Docker Desktop (it builds the app image), then run this again."
[ -d node_modules ] || npm install --no-audit --no-fund --silent
ok "Docker and Wrangler ready"
if ! W whoami --json > /tmp/pbirt-whoami.json 2>/dev/null; then
  say "Sign in to Cloudflare (a browser window opens)"
  W login
  W whoami --json > /tmp/pbirt-whoami.json
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$(node -e "const j=require('/tmp/pbirt-whoami.json');const a=j.accounts||[];if(a.length!==1){console.error('Several Cloudflare accounts: set CLOUDFLARE_ACCOUNT_ID to one of: '+a.map(x=>x.id+' ('+x.name+')').join(', '));process.exit(1)}console.log(a[0].id)")"
fi
export CLOUDFLARE_ACCOUNT_ID
ok "Cloudflare account $(node -e "console.log(require('/tmp/pbirt-whoami.json').email)") ($CLOUDFLARE_ACCOUNT_ID)"

# ----------------------------------------------------------------------- R2
say "Storage (R2 bucket $BUCKET)"
if ! list="$(W r2 bucket list 2>&1)"; then
  grep -q 10042 <<<"$list" && die "R2 is not enabled yet. Cloudflare dashboard → R2 Object Storage → enable it (free up to 10 GB), then run this again."
  die "Could not list R2 buckets: $list"
fi
if grep -qw -- "$BUCKET" <<<"$list"; then ok "Bucket exists"; else W r2 bucket create "$BUCKET" >/dev/null && ok "Bucket created"; fi

# ------------------------------------------------------------------ secrets
existing="$(W secret list --format json 2>/dev/null || echo '[]')"
has() { node -e "process.exit(JSON.parse(process.argv[1]).some(s=>s.name===process.argv[2])?0:1)" "$existing" "$1" 2>/dev/null; }
[ -f .r2-credentials ] && { set -a; . ./.r2-credentials; set +a; }

SECRETS="$(mktemp)"; chmod 600 "$SECRETS"; trap 'rm -f "$SECRETS"' EXIT
add_secret() { node -e "const fs=require('fs');const f=process.argv[1];const o=fs.existsSync(f)&&fs.statSync(f).size?JSON.parse(fs.readFileSync(f,'utf8')):{};o[process.argv[2]]=process.argv[3];fs.writeFileSync(f,JSON.stringify(o))" "$SECRETS" "$1" "$2"; }

if ! has R2_SECRET_ACCESS_KEY || [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
  if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ]; then
    say "R2 access keys (the app uses them to save its data)"
    echo "  Create them once: Cloudflare dashboard → R2 Object Storage → Manage API tokens →"
    echo "  Create Account API token → Permissions: Object Read & Write → Specify bucket: $BUCKET → Create."
    read -rp "  Access Key ID: " R2_ACCESS_KEY_ID
    read -rsp "  Secret Access Key (hidden): " R2_SECRET_ACCESS_KEY; echo
  fi
  [[ "$R2_ACCESS_KEY_ID" =~ ^[A-Za-z0-9]{20,64}$ ]] || die "That Access Key ID doesn't look right"
  [ ${#R2_SECRET_ACCESS_KEY} -ge 30 ] || die "That Secret Access Key looks too short"
  add_secret R2_ACCESS_KEY_ID "$R2_ACCESS_KEY_ID"
  add_secret R2_SECRET_ACCESS_KEY "$R2_SECRET_ACCESS_KEY"
  add_secret R2_ACCOUNT_ID "$CLOUDFLARE_ACCOUNT_ID"
fi
if ! has API_TOKEN; then
  API_TOKEN="$(cat "$HERE/.api-token" 2>/dev/null || openssl rand -hex 24)"
  add_secret API_TOKEN "$API_TOKEN"
  umask 077; echo "$API_TOKEN" > "$HERE/.api-token"; umask 022
fi
if ! has NVIDIA_API_KEY; then
  NV="$(grep -E '^NVIDIA_API_KEY=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "$NV" ]; then
    read -rp "  Use the NVIDIA API key from .env for AI analysis on Cloudflare? [Y/n] " yn
    [[ "${yn:-y}" =~ ^[Yy] ]] && add_secret NVIDIA_API_KEY "$NV" && ok "AI analysis enabled"
  fi
fi

# ---------------------------------------------------------------- seed data
if [ -n "$SEED" ]; then
  say "Copying this Mac's data to R2"
  [ -f "$ROOT/data/pbi-validator.db" ] || die "No $ROOT/data/pbi-validator.db to copy"
  : "${R2_ACCESS_KEY_ID:?the R2 keys are needed to seed; put them in deploy/cloudflare/.r2-credentials}"
  STAGE="$(mktemp -d)"
  sqlite3 "$ROOT/data/pbi-validator.db" ".backup '$STAGE/pbi-validator.db'"
  for d in runs auth discovery; do [ -d "$ROOT/data/$d" ] && cp -R "$ROOT/data/$d" "$STAGE/files-$d"; done
  RCENV=(-e RCLONE_CONFIG_R2_TYPE=s3 -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare -e RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
    -e "RCLONE_CONFIG_R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID" -e "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY"
    -e "RCLONE_CONFIG_R2_ENDPOINT=https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com")
  docker run --rm "${RCENV[@]}" -v "$STAGE:/seed:ro" rclone/rclone:latest copyto /seed/pbi-validator.db "r2:$BUCKET/db/pbi-validator.db"
  for d in runs auth discovery; do
    [ -d "$STAGE/files-$d" ] && docker run --rm "${RCENV[@]}" -v "$STAGE:/seed:ro" rclone/rclone:latest copy "/seed/files-$d" "r2:$BUCKET/files/$d"
  done
  rm -rf "$STAGE"
  ok "Accounts, report links, suites, runs and Power BI sign-ins uploaded"
  warn "If the app is already running on Cloudflare it keeps its own copy until it next restarts."
fi
[ -n "$SEED_ONLY" ] && { ok "Done (data only). The app picks it up on its next start."; exit 0; }

# ------------------------------------------------------------------- deploy
say "Building and deploying (the first build takes several minutes)"
args=(deploy)
[ -s "$SECRETS" ] && args+=(--secrets-file "$SECRETS")
out="$(W "${args[@]}" 2>&1 | tee /dev/stderr)" || {
  grep -qiE "workers paid|subscription|not entitled|containers.*(plan|access)" <<<"$out" && die "Cloudflare Containers need the Workers Paid plan (\$5/month): dashboard → Workers & Pages → Plans → upgrade, then run this again."
  die "Deploy failed (see above)"
}
URL="$(grep -oE 'https://pbireporttest\.[a-z0-9-]+\.workers\.dev' <<<"$out" | head -1)"
[ -n "$URL" ] || die "Deployed, but couldn't find the workers.dev address in the output above"
ok "Deployed to $URL"

# ------------------------------------------------------------------- wake up
say "Starting the app (first start downloads the image to Cloudflare; can take a few minutes)"
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$URL/api/health" || true)"
  [ "$code" = 200 ] && break
  sleep 10
done
[ "$code" = 200 ] && ok "App is up" || warn "Not answering yet (HTTP $code). Check: npx wrangler tail   and the Containers page in the dashboard."

cfg="$(curl -s --max-time 30 "$URL/api/auth/config" || true)"
cat <<DONE

────────────────────────────────────────────────────────────────────
  PBI Report Test is on Cloudflare:  $URL
$(if grep -q '"setupRequired":true' <<<"$cfg"; then
  echo "  First visit: create the administrator account. You'll be asked for the"
  echo "  setup token, which is saved in deploy/cloudflare/.api-token:"
  echo "      $(cat "$HERE/.api-token" 2>/dev/null)"
else
  echo "  Sign in with your existing account."
fi)
  Update later:  ./deploy/cloudflare/deploy.sh
  Live logs:     cd deploy/cloudflare && npx wrangler tail
  It sleeps after 30 min without use and wakes on the next visit (about a minute).
────────────────────────────────────────────────────────────────────
DONE
