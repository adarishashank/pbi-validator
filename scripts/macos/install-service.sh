#!/usr/bin/env bash
# Keeps the validator running in the background on macOS (starts at login,
# restarts on crash). Logs: ~/Library/Logs/pbi-validator.log
#   ./scripts/macos/install-service.sh            install / update
#   ./scripts/macos/install-service.sh uninstall  remove
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.pbi-validator.server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"; echo "Removed ${LABEL}"; exit 0
fi
NODE="$(command -v node)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${NODE}</string><string>--disable-warning=ExperimentalWarning</string><string>${DIR}/src/server.js</string></array>
  <key>WorkingDirectory</key><string>${DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/pbi-validator.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/pbi-validator.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin</string></dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✔ ${LABEL} installed — http://127.0.0.1:\${PORT:-4400} (settings from ${DIR}/.env)"
