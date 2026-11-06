#!/usr/bin/env bash
# Permanent hosting on your own domain through Cloudflare (free plan):
#   ./scripts/cloudflare/setup-named-tunnel.sh pbi.example.com
# Requirements: a Cloudflare account with the domain's DNS on Cloudflare.
# Steps performed: login (opens browser) → create tunnel → DNS route →
# ~/.cloudflared/config.yml → optional background service.
set -euo pipefail
HOST="${1:-}"; NAME="${TUNNEL_NAME:-pbi-validator}"
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
PORT="${PORT:-4400}"
CF="$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")"
[ -n "$HOST" ] || { echo "Usage: $0 <hostname, e.g. pbi.example.com>"; exit 1; }
[ -x "$CF" ] || { echo "cloudflared not found"; exit 1; }

[ -f "$HOME/.cloudflared/cert.pem" ] || "$CF" tunnel login
if ! "$CF" tunnel info "$NAME" >/dev/null 2>&1; then "$CF" tunnel create "$NAME"; fi
ID="$("$CF" tunnel list -o json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).find(x=>x.name==='$NAME');console.log(t?t.id:'')})")"
[ -n "$ID" ] || { echo "Could not resolve tunnel id"; exit 1; }
"$CF" tunnel route dns --overwrite-dns "$NAME" "$HOST"

mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/config.yml" <<YML
tunnel: ${ID}
credentials-file: ${HOME}/.cloudflared/${ID}.json
ingress:
  - hostname: ${HOST}
    service: http://127.0.0.1:${PORT}
    originRequest:
      connectTimeout: 30s
      # Server-sent events (live run progress) need long-lived connections.
      keepAliveTimeout: 300s
  - service: http_status:404
YML
echo "✔ Tunnel '$NAME' ($ID) routes https://${HOST} → http://127.0.0.1:${PORT}"
echo
echo "Run it now:            $CF tunnel run $NAME"
echo "Or as a service:       sudo $CF service install   (macOS/Linux, starts on boot)"
echo
echo "Strongly recommended — put Cloudflare Access (free up to 50 users) in front:"
echo "  Cloudflare dashboard → Zero Trust → Access → Applications → Add → Self-hosted"
echo "  Domain: ${HOST}   Policy: Allow → emails ending in @yourcompany.com (or your IdP group)"
[ -z "${API_TOKEN:-}" ] && echo "⚠ API_TOKEN is not set in .env — set it as a second layer of protection."
exit 0
