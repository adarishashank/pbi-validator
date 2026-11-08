#!/usr/bin/env bash
# Instant public HTTPS URL (https://<random>.trycloudflare.com) for the running
# validator. Free, no Cloudflare account needed. The URL changes every time and
# lives only while this script runs — use setup-named-tunnel.sh for a permanent
# address. Refuses to start unless API_TOKEN protects the app.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
PORT="${PORT:-4400}"
CF="$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")"
[ -x "$CF" ] || { echo "cloudflared not found. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"; exit 1; }
if [ -z "${API_TOKEN:-}" ]; then
  echo "Refusing to expose the validator publicly without API_TOKEN."
  echo "Add API_TOKEN=<long random string> to .env, restart the app, then re-run."
  echo "Generate one with:  openssl rand -hex 24"
  exit 1
fi
curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || { echo "The validator is not running on port ${PORT} (npm start)."; exit 1; }
echo "Starting Cloudflare quick tunnel → http://127.0.0.1:${PORT}"
echo "Open the https://…trycloudflare.com URL printed below and sign in with your account."
exec "$CF" tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}"
