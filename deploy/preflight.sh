#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=${ENV_FILE:-"$SCRIPT_DIR/.env"}
failed=0

ok() { printf 'OK: %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
fail() { printf 'FAIL: %s\n' "$*" >&2; failed=1; }

command -v docker >/dev/null 2>&1 || fail "Docker is not installed"
if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 && ok "Docker daemon is available" || fail "Docker daemon is unavailable"
  docker compose version >/dev/null 2>&1 && ok "Docker Compose v2 is available" || fail "Docker Compose v2 is unavailable"
fi

if [ -r /proc/meminfo ]; then
  available_kb=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
  if [ "${available_kb:-0}" -ge 2097152 ]; then
    ok "At least 2 GiB RAM is available"
  else
    fail "Less than 2 GiB RAM is available"
  fi
else
  warn "Cannot read /proc/meminfo; check free RAM manually"
fi

available_kb=$(df -Pk "$SCRIPT_DIR" | awk 'NR==2 {print $4}')
if [ "${available_kb:-0}" -ge 10485760 ]; then
  ok "At least 10 GiB disk space is available"
else
  fail "Less than 10 GiB disk space is available"
fi

if command -v ss >/dev/null 2>&1; then
  for port in 80 443; do
    if ss -ltnH "sport = :$port" 2>/dev/null | awk 'NF {found=1} END {exit !found}'; then
      warn "TCP port $port is already in use; use the existing proxy setup"
    else
      ok "TCP port $port is free"
    fi
  done
else
  warn "ss is unavailable; check listeners on ports 80 and 443 manually"
fi

if command -v docker >/dev/null 2>&1; then
  proxies=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null |
    awk 'tolower($0) ~ /(caddy|nginx|traefik|haproxy)/')
  if [ -n "$proxies" ]; then
    warn "Existing proxy container(s) detected:"
    printf '%s\n' "$proxies" >&2
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  for service in caddy nginx apache2 httpd traefik; do
    if systemctl is-active --quiet "$service" 2>/dev/null; then
      warn "Existing host proxy is active: $service"
    fi
  done
fi

if [ -f "$ENV_FILE" ]; then
  ok "Deployment env file exists"
else
  warn "No $ENV_FILE yet; copy .env.example and fill it"
fi

exit "$failed"
