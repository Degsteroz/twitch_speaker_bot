#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
# Edge mode (docker-compose.edge.yml) is recognised by its fixed Caddy container name.
EDGE_FILE=""
if docker container inspect roastbot-edge >/dev/null 2>&1; then
  EDGE_FILE="$SCRIPT_DIR/docker-compose.edge.yml"
fi
ENV_FILE=${ENV_FILE:-"$SCRIPT_DIR/.env"}

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

BACKUP_DIR=${BACKUP_DIR:-"$SCRIPT_DIR/backups"}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-7}
mkdir -p "$BACKUP_DIR"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$BACKUP_DIR/roastbot-${timestamp}.dump"
temporary="${archive}.tmp"

cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT HUP INT TERM

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ${EDGE_FILE:+-f "$EDGE_FILE"} exec -T postgres \
  pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --format=custom --compress=9 --no-owner --no-acl >"$temporary"

test -s "$temporary"
mv "$temporary" "$archive"
trap - EXIT HUP INT TERM

find "$BACKUP_DIR" -type f -name 'roastbot-*.dump' \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete

if [ -n "${BACKUP_EXTERNAL_HOOK:-}" ]; then
  if [ ! -x "$BACKUP_EXTERNAL_HOOK" ]; then
    echo "BACKUP_EXTERNAL_HOOK is not executable: $BACKUP_EXTERNAL_HOOK" >&2
    exit 1
  fi
  "$BACKUP_EXTERNAL_HOOK" "$archive"
fi

echo "$archive"
