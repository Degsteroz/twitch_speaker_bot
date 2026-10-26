#!/bin/sh
# Installs the daily backup pull on this Mac (launchd, 05:30, an hour after the server's backup).
# A Mac asleep at that time runs the job when it wakes up.
#   ./deploy/mac/install-backup-pull.sh user@178.105.174.143
# Remove: launchctl bootout gui/$(id -u)/online.recursia.roastbot-backup
#         rm ~/Library/LaunchAgents/online.recursia.roastbot-backup.plist ~/bin/roastbot-backup-pull.sh
set -eu

HOST=${1:?usage: $0 user@host}
LABEL=online.recursia.roastbot-backup
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="$HOME/bin/roastbot-backup-pull.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/roastbot-backup.log"

echo "== SSH check: $HOST"
ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" true || {
  echo "No key-based SSH to $HOST: run 'ssh-copy-id $HOST' (or add the key) and retry" >&2
  exit 1
}

mkdir -p "$HOME/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$SCRIPT_DIR/roastbot-backup-pull.sh" "$BIN"
chmod 700 "$BIN"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>ROASTBOT_BACKUP_HOST</key><string>$HOST</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "== first pull"
launchctl kickstart "gui/$(id -u)/$LABEL"
sleep 5
tail -5 "$LOG"
echo "Installed: daily at 05:30, log $LOG"
