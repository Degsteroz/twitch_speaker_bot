#!/bin/sh
# Updates and starts RoastBot in edge mode (see docker-compose.edge.yml) on the server.
# By default it pulls the images CI built for the checked-out commit from GHCR: no build on the
# server, a few minutes and little RAM. Run from the repository root or anywhere:
#   ./deploy/edge-deploy.sh
#   SKIP_PULL=1  — use the checked-out code without `git pull`.
#   BUILD=1      — build the images here instead, one at a time: parallel builds of six images
#                  do not fit into 2 GB of RAM next to the other projects.
# Pulling needs a one-time `docker login ghcr.io` with a token that can read packages.
set -eu
# Files written by `git pull` must stay world-readable: the images run as unprivileged users.
umask 022

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

# The images of exactly this commit, so code on disk (Caddy files, compose) and images match.
# The shell value wins over IMAGE_TAG in the env file.
IMAGE_TAG=$(git rev-parse HEAD)
export IMAGE_TAG
TTS_IMAGE=$(compose config --images | grep '/roastbot-tts:')
echo "== release $IMAGE_TAG"

if [ "${BUILD:-0}" = 1 ]; then
  for service in api worker twitch tts web overlay; do
    echo "== build $service"
    compose build "$service"
  done
else
  echo "== pull images"
  if ! compose pull api worker twitch tts web overlay; then
    echo "No images for $IMAGE_TAG in GHCR yet: wait for the CI run of this commit to finish" >&2
    echo "(GitHub → Actions), check \`docker login ghcr.io\` and GHCR_OWNER (lowercase)," >&2
    echo "or build here: BUILD=1 $0" >&2
    exit 1
  fi
  # CI builds for x86_64. On another CPU the containers would fail with "exec format error".
  case "$(uname -m)" in
    x86_64 | amd64) host=amd64 ;;
    aarch64 | arm64) host=arm64 ;;
    *) host=$(uname -m) ;;
  esac
  image=$(docker image inspect -f '{{.Architecture}}' "$TTS_IMAGE")
  if [ "$image" != "$host" ]; then
    echo "The images are $image, this server is $host: build here with BUILD=1 $0" >&2
    exit 1
  fi
fi

# Creates containers and the labelled volumes without starting anything yet.
compose up --no-start --no-build --remove-orphans

# First run: the Piper voices are not in the image (licence, size). download_models.py checks
# each file against the SHA-256 from the env file and refuses a mismatch.
if ! docker run --rm -v roastbot_models:/models --entrypoint sh "$TTS_IMAGE" \
  -c 'ls /models/*.onnx >/dev/null 2>&1'; then
  echo "== download Piper voices"
  docker run --rm --env-file "$ENV_FILE" -u root -v roastbot_models:/models \
    --entrypoint sh "$TTS_IMAGE" \
    -c 'python /service/download_models.py && chown -R 10001:10001 /models'
fi

# migrate runs before api/worker/twitch start (depends_on), so the schema is current first.
compose up -d --no-build
# The Caddy config files are single-file bind mounts. `git pull` replaces them with new files,
# but a container keeps the old ones until it is recreated — a restart is not enough.
compose up -d --no-build --force-recreate caddy
compose ps
# Images are tagged by commit, so old releases are never "dangling" and piled up until the disk
# was full. Remove RoastBot images of other commits; rmi refuses ones a container still uses.
# Other projects' images are left alone.
docker image ls --format '{{.Repository}}:{{.Tag}}' |
  grep '/roastbot-' | grep -v ":$IMAGE_TAG\$" | xargs -r docker rmi >/dev/null 2>&1 || true
docker image prune -f >/dev/null
