#!/usr/bin/env bash
# One-command install of PBI Report Test on a fresh Ubuntu 22.04/24.04 server
# (Oracle Cloud Always Free Ampere A1, or any x86/ARM Ubuntu VM).
#
#   git clone https://github.com/adarishashank/pbi-validator.git
#   cd pbi-validator && sudo ./deploy/oracle/install.sh
#
# Asks for (or reads from the environment):
#   DUCKDNS_SUBDOMAIN  name on duckdns.org, default "pbireporttest"
#   DUCKDNS_TOKEN      your token from duckdns.org (leave empty if you use your own domain)
#   SITE_ADDRESS       only for your own domain instead of DuckDNS, e.g. pbireporttest.com
#   ADMIN_EMAIL        the first administrator (gets a temporary password)
#   NVIDIA_API_KEY     optional, enables AI analysis
#
# Safe to run again: it keeps the existing .env, data and certificates.
set -euo pipefail

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DEPLOY/../.." && pwd)"
cd "$DEPLOY"

say()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run with sudo:  sudo $0"
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = ubuntu ] || warn "Tested on Ubuntu; this is ${PRETTY_NAME:-unknown}. Continuing."

ask() { # ask VAR "Prompt" [default] [secret]
  local var=$1 prompt=$2 def=${3:-} secret=${4:-} v
  [ -n "${!var:-}" ] && return
  if [ -n "$secret" ]; then read -rsp "  $prompt: " v; echo; else read -rp "  $prompt${def:+ [$def]}: " v; fi
  printf -v "$var" '%s' "${v:-$def}"
}

# ------------------------------------------------------------------ inputs
say "Settings"
if [ -f .env ]; then
  ok "Existing settings found in $DEPLOY/.env: keeping them"
  set -a; . ./.env; set +a
else
  if [ -z "${SITE_ADDRESS:-}" ]; then
    ask DUCKDNS_SUBDOMAIN "DuckDNS name (the part before .duckdns.org)" "pbireporttest"
    [[ "$DUCKDNS_SUBDOMAIN" =~ ^[a-z0-9-]+$ ]] || die "DuckDNS names use only lowercase letters, digits and dashes"
    ask DUCKDNS_TOKEN "DuckDNS token (from duckdns.org after signing in; input hidden)" "" secret
    [[ "$DUCKDNS_TOKEN" =~ ^[a-f0-9-]{36}$ ]] || die "That doesn't look like a DuckDNS token (36 characters like 1a2b3c4d-....)"
    SITE_ADDRESS="$DUCKDNS_SUBDOMAIN.duckdns.org"
  fi
  [[ "$SITE_ADDRESS" =~ ^[A-Za-z0-9.-]+$ ]] || die "Invalid SITE_ADDRESS: $SITE_ADDRESS"
  ask NVIDIA_API_KEY "NVIDIA API key for AI analysis (optional, Enter to skip; input hidden)" "" secret
  umask 077
  cat > .env <<ENV
# PBI Report Test — server settings (created by install.sh on $(date -u +%F)).
SITE_ADDRESS=$SITE_ADDRESS
PUBLIC_URL=https://$SITE_ADDRESS
DUCKDNS_SUBDOMAIN=${DUCKDNS_SUBDOMAIN:-}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN:-}
# Admin Bearer token for scripts/CI, and the setup token for remote first-run.
API_TOKEN=$(openssl rand -hex 24)
NVIDIA_API_KEY=${NVIDIA_API_KEY:-}
TEMP_PASSWORD_HOURS=72
RUN_RETENTION_DAYS=30
MAX_PARALLEL_RUNS=1
LOG_LEVEL=info
ENV
  umask 022
  ok "Settings saved to $DEPLOY/.env (readable by root only)"
fi
ask ADMIN_EMAIL "Administrator email" ""

# ---------------------------------------------------------------- packages
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git sqlite3 cron openssl iptables netfilter-persistent iptables-persistent >/dev/null
ok "curl, git, sqlite3, cron, firewall tools"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
  ok "Docker installed"
else
  ok "Docker already installed ($(docker --version | cut -d, -f1))"
fi
systemctl enable --now docker cron >/dev/null 2>&1 || true
[ -n "${SUDO_USER:-}" ] && usermod -aG docker "$SUDO_USER" || true

# Swap gives Chromium headroom on small machines.
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "4 GB swap file added"
fi

# ---------------------------------------------------------------- firewall
# Oracle's Ubuntu images block everything except SSH in iptables (in addition
# to the cloud Security List, which you open in the Oracle console).
say "Opening ports 80 and 443"
for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
  # shellcheck disable=SC2086
  iptables -C INPUT $rule -j ACCEPT 2>/dev/null || iptables -I INPUT 1 $rule -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true
