#!/usr/bin/env bash
# Container entrypoint for PBI Report Test on Cloudflare Containers.
#
# Cloudflare gives the container a fresh, empty disk on every start, so:
#   1. restore the database and the small directories (Power BI sessions, models,
#      anything else except runs/ and discovery/) from the R2 bucket, then start the app
#   2. restore the bulky run screenshots (runs/) and discovery thumbnails (discovery/)
#      in the background, retrying until they succeed
#   3. every SYNC_INTERVAL_SECONDS, save changes back to R2
#   4. on SIGTERM (sleep, deploy, host maintenance): stop the app, final save, exit
#
# Safety:
#  - If R2 can't be read, the container refuses to start rather than coming up
#    empty and then overwriting the stored data with nothing.
#  - Saving a tree uses `rclone sync` (deletions propagate) ONLY if that tree's
#    restore finished successfully (marker file in $STATE). Until then, runs/ and
#    discovery/ are saved with `rclone copy`, which can add files but never delete.
#  - The database is only uploaded when it changed; the daily history copy only
#    when today's copy doesn't exist yet.
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
STATE=/tmp/pbi-restore          # restore/save markers (outside $DATA so they are never synced)
rm -rf "$STATE"; mkdir -p "$STATE" "$DATA"
BULKY=(runs discovery)          # restored in the background; the app creates these dirs empty at boot
RESTORE_RC=(--transfers 32 --checkers 32 --fast-list)
SAVE_RC=(--transfers 16 --checkers 16)
BULKY_EXCLUDES=(); for d in "${BULKY[@]}"; do BULKY_EXCLUDES+=(--exclude "/$d/**"); done

if ! "${RC[@]}" lsf "$REMOTE/" >/dev/null; then
  log "FATAL: cannot read R2 bucket '$R2_BUCKET'. Check R2_* secrets. Not starting (protects stored data)."
  exit 1
fi
TOP="$("${RC[@]}" lsf --max-depth 1 "$REMOTE/")" || { log "FATAL: cannot list R2"; exit 1; }
HAVE_FILES=0
if grep -qx 'files/' <<<"$TOP"; then
  HAVE_FILES=1
  FILES_TOP="$("${RC[@]}" lsf --max-depth 1 "$REMOTE/files/")" || { log "FATAL: cannot list stored files"; exit 1; }
  # Phase 1 (blocking): auth sessions, models and everything except the bulky trees.
  "${RC[@]}" copy "${RESTORE_RC[@]}" "$REMOTE/files" "$DATA" "${BULKY_EXCLUDES[@]}" || { log "FATAL: file restore failed"; exit 1; }
fi
if grep -qx 'db/' <<<"$TOP" && [ -n "$("${RC[@]}" lsf "$REMOTE/db/pbi-validator.db" 2>/dev/null)" ]; then
  "${RC[@]}" copyto "$REMOTE/db/pbi-validator.db" "$DB" || { log "FATAL: database restore failed"; exit 1; }
  log "Restored database and core files from R2 ($(du -sh "$DATA" | cut -f1))"
else
  log "No database in R2 yet: starting fresh (first run)"
fi
touch "$STATE/core.restored" "$DATA/.restored"

# Phase 2 (background): one marker per tree, written only after a fully successful copy.
restore_bulky() {
  local d
  for d in "${BULKY[@]}"; do
    if [ "$HAVE_FILES" = 0 ] || ! grep -qx "$d/" <<<"$FILES_TOP"; then touch "$STATE/$d.restored"; continue; fi
    until "${RC[@]}" copy "${RESTORE_RC[@]}" --update "$REMOTE/files/$d" "$DATA/$d"; do
      log "WARNING: background restore of $d/ failed; retrying in 30 s (it will not be synced meanwhile)"
      sleep 30
    done
    touch "$STATE/$d.restored"
    log "Background restore of $d/ complete"
  done
}
restore_bulky &
RESTORE_PID=$!

# --------------------------------------------------------------------- save
FILTER_COMMON=(--exclude 'pbi-validator.db*' --exclude '.print-*' --exclude '.restored')

# Is anything under $1 (excluding the bulky trees when $1 is $DATA) newer than marker $2?
changed_since() {
  local dir="$1" marker="$2"
  [ -f "$marker" ] || return 0
  if [ "$dir" = "$DATA" ]; then
    [ -n "$(find "$DATA" \( -path "$DATA/runs" -o -path "$DATA/discovery" \) -prune -o -newer "$marker" ! -name 'pbi-validator.db*' ! -name '.print-*' ! -name '.restored' -print -quit 2>/dev/null)" ]
  else
    [ -n "$(find "$dir" -newer "$marker" -print -quit 2>/dev/null)" ]
  fi
}
db_changed() { [ ! -f "$STATE/db.uploaded" ] || [ -n "$(find "$DB" "$DB-wal" -newer "$STATE/db.uploaded" -print -quit 2>/dev/null)" ]; }
anything_due() {
  db_changed && return 0
  changed_since "$DATA" "$STATE/core.saved" && return 0
  local d; for d in "${BULKY[@]}"; do changed_since "$DATA/$d" "$STATE/$d.saved" && return 0; done
  return 1
}

