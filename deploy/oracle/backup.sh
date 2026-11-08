#!/usr/bin/env bash
# Consistent online backup of the PBI Report Test database (safe while the app
# runs). Keeps 14 days. Screenshots are not included: they are recreated by
# re-running a suite, and runs older than RUN_RETENTION_DAYS are pruned anyway.
set -euo pipefail
DEPLOY="$(cd "$(dirname "$0")" && pwd)"
DB="$DEPLOY/data/pbi-validator.db"
OUT="$DEPLOY/backups"
mkdir -p "$OUT"
[ -f "$DB" ] || { echo "No database yet at $DB"; exit 0; }
f="$OUT/pbireporttest-$(date +%Y-%m-%d-%H%M).db"
sqlite3 "$DB" ".backup '$f'"
gzip -f "$f"
chmod 600 "$f.gz"
find "$OUT" -name 'pbireporttest-*.db.gz' -mtime +14 -delete
echo "$(date "+%Y-%m-%dT%H:%M:%S") backup written: $f.gz"