ok "Server firewall allows HTTP/HTTPS (also open them in the Oracle Security List; see README)"

# ------------------------------------------------------------------ DuckDNS
PUBLIC_IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || curl -fsS4 --max-time 10 https://ifconfig.me || true)"
[ -n "$PUBLIC_IP" ] || die "Could not determine this server's public IP address"
if [ -n "${DUCKDNS_TOKEN:-}" ]; then
  say "Pointing $SITE_ADDRESS at $PUBLIC_IP"
  r="$(curl -fsS --max-time 15 "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=${PUBLIC_IP}" || true)"
  [ "$r" = OK ] || die "DuckDNS refused the update (got '$r'). Check the name is registered to your account and the token is right."
  umask 077
  cat > /etc/cron.d/pbireporttest-duckdns <<CRON
# Keep $SITE_ADDRESS pointing at this server.
*/5 * * * * root curl -fsS --max-time 15 -o /dev/null "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip="
CRON
  umask 022
  ok "DuckDNS updated; refreshed every 5 minutes"
fi

say "Waiting for $SITE_ADDRESS to resolve to $PUBLIC_IP"
for i in $(seq 1 60); do
  resolved="$(getent ahostsv4 "$SITE_ADDRESS" | awk 'NR==1{print $1}')"
  [ "$resolved" = "$PUBLIC_IP" ] && break
  sleep 5
done
[ "${resolved:-}" = "$PUBLIC_IP" ] && ok "DNS is correct" || warn "DNS shows '${resolved:-nothing}', not $PUBLIC_IP. HTTPS will start working once it updates."

# --------------------------------------------------------------------- app
say "Building and starting PBI Report Test (first build takes a few minutes)"
mkdir -p data backups
docker compose build --quiet 2>&1 | tail -3
# The container runs as the image's unprivileged "pwuser"; give it the data folder.
APP_UID="$(docker run --rm --entrypoint id pbireporttest:latest -u pwuser)"
chown -R "$APP_UID:$APP_UID" data
docker compose up -d 2>&1 | tail -3
for i in $(seq 1 60); do
  st="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || true)"
  [ "$st" = healthy ] && break
  sleep 5
done
[ "${st:-}" = healthy ] || die "The app did not become healthy. Logs:  sudo docker compose -f $DEPLOY/docker-compose.yml logs app"
ok "App is running"

TEMP_OUT=""
if [ -n "$ADMIN_EMAIL" ]; then
  if docker compose exec -T app node --disable-warning=ExperimentalWarning src/cli.js users | grep -qiF " $ADMIN_EMAIL"; then
    ok "$ADMIN_EMAIL already has an account"
  else
    TEMP_OUT="$(docker compose exec -T app node --disable-warning=ExperimentalWarning src/cli.js create-admin "$ADMIN_EMAIL")"
    ok "Administrator $ADMIN_EMAIL created"
  fi
fi

# ----------------------------------------------------------------- backups
say "Nightly backups"
chmod +x "$DEPLOY/backup.sh" "$DEPLOY/update.sh"
cat > /etc/cron.d/pbireporttest-backup <<CRON
# Nightly database backup for PBI Report Test (14 days kept in $DEPLOY/backups).
30 2 * * * root $DEPLOY/backup.sh >> /var/log/pbireporttest-backup.log 2>&1
CRON
ok "Database backed up nightly at 02:30 to $DEPLOY/backups"

# -------------------------------------------------------------------- HTTPS
say "Checking https://$SITE_ADDRESS"
for i in $(seq 1 24); do
  curl -fsS --max-time 10 "https://$SITE_ADDRESS/api/health" >/dev/null 2>&1 && { https_ok=1; break; }
  sleep 5
done
if [ -n "${https_ok:-}" ]; then ok "HTTPS certificate issued and the site is reachable"
else warn "Not reachable over HTTPS yet. Usually the Oracle Security List is missing ports 80/443 (see README). Caddy keeps retrying."; fi

cat <<DONE

────────────────────────────────────────────────────────────────────
  PBI Report Test is installed.

  Open:       https://$SITE_ADDRESS
$( [ -n "$TEMP_OUT" ] && printf '\n  First sign-in (you will choose your own password):\n%s\n' "$(echo "$TEMP_OUT" | grep -E 'Email:|Temporary password:|Expires:')" )
  Update later:   sudo $DEPLOY/update.sh
  Logs:           sudo docker compose -f $DEPLOY/docker-compose.yml logs -f app
  Settings:       $DEPLOY/.env  (then: sudo docker compose -f $DEPLOY/docker-compose.yml up -d)
────────────────────────────────────────────────────────────────────
DONE
