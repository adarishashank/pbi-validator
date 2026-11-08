#!/usr/bin/env bash
# Optional: move your existing accounts, report links, suites, runs,
# screenshots and Power BI sign-ins from this computer to the cloud server.
# Run on your Mac (not on the server), after install.sh has run on the server:
#
#   ./deploy/oracle/copy-data-to-server.sh ubuntu@<server-ip> [~/pbi-validator]
#
# It replaces the server's data (a backup of the server database is taken first).
set -euo pipefail
TARGET="${1:?Usage: $0 ubuntu@<server-ip> [remote repo folder, default ~/pbi-validator]}"
REMOTE_REPO="${2:-pbi-validator}"
cd "$(dirname "$0")/../.."
[ -f data/pbi-validator.db ] || { echo "No local data/pbi-validator.db to copy"; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is needed (it ships with macOS)"; exit 1; }

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
echo "▶ Taking a consistent snapshot of the local database"
sqlite3 data/pbi-validator.db ".backup '$STAGE/pbi-validator.db'"
mkdir -p "$STAGE/runs" "$STAGE/auth" "$STAGE/discovery"
rsync -a data/runs/ "$STAGE/runs/"; rsync -a data/auth/ "$STAGE/auth/"; rsync -a data/discovery/ "$STAGE/discovery/" 2>/dev/null || true

echo "▶ Uploading to $TARGET"
ssh "$TARGET" "mkdir -p ~/pbireporttest-import && rm -rf ~/pbireporttest-import/*"
rsync -az "$STAGE/" "$TARGET:pbireporttest-import/"

echo "▶ Swapping the data in on the server"
ssh -t "$TARGET" "set -e; D=\$(cd $REMOTE_REPO/deploy/oracle && pwd); cd \"\$D\"
  sudo ./backup.sh
  sudo docker compose stop app
  sudo rm -rf data.previous && sudo mv data data.previous
  sudo mv ~/pbireporttest-import data && U=\$(sudo docker run --rm --entrypoint id pbireporttest:latest -u pwuser) && sudo chown -R \$U:\$U data
  sudo docker compose start app
  echo '✔ Data copied. Previous server data kept in' \"\$D/data.previous\""
echo "Done. Sign in on the server with the same accounts you use here."
