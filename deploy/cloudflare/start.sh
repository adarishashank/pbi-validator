#!/usr/bin/env bash
# Container entrypoint for PBI Report Test on Cloudflare Containers.
#
# Cloudflare gives the container a fresh, empty disk on every start, so:
#   1. restore /data from the R2 bucket (database snapshot + screenshots + Power BI sessions)
#   2. start the app
#   3. every SYNC_INTERVAL_SECONDS, save changes back to R2
#   4. on SIGTERM (sleep, deploy, host maintenance): stop the app, final save, exit
#
# Safety: if R2 can't be read, the container refuses to start rather than
# coming up empty and then overwriting the stored data with nothing.
set -uo pipefail

DATA="${DATA_DIR:-/data}"
DB="$DATA/pbi-validator.db"
INTERVAL="${SYNC_INTERVAL_SECONDS:-30}"
log() { echo "$(date -u +%H:%M:%S) [r2-sync] $*"; }

: "${R2_BUCKET:?R2_BUCKET is not set}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is not set}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is not set}"
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is not set}.r2.cloudflarestorage.com}"
REMOTE="r2:$R2_BUCKET"
RC=(rclone --retries 3 --low-level-retries 5 --stats 0 --log-level ERROR)

# ------------------------------------------------------------------ restore
mkdir -p "$DATA"
if ! "${RC[@]}" lsf "$REMOTE/" >/dev/null; then
  log "FATAL: cannot read R2 bucket '$R2_BUCKET'. Check R2_* secrets. Not starting (protects stored data)."
  exit 1
fi
TOP="$("${RC[@]}" lsf --max-depth 1 "$REMOTE/")"
if grep -qx 'files/' <<<"$TOP"; then
  "${RC[@]}" copy "$REMOTE/files" "$DATA" || { log "FATAL: file restore failed"; exit 1; }
fi
if grep -qx 'db/' <<<"$TOP" && [ -n "$("${RC[@]}" lsf "$REMOTE/db/pbi-validator.db" 2>/dev/null)" ]; then
  "${RC[@]}" copyto "$REMOTE/db/pbi-validator.db" "$DB" || { log "FATAL: database restore failed"; exit 1; }
  log "Restored data from R2 ($(du -sh "$DATA" | cut -f1))"
else
  log "No database in R2 yet: starting fresh (first run)"
fi
touch "$DATA/.restored"

# --------------------------------------------------------------------- save
snapshot_due() { [ ! -f /tmp/.last-sync ] || [ -n "$(find "$DATA" -newer /tmp/.last-sync -type f ! -name '.print-*' -print -quit 2>/dev/null)" ]; }
save() {
  [ -f "$DATA/.restored" ] || return 0
  [ -f "$DB" ] || return 0
  touch /tmp/.sync-start
  # Consistent online copy of the database (safe while the app writes to it).
  if sqlite3 "$DB" ".backup '/tmp/snapshot.db'" && "${RC[@]}" copyto /tmp/snapshot.db "$REMOTE/db/pbi-validator.db"; then
    # One copy per day as history (cheap insurance against mistakes).
    "${RC[@]}" copyto /tmp/snapshot.db "$REMOTE/db/daily/pbi-validator-$(date -u +%F).db" || true
  else
    log "WARNING: database upload failed (will retry)"; return 1
  fi
  # Screenshots, Power BI sessions, discovery thumbnails; deletions propagate.
  "${RC[@]}" sync "$DATA" "$REMOTE/files" --exclude 'pbi-validator.db*' --exclude '.print-*' --exclude '.restored' \
    || { log "WARNING: file upload failed (will retry)"; return 1; }
  mv /tmp/.sync-start /tmp/.last-sync
}

# ---------------------------------------------------------------------- run
cd /app
node --disable-warning=ExperimentalWarning src/server.js &
APP=$!

shutdown() {
  log "Stopping: saving data to R2"
  kill -TERM "$APP" 2>/dev/null; wait "$APP" 2>/dev/null
  save && log "Final save complete" || log "WARNING: final save failed"
  exit 0
}
trap shutdown TERM INT

touch -d '1970-01-01' /tmp/.last-sync 2>/dev/null || true
while kill -0 "$APP" 2>/dev/null; do
  sleep "$INTERVAL" & wait $!
  if snapshot_due; then save && log "Saved changes to R2"; fi
done

# The app exited on its own (crash): save what we have, exit with its code.
wait "$APP"; code=$?
log "App exited with code $code: saving data"
save || true
exit "$code"
