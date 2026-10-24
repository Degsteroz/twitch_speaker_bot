#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: ROASTBOT_RESTORE_CONFIRM=restore-production $0 BACKUP.dump" >&2
  exit 2
fi
if [ "${ROASTBOT_RESTORE_CONFIRM:-}" != "restore-production" ]; then
  echo "Refusing destructive restore. Set ROASTBOT_RESTORE_CONFIRM=restore-production." >&2
  exit 2
fi

archive=$1
if [ ! -r "$archive" ] || [ ! -s "$archive" ]; then
  echo "Backup is missing, unreadable, or empty: $archive" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE=${ENV_FILE:-"$SCRIPT_DIR/.env"}
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose exec -T postgres pg_restore --list <"$archive" >/dev/null
compose stop api worker twitch

restart_services() {
  compose up -d api worker twitch
}
trap restart_services EXIT HUP INT TERM

compose exec -T postgres pg_restore \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-acl --exit-on-error <"$archive"

trap - EXIT HUP INT TERM
restart_services
echo "Restore completed: $archive"
