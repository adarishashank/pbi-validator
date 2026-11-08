#!/usr/bin/env bash
# Pull the latest code from GitHub and restart PBI Report Test with it.
#   sudo ./deploy/oracle/update.sh
set -euo pipefail
DEPLOY="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DEPLOY/../.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo $0"; exit 1; }
"$DEPLOY/backup.sh"
git config --global --add safe.directory "$REPO" 2>/dev/null || true
git -C "$REPO" pull --ff-only
cd "$DEPLOY"
docker compose build --quiet
APP_UID="$(docker run --rm --entrypoint id pbireporttest:latest -u pwuser)"
chown -R "$APP_UID:$APP_UID" data
docker compose up -d
docker image prune -f >/dev/null
for i in $(seq 1 60); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ] && { echo "✔ Updated to $(git -C "$REPO" log --oneline -1)"; exit 0; }
  sleep 5
done
echo "✖ The app did not become healthy after the update. Logs: sudo docker compose -f $DEPLOY/docker-compose.yml logs app"
exit 1
