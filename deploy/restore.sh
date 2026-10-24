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

compose() {
  if [ -n "$EDGE_FILE" ]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$EDGE_FILE" "$@"
  else
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  fi
}

admin_sql() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -q \
    --username "$POSTGRES_USER" --dbname postgres -c "$1"
}

STAGING_DB="${POSTGRES_DB}_restore"
PREVIOUS_DB="${POSTGRES_DB}_previous"

compose exec -T postgres pg_restore --list <"$archive" >/dev/null
compose stop api worker twitch

restart_services() {
  compose up -d --no-build api worker twitch
}
trap restart_services EXIT HUP INT TERM

# Restore into a separate database first. `pg_restore --clean` over the live one is not an option:
# it cannot drop pg-boss's partitioned tables and stops halfway, leaving a gutted schema. Until
# the swap below the live database is untouched, so any failure here loses nothing.
admin_sql "drop database if exists \"$STAGING_DB\""
admin_sql "create database \"$STAGING_DB\""
compose exec -T postgres pg_restore \
  --username "$POSTGRES_USER" --dbname "$STAGING_DB" \
  --no-owner --no-acl --exit-on-error <"$archive"

# Swap: the current database is kept as <db>_previous until the next restore replaces it.
admin_sql "select pg_terminate_backend(pid) from pg_stat_activity
  where datname in ('$POSTGRES_DB', '$STAGING_DB') and pid <> pg_backend_pid()"
admin_sql "drop database if exists \"$PREVIOUS_DB\""
admin_sql "alter database \"$POSTGRES_DB\" rename to \"$PREVIOUS_DB\""
admin_sql "alter database \"$STAGING_DB\" rename to \"$POSTGRES_DB\""

trap - EXIT HUP INT TERM
restart_services
echo "Restore completed: $archive (previous database kept as $PREVIOUS_DB)"
