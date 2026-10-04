#!/bin/sh
# Rehearse the literal published pull/down/up path against owned synthetic data.
set +x
set -eu
cd "$(dirname "$0")/../.."
: "${ELSE_TEST_DISTRIBUTION_IMAGE:?Supply a verified published image reference}"
task_directory=$(mktemp -d)
task_project="else-pull-$(openssl rand -hex 6)"
APP_PORT=0
ELSE_IMAGE=$ELSE_TEST_DISTRIBUTION_IMAGE
ELSE_DATA_VOLUME="${task_project}_data"
export APP_PORT ELSE_IMAGE ELSE_DATA_VOLUME
cp docker-compose.yml .env.example "$task_directory/"
cp "$task_directory/.env.example" "$task_directory/.env"
compose() { docker compose --project-name "$task_project" --project-directory "$task_directory" --file "$task_directory/docker-compose.yml" "$@"; }
cleanup() {
  task_result=$?
  trap - EXIT INT TERM
  if [ "$task_result" -ne 0 ]; then compose logs --no-color --tail 50 >&2 || true; fi
  compose down --volumes --remove-orphans >/dev/null || task_result=1
  rm -rf "$task_directory"
  exit "$task_result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
compose pull
compose up -d --wait --wait-timeout 180
task_container=$(compose ps --quiet else)
task_image=$(compose images --quiet else)
task_url="http://$(compose port else 8080)"
task_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$task_image")
task_time=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.created"}}' "$task_image")
[ "$task_revision" = "$(git rev-parse HEAD)" ] || { echo 'Published image is not the checked-out revision.' >&2; exit 1; }
python3 backend/scripts/check-release-runtime.py prepare "$task_directory/cookies.json" | compose exec -T else /opt/else/operator psql >/dev/null
python3 backend/scripts/check-release-runtime.py verify "$task_directory/cookies.json" "$task_url" "$task_revision" "$task_time"
python3 backend/scripts/check-container-client.py create "$task_directory/client.json" "$task_directory/cookies.json" "$task_url"
compose down >/dev/null
compose pull
compose up -d --wait --wait-timeout 180
[ "$(compose ps --quiet else)" != "$task_container" ]
python3 backend/scripts/check-container-client.py verify "$task_directory/client.json" "$task_directory/cookies.json" "http://$(compose port else 8080)"
printf '%s\n' 'Published image fresh install and literal down/pull/up persistence verified.'
