#!/bin/sh
# Copies the server's database backups (deploy/backup.sh) to this Mac. Started daily by launchd;
# see install-backup-pull.sh. The Mac pulls over SSH, so the server needs no access to the Mac.
#   ROASTBOT_BACKUP_HOST    user@host of the server (required)
#   ROASTBOT_BACKUP_REMOTE  backup directory on the server, default /opt/roastbot/deploy/backups
#   ROASTBOT_BACKUP_DIR     local directory, default ~/Backups/roastbot
#   ROASTBOT_BACKUP_KEEP    days to keep local copies, default 30
set -eu
umask 077

HOST=${ROASTBOT_BACKUP_HOST:?set ROASTBOT_BACKUP_HOST=user@host}
REMOTE=${ROASTBOT_BACKUP_REMOTE:-/opt/roastbot/deploy/backups}
DEST=${ROASTBOT_BACKUP_DIR:-"$HOME/Backups/roastbot"}
KEEP=${ROASTBOT_BACKUP_KEEP:-30}

notify() {
  osascript -e "display notification \"$1\" with title \"RoastBot backup\"" >/dev/null 2>&1 || true
}

mkdir -p "$DEST"
echo "== $(date '+%Y-%m-%d %H:%M:%S') pull from $HOST"
# BatchMode: a missing key fails at once instead of waiting for a password nobody types.
if ! rsync -a -e "ssh -o BatchMode=yes -o ConnectTimeout=20" \
  --include='roastbot-*.dump' --exclude='*' "$HOST:$REMOTE/" "$DEST/"; then
  notify "Не удалось забрать бэкапы с сервера"
  exit 1
fi

find "$DEST" -type f -name 'roastbot-*.dump' -mtime "+$KEEP" -delete

# The server makes one a night; nothing new for two days means its cron or the pull is broken.
if [ -z "$(find "$DEST" -type f -name 'roastbot-*.dump' -mtime -2)" ]; then
  notify "Свежих бэкапов нет больше двух суток"
  echo "No backup newer than 2 days in $DEST" >&2
  exit 1
fi
ls -t "$DEST"/roastbot-*.dump | head -1