DAILY_DONE=""
save_db() {
  [ -f "$DB" ] || return 0
  db_changed || return 0
  touch "$STATE/db.start"
  rm -f /tmp/snapshot.db
  # Consistent online copy of the database (safe while the app writes to it).
  if sqlite3 "$DB" ".backup '/tmp/snapshot.db'" && "${RC[@]}" copyto "${SAVE_RC[@]}" /tmp/snapshot.db "$REMOTE/db/pbi-validator.db"; then
    mv "$STATE/db.start" "$STATE/db.uploaded"
    # One history copy per day, only if today's doesn't exist yet.
    local today; today="$(date -u +%F)"
    if [ "$DAILY_DONE" != "$today" ]; then
      local daily="$REMOTE/db/daily/pbi-validator-$today.db" out rc
      out="$("${RC[@]}" lsf "$daily" 2>/dev/null)"; rc=$?
      if [ $rc = 0 ] && [ -n "$out" ]; then DAILY_DONE="$today"                    # already stored today
      elif [ $rc = 0 ] || [ $rc = 3 ]; then                                          # 3 = not found
        "${RC[@]}" copyto /tmp/snapshot.db "$daily" && DAILY_DONE="$today"
      fi                                                                             # other errors: look again next cycle
    fi
  else
    log "WARNING: database upload failed (will retry)"; return 1
  fi
}

# Save the small trees. Deletions propagate (the restore of these finished before the app started).
save_core() {
  local force="$1"
  [ "$force" = 1 ] || changed_since "$DATA" "$STATE/core.saved" || return 0
  touch "$STATE/core.start"
  "${RC[@]}" sync "${SAVE_RC[@]}" "$DATA" "$REMOTE/files" "${FILTER_COMMON[@]}" "${BULKY_EXCLUDES[@]}" || return 1
  mv "$STATE/core.start" "$STATE/core.saved"
}

# Save a bulky tree: sync (with deletions) only once its restore completed, otherwise copy (never deletes).
save_bulky() {
  local d="$1" force="$2"
  [ -d "$DATA/$d" ] || return 0
  [ "$force" = 1 ] || changed_since "$DATA/$d" "$STATE/$d.saved" || return 0
  touch "$STATE/$d.start"
  if [ -f "$STATE/$d.restored" ]; then
    "${RC[@]}" sync "${SAVE_RC[@]}" "$DATA/$d" "$REMOTE/files/$d" --exclude '.print-*' || return 1
  else
    log "Restore of $d/ not finished: uploading new files only, no deletions"
    "${RC[@]}" copy "${SAVE_RC[@]}" "$DATA/$d" "$REMOTE/files/$d" --exclude '.print-*' || return 1
    return 0   # not marked as saved: it will be tried again
  fi
  mv "$STATE/$d.start" "$STATE/$d.saved"
}

save() {
  local force="${1:-0}" rc=0 d
  [ -f "$DATA/.restored" ] || return 0
  save_db || rc=1
  save_core "$force" || { log "WARNING: file upload failed (will retry)"; rc=1; }
  for d in "${BULKY[@]}"; do save_bulky "$d" "$force" || { log "WARNING: $d/ upload failed (will retry)"; rc=1; }; done
  return $rc
}

# ---------------------------------------------------------------------- run
cd /app
node --disable-warning=ExperimentalWarning src/server.js &
APP=$!

shutdown() {
  log "Stopping: saving data to R2"
  kill -TERM "$APP" 2>/dev/null; wait "$APP" 2>/dev/null
  kill "$RESTORE_PID" 2>/dev/null; wait "$RESTORE_PID" 2>/dev/null   # unfinished trees stay unmarked: no deleting sync
  if save 1; then log "Final save complete"; exit 0; fi
  log "ERROR: FINAL SAVE FAILED: changes since the last successful save may be lost"
  exit 1
}
trap shutdown TERM INT

while kill -0 "$APP" 2>/dev/null; do
  sleep "$INTERVAL" & wait $!
  if anything_due; then save && log "Saved changes to R2"; fi
done

# The app exited on its own (crash): save what we have, exit with its code.
wait "$APP"; code=$?
log "App exited with code $code: saving data"
kill "$RESTORE_PID" 2>/dev/null; wait "$RESTORE_PID" 2>/dev/null
save 1 || log "ERROR: final save failed"
exit "$code"
