#!/bin/sh
# Updates and starts RoastBot in edge mode (see docker-compose.edge.yml) on the server.
# Builds images one at a time: parallel builds of six images do not fit into 2 GB of RAM next
# to the other projects. Run from the repository root or anywhere: ./deploy/edge-deploy.sh
#   SKIP_PULL=1  — build the checked-out code without `git pull`.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
ENV_FILE=${ENV_FILE:-deploy/.env}

compose() {
  docker compose --env-file "$ENV_FILE" \
    -f deploy/docker-compose.yml -f deploy/docker-compose.edge.yml "$@"
}

[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE: copy deploy/.env.example and fill it" >&2; exit 1; }
docker network inspect edge >/dev/null 2>&1 ||
  { echo "Docker network 'edge' is missing; it is created by the front proxy stack" >&2; exit 1; }

if [ "${SKIP_PULL:-0}" != 1 ]; then git pull --ff-only; fi

for service in api worker twitch tts web overlay; do
  echo "== build $service"
  compose build "$service"
done

# Creates containers and the labelled volumes without starting anything yet.
compose up --no-start --no-build --remove-orphans

# First run: the Piper voices are not in the image (licence, size). download_models.py checks
# each file against the SHA-256 from the env file and refuses a mismatch.
if ! docker run --rm -v roastbot_models:/models --entrypoint sh localhost/roastbot-tts:edge \
  -c 'ls /models/*.onnx >/dev/null 2>&1'; then
  echo "== download Piper voices"
  docker run --rm --env-file "$ENV_FILE" -u root -v roastbot_models:/models \
    --entrypoint sh localhost/roastbot-tts:edge \
    -c 'python /service/download_models.py && chown -R 10001:10001 /models'
fi

# migrate runs before api/worker/twitch start (depends_on), so the schema is current first.
compose up -d --no-build
compose ps
docker image prune -f >/dev/null
